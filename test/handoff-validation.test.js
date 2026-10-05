import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempRepo } from './helpers.js';

let s;
let repo;
let work;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'sim/Core/Rules.cs': 'v1', 'sim/Core/Golden/e01.json': '{}', 'docs/vision.md': 'v' }, 'base');
  repo.git('checkout', '-q', '-b', 'feat/rules');
  work = repo.commit({ 'sim/Core/Rules.cs': 'v2', 'sim/Core/Golden/e01.json': '{"h":1}', 'unity/Foo.cs': 'x' }, 'rules');
  repo.git('checkout', '-q', 'main');
  repo.commit({ 'README.md': 'later on main' }, 'unrelated main commit');
  await s.call('POST', '/api/projects', {
    key: 'HV',
    repo_path: repo.dir,
    protected_paths: [{ glob: 'sim/**/Golden/**', unlock_label: 'golden-change' }, 'docs/vision.md'],
  });
});
after(() => {
  repo.remove();
  return s.close();
});

// The Director writes the tasks: unlock labels and scope are theirs to set.
const task = async (fields = {}) => (await s.director('POST', '/api/tasks', { project: 'HV', title: 't', status: 'in_progress', assignee: 'agent', ...fields })).body.key;
const submit = (key, body) => s.call('POST', `/api/tasks/${key}/submit`, { summary: 'done', ...body }, 'agent');

