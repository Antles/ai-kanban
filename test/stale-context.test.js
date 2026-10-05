import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempRepo } from './helpers.js';

let s;
let repo;
let v1;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  v1 = repo.commit(
    { 'docs/combat.md': '# Combat\n\n## Sparks\nC-SPARK-1: a beat yields 3 Sparks.\nC-SPARK-2: Sparks cap at 9.\n', 'docs/economy.md': 'E-GOLD-1\n' },
    'docs v1',
  );
  await s.call('POST', '/api/projects', {
    key: 'SC',
    repo_path: repo.dir,
    reference_patterns: [{ regex: 'C-[A-Z]+-\\d+', source: 'docs/combat.md' }],
  });
});
after(() => {
  repo.remove();
  return s.close();
});

test('the context baseline is recorded on create and kept for unchanged entries on edit', async () => {
  const t = await s.call('POST', '/api/tasks', {
    project: 'SC',
    title: 'Sparks',
    context: ['docs/combat.md#sparks', 'https://example.com/spec', 'docs/missing.md'],
  });
  const row = s.app.kanban.taskRow(t.body.key);
  assert.deepEqual(JSON.parse(row.context_baseline), { 'docs/combat.md': v1 }, 'URLs and unknown paths are skipped');

  const v2 = repo.commit({ 'docs/economy.md': 'E-GOLD-1 changed\n' }, 'economy tweak');
  await s.call('PATCH', `/api/tasks/${t.body.key}`, { context: ['docs/combat.md#sparks', 'docs/economy.md'] });
  const after = JSON.parse(s.app.kanban.taskRow(t.body.key).context_baseline);
  assert.deepEqual(after, { 'docs/combat.md': v1, 'docs/economy.md': v2 }, 'a newly added entry gets today\'s commit');
});

test('briefings list commits since the baseline; Mark re-checked resets it', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'SC', title: 'Spark cap', status: 'todo', context: ['docs/combat.md'] });
  const key = t.body.key;
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.stale_context, undefined, 'fresh task: nothing stale');

  const change = repo.commit({ 'docs/combat.md': '# Combat\n\n## Sparks\nC-SPARK-1: a beat yields 2 Sparks.\nC-SPARK-2: Sparks cap at 9.\n' }, 'Sparks: 3 -> 2');
  repo.commit({ 'docs/economy.md': 'unrelated\n' }, 'economy only');
  const briefing = await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent');
  assert.equal(briefing.body.stale_context.length, 1);
  const stale = briefing.body.stale_context[0];
  assert.equal(stale.path, 'docs/combat.md');
  assert.deepEqual(stale.commits_since.map((c) => [c.sha, c.subject]), [[change, 'Sparks: 3 -> 2']]);
  assert.ok(stale.commits_since[0].date);

  const rechecked = await s.call('POST', `/api/tasks/${key}/context/recheck`, {}, 'agent');
  assert.equal(rechecked.status, 200);
  assert.equal(rechecked.body.stale_context, undefined);
  assert.equal(JSON.parse(s.app.kanban.taskRow(key).context_baseline)['docs/combat.md'], change);
  const log = (await s.call('GET', `/api/tasks/${key}`)).body.activity[0];
  assert.equal(log.action, 'context_rechecked');
});

test('rule IDs resolve to their line in the source doc; removed ones are dangling', async () => {
  const t = await s.call('POST', '/api/tasks', {
    project: 'SC',
    title: 'Implement C-SPARK-1',
    description: 'Follow C-SPARK-2 and C-SPARK-9. Not C-SPARK-10x.',
    criteria: ['C-SPARK-1 has a test'],
  });
  const detail = (await s.call('GET', `/api/tasks/${t.body.key}`)).body;
  assert.deepEqual(detail.references.map((r) => [r.id, r.source, r.line]), [
    ['C-SPARK-1', 'docs/combat.md', 4],
    ['C-SPARK-2', 'docs/combat.md', 5],
  ]);
  assert.match(detail.references[0].excerpt, /a beat yields 2 Sparks/);
  assert.deepEqual(detail.dangling_references.map((r) => r.id), ['C-SPARK-9', 'C-SPARK-10']);

  // Removing an ID from the doc makes it dangle.
  repo.commit({ 'docs/combat.md': '# Combat\nC-SPARK-1 only now.\n' }, 'drop C-SPARK-2');
  const later = (await s.call('GET', `/api/tasks/${t.body.key}`)).body;
  assert.ok(later.dangling_references.some((r) => r.id === 'C-SPARK-2'));
  const briefing = await s.rpc('claim_task', { task: t.body.key });
  assert.ok(briefing.dangling_references.some((r) => r.id === 'C-SPARK-2'), 'the briefing carries it too');

  // The UI links IDs to the doc through a read-only file endpoint.
  const file = await s.call('GET', '/api/projects/SC/repo/file?path=docs/combat.md');
  assert.equal(file.status, 200);
  assert.match(file.body, /C-SPARK-1 only now/);
  assert.equal((await s.call('GET', '/api/projects/SC/repo/file?path=nope.md')).status, 404);
  assert.equal((await s.call('GET', '/api/projects/SC/repo/file?path=--output=x')).status, 400);
});

