import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// Small follow-ups from the Tier 1-3 review (KB-22).
let s;
before(async () => {
  s = await startServer();
  await s.director('POST', '/api/projects', { key: 'FU' });
});
after(() => s.close());

const create = async (fields) => (await s.director('POST', '/api/tasks', { project: 'FU', title: 't', status: 'todo', ...fields })).body;

test('upstream leaves out a review from an earlier round than the current handoff', async () => {
  const dep = await create({ title: 'rules' });
  const t = await create({ title: 'ui', depends_on: [dep.key] });
  await s.call('POST', `/api/tasks/${dep.key}/claim`, {}, 'agent');
  await s.call('POST', `/api/tasks/${dep.key}/submit`, { summary: 'first try' }, 'agent');
  await s.director('POST', `/api/tasks/${dep.key}/review`, { verdict: 'changes', feedback: 'wrong rule' });
  let up = (await s.call('GET', `/api/tasks/${t.key}`)).body.upstream[0];
  assert.equal(up.review.verdict, 'changes_requested', 'the rejection belongs to the current handoff');

  await new Promise((r) => setTimeout(r, 5));
  await s.call('POST', `/api/tasks/${dep.key}/submit`, { summary: 'second try' }, 'agent');
  up = (await s.call('GET', `/api/tasks/${t.key}`)).body.upstream[0];
  assert.equal(up.summary, 'second try');
  assert.equal(up.review, null, 'the old rejection is not shown next to the new summary');

  await s.director('POST', `/api/tasks/${dep.key}/review`, { verdict: 'accept' });
  up = (await s.call('GET', `/api/tasks/${t.key}`)).body.upstream[0];
  assert.equal(up.review.verdict, 'accepted');
});

test('submitting clears the checkpoint; a checkpoint comment bumps updated_at; an empty release checkpoint clears it', async () => {
  const t = await create();
  await s.call('POST', `/api/tasks/${t.key}/claim`, {}, 'agent');
  const before = (await s.call('GET', `/api/tasks/${t.key}`)).body.updated_at;
  await new Promise((r) => setTimeout(r, 5));
  await s.call('POST', `/api/tasks/${t.key}/comments`, { body: 'Parser done. Next: CLI.', checkpoint: true }, 'agent');
  const noted = (await s.call('GET', `/api/tasks/${t.key}`)).body;
  assert.equal(noted.checkpoint.body, 'Parser done. Next: CLI.');
  assert.ok(noted.updated_at > before);

  const submitted = await s.call('POST', `/api/tasks/${t.key}/submit`, { summary: 'done' }, 'agent');
  assert.equal(submitted.body.checkpoint, null);
  await s.director('POST', `/api/tasks/${t.key}/review`, { verdict: 'changes', feedback: 'again' });
  const rework = await s.call('POST', `/api/tasks/${t.key}/claim`, {}, 'agent');
  assert.equal(rework.body.checkpoint, null, 'the rework briefing has no stale resume note');

  await s.call('POST', `/api/tasks/${t.key}/release`, { checkpoint: 'halfway' }, 'agent');
  await s.call('POST', `/api/tasks/${t.key}/claim`, {}, 'agent');
  const cleared = await s.call('POST', `/api/tasks/${t.key}/release`, { checkpoint: '' }, 'agent');
  assert.equal(cleared.body.checkpoint, null);
  await s.call('POST', `/api/tasks/${t.key}/claim`, {}, 'agent');
  await s.call('POST', `/api/tasks/${t.key}/release`, { checkpoint: 'again' }, 'agent');
  await s.call('POST', `/api/tasks/${t.key}/claim`, {}, 'agent');
  const kept = await s.call('POST', `/api/tasks/${t.key}/release`, {}, 'agent');
  assert.equal(kept.body.checkpoint.body, 'again', 'no checkpoint keeps the note');
});

test('the missing-fields filter includes tasks whose estimate is no longer allowed', async () => {
  const t = await create({ estimate: 4 });
  const ok = await create({ estimate: 3 });
  await s.director('PATCH', '/api/projects/FU', { allowed_estimates: [1, 2, 3, 5, 8] });
  const detail = (await s.call('GET', `/api/tasks/${t.key}`)).body;
  assert.deepEqual(detail.missing_fields, ['estimate']);
  assert.equal((await s.call('GET', `/api/tasks/${ok.key}`)).body.missing_fields, undefined);
  const filtered = (await s.call('GET', '/api/tasks?project=FU&missing_fields=true')).body.map((x) => x.key);
  assert.ok(filtered.includes(t.key));
  assert.ok(!filtered.includes(ok.key));
  await s.director('PATCH', '/api/projects/FU', { allowed_estimates: [] });
});

test('any failed check in a handoff is a warning, configured or not', async () => {
  await s.director('PATCH', '/api/projects/FU', { checks: [{ name: 'tests', command: 'npm test', required: true }, { name: 'bench', command: 'npm run bench' }] });
  const t = await create();
  await s.call('POST', `/api/tasks/${t.key}/claim`, {}, 'agent');
  const res = await s.call(
    'POST',
    `/api/tasks/${t.key}/submit`,
    {
      summary: 'x',
      checks: [
        { name: 'tests', passed: false },
        { name: 'bench', passed: false },
        { name: 'lint', passed: false },
        { name: 'types', passed: true },
      ],
    },
    'agent',
  );
  assert.deepEqual(res.body.warnings, ['Check "tests" (required) failed.', 'Check "bench" failed.', 'Check "lint" failed.']);
  await s.director('PATCH', '/api/projects/FU', { checks: null });
});

test('export.md lists subtasks under their parent', async () => {
  await s.director('POST', '/api/projects', { key: 'EX' });
  const epic = (await s.director('POST', '/api/projects/EX/epics', { title: 'Combat' })).body;
  const parent = (await s.director('POST', '/api/tasks', { project: 'EX', title: 'Spark system', epic: epic.key })).body;
  const loose = (await s.director('POST', '/api/tasks', { project: 'EX', title: 'Loose task' })).body;
  const sub = (await s.director('POST', '/api/tasks', { project: 'EX', title: 'Spark UI', parent: parent.key, epic: null })).body;
  assert.equal(sub.epic, null, 'a subtask outside its parent\'s epic');
  const md = (await s.call('GET', '/api/projects/EX/export.md')).body;
  const at = (text) => md.indexOf(text);
  assert.ok(at(`### ${parent.key} · Spark system`) < at(`### ${sub.key} · Spark UI`));
  assert.ok(at(`### ${sub.key} · Spark UI`) < at('## Not in an epic'), 'listed with its parent, in the Combat section');
  assert.match(md, new RegExp(`### ${sub.key} · Spark UI\\n\\n.*\\n- \\*\\*Parent:\\*\\* ${parent.key}`));
  assert.equal(md.split(`### ${sub.key}`).length, 2, 'listed once');
  assert.ok(at(`### ${loose.key}`) > at('## Not in an epic'));
});