test("a commit the repo doesn't have is a 409: the task stays in progress and no handoff is saved", async () => {
  const key = await task();
  const res = await submit(key, { commit: 'deadbeefcafe', branch: 'feat/missing' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, `Commit deadbeefcafe doesn't exist in the project repo. Commit your work, or fix the SHA. ${key} stays in progress.`);
  const after = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(after.status, 'in_progress');
  assert.equal(after.handoff, null);
  assert.ok(!after.activity.some((a) => a.action === 'submitted'));
  assert.match((await s.rpc('submit_for_review', { task: key, summary: 'x', commit: 'deadbeef', agent: 'agent' })).error, /^Error \(409\): Commit deadbeef doesn't exist/);
});

test('with no commit, a branch the repo lacks is the same 409; with a real commit it stays a warning', async () => {
  const key = await task();
  const res = await submit(key, { branch: 'feat/missing' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, new RegExp(`^Branch "feat/missing" doesn't exist in the project repo\\..*${key} stays in progress\\.$`));
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.handoff, null);
  const ok = await submit(key, { commit: work, branch: 'feat/missing' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.warnings.some((w) => /Branch "feat\/missing" doesn't exist/.test(w)));
  // A branch the repo has is enough on its own.
  assert.equal((await submit(await task({ labels: ['golden-change'] }), { branch: 'feat/rules' })).status, 200);
});

test('files come from the diff against the merge base when omitted, and are compared when given', async () => {
  const derived = await submit(await task({ labels: ['golden-change'] }), { commit: work.slice(0, 10) });
  assert.deepEqual(derived.body.handoff.files, ['sim/Core/Golden/e01.json', 'sim/Core/Rules.cs', 'unity/Foo.cs']);
  assert.equal(derived.body.handoff.files_derived, true);
  assert.equal(derived.body.handoff.diff_base.ref, 'main');
  assert.equal(derived.body.warnings, undefined, 'README.md on main after the fork is not part of the diff');

  // By branch name too; a mismatched list is reported both ways.
  const compared = await submit(await task({ labels: ['golden-change'] }), {
    branch: 'feat/rules',
    files: ['sim/Core/Rules.cs', 'sim/Core/Golden/e01.json', 'docs/extra.md'],
  });
  assert.deepEqual(compared.body.warnings, [
    'Changed since main but missing from files: unity/Foo.cs.',
    'Listed in files but not changed since main: docs/extra.md.',
  ]);
  assert.equal(compared.body.handoff.files_derived, undefined);
});

test('work already merged into the base is diffed against its own parent', async () => {
  const merged = repo.commit({ 'docs/vision.md': 'v2' }, 'on main');
  const res = await submit(await task(), { commit: merged });
  assert.deepEqual(res.body.handoff.files, ['docs/vision.md']);
  assert.equal(res.body.handoff.diff_base.sha, repo.git('rev-parse', `${merged}^`));
});

test('protected paths are flagged unless the task has the unlocking label', async () => {
  const locked = await submit(await task(), { commit: work });
  const v = locked.body.handoff.violations;
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'protected_path');
  assert.deepEqual(v[0].files, ['sim/Core/Golden/e01.json']);
  assert.match(locked.body.warnings.at(-1), /Protected path sim\/\*\*\/Golden\/\*\* touched.*labeled "golden-change"/);
  assert.match(v[0].message, /may change it\. Revert it, or ask_director for the "golden-change" label \(only the Director can add it\)\.$/);

  const unlocked = await submit(await task({ labels: ['golden-change'] }), { commit: work });
  assert.equal(unlocked.body.handoff.violations, undefined);

  // A rule without a label protects the path from every task; rules work without git too.
  const vision = await submit(await task({ labels: ['golden-change'] }), { files: ['docs/vision.md'] });
  assert.match(vision.body.warnings[0], /Protected path docs\/vision\.md touched.*No task may change it\. Revert it\.$/);
});

test('path rules cover changed files the agent left out of its list', async () => {
  const key = await task({ scope: ['sim/Core/Rules.cs'] });
  const res = await submit(key, { commit: work, files: ['sim/Core/Rules.cs'] });
  const v = res.body.handoff.violations;
  assert.deepEqual(v.map((x) => [x.kind, x.files]), [
    ['protected_path', ['sim/Core/Golden/e01.json']],
    ['out_of_scope', ['sim/Core/Golden/e01.json', 'unity/Foo.cs']],
  ]);
  assert.deepEqual(res.body.handoff.files, ['sim/Core/Rules.cs'], 'the listed files are kept as given');
  assert.ok(res.body.warnings.some((w) => /Protected path sim\/\*\*\/Golden\/\*\* touched: sim\/Core\/Golden\/e01\.json/.test(w)));
});

test('files outside the task scope are flagged', async () => {
  const key = await task({ labels: ['golden-change'], scope: ['sim/**', 'docs/combat.md'] });
  assert.deepEqual((await s.call('GET', `/api/tasks/${key}`)).body.scope, ['sim/**', 'docs/combat.md']);
  const res = await submit(key, { commit: work });
  assert.deepEqual(res.body.handoff.violations.map((v) => [v.kind, v.files]), [['out_of_scope', ['unity/Foo.cs']]]);
  assert.match(res.body.warnings[0], /Outside the task's scope \(sim\/\*\*, docs\/combat\.md\): unity\/Foo\.cs\. Revert it, or widen the scope with update_task and say why\.$/);

  const inScope = await s.director('PATCH', `/api/tasks/${key}`, { scope: ['sim/**', 'unity/'] });
  assert.deepEqual(inScope.body.scope, ['sim/**', 'unity/']);
  const again = await submit(key, { commit: work });
  assert.equal(again.body.warnings, undefined);
});

test('projects without repo_path or rules behave as before; MCP carries scope', async () => {
  await s.call('POST', '/api/projects', { key: 'HN' });
  const t = await s.director('POST', '/api/tasks', { project: 'HN', title: 't', status: 'in_progress', assignee: 'agent' });
  const res = await s.call('POST', `/api/tasks/${t.body.key}/submit`, { summary: 'x', commit: 'nope', files: ['anything.cs'] }, 'agent');
  assert.equal(res.body.warnings, undefined);
  assert.deepEqual(res.body.handoff.files, ['anything.cs']);
  const viaMcp = await s.rpc('create_task', { project: 'HV', title: 'scoped', scope: ['sim/**'], verbose: true });
  assert.deepEqual(viaMcp.scope, ['sim/**']);
  await s.rpc('claim_task', { task: viaMcp.key });
  const sub = await s.rpc('submit_for_review', { task: viaMcp.key, summary: 'x', files: ['unity/Foo.cs'] });
  assert.match(sub.violations.join('\n'), /Outside the task's scope/);
  assert.equal(sub.warnings, undefined, 'compact results state each message once');
});