test('bad patterns are rejected; projects without repo_path show none of this', async () => {
  assert.equal((await s.director('PATCH', '/api/projects/SC', { reference_patterns: [{ regex: '(', source: 'docs/x.md' }] })).status, 400);
  await s.call('POST', '/api/projects', { key: 'SN', reference_patterns: [{ regex: 'C-\\d+', source: 'docs/x.md' }] });
  const t = await s.call('POST', '/api/tasks', { project: 'SN', title: 'C-1', context: ['docs/x.md'] });
  const d = (await s.call('GET', `/api/tasks/${t.body.key}`)).body;
  assert.equal(d.stale_context, undefined);
  assert.equal(d.references, undefined);
  assert.equal((await s.call('POST', `/api/tasks/${t.body.key}/context/recheck`, {})).status, 400);
  const viaMcp = await s.rpc('recheck_context', { task: t.body.key });
  assert.match(viaMcp.error, /no repo_path/);
});

test('reference patterns with nested quantifiers are refused', async () => {
  const res = await s.director('PATCH', '/api/projects/SC', { reference_patterns: [{ regex: '(a+)+$', source: 'docs/combat.md' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nested quantifier/);
});

test('a catastrophic pattern costs at most the time budget and never stalls other requests', async () => {
  await s.call('POST', '/api/projects', {
    key: 'SR',
    repo_path: repo.dir,
    reference_patterns: [{ regex: 'C-[A-Z]+-\\d+', source: 'docs/combat.md' }],
  });
  const t = await s.call('POST', '/api/tasks', { project: 'SR', title: 'C-SPARK-1', description: `${'a'.repeat(40)}!` });
  for (const regex of ['((a+))+$', '(a|a)*$', '(?:(a+))*$']) {
    const set = await s.director('PATCH', '/api/projects/SR', { reference_patterns: [{ regex, source: 'docs/combat.md' }] });
    assert.equal(set.status, 200, `${regex} gets past the syntax guard; the worker is what protects the board`);
    const started = Date.now();
    const pending = s.call('GET', `/api/tasks/${t.body.key}`);
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    const other = await s.call('GET', '/api/projects');
    assert.ok(Date.now() - t0 < 150, `an unrelated request waited ${Date.now() - t0} ms on ${regex}`);
    assert.equal(other.status, 200);
    const detail = await pending;
    assert.ok(Date.now() - started < 2000, `${regex} finished in ${Date.now() - started} ms`);
    assert.match(detail.body.reference_error, /took longer than \d+ ms and was skipped/);
  }
  // A good pattern after a killed worker still works.
  await s.director('PATCH', '/api/projects/SR', { reference_patterns: [{ regex: 'C-[A-Z]+-\\d+', source: 'docs/combat.md' }] });
  const ok = (await s.call('GET', `/api/tasks/${t.body.key}`)).body;
  assert.equal(ok.reference_error, undefined);
  assert.deepEqual(ok.references.map((r) => r.id), ['C-SPARK-1']);
});

test('repo_path must be the top of the repository', async () => {
  const res = await s.call('POST', '/api/projects', { key: 'SD', repo_path: `${repo.dir}/docs` });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /top of the repository/);
});

test('a baseline commit that no longer exists is reported, not hidden', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'SC', title: 'gone', context: ['docs/combat.md'] });
  s.app.kanban.db.prepare('UPDATE tasks SET context_baseline = ? WHERE id = ?').run(
    JSON.stringify({ 'docs/combat.md': 'f'.repeat(40) }),
    s.app.kanban.taskRow(t.body.key).id,
  );
  const d = (await s.call('GET', `/api/tasks/${t.body.key}`)).body;
  assert.equal(d.stale_context.length, 1);
  assert.equal(d.stale_context[0].baseline_missing, 'f'.repeat(40));
  assert.deepEqual(d.stale_context[0].commits_since, []);
});
