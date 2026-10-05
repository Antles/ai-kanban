import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempRepo } from './helpers.js';

// Planners hear about problems a worker would hit later when they write the task: dangling rule IDs,
// missing context files and scopes reaching into protected paths. Warnings only, and only with repo_path.
let s;
let repo;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'docs/spec.md': '## R-CORE-1\nStreaks count days.\n', 'src/habits.py': 'x', 'golden/help.txt': 'usage' }, 'base');
  await s.director('POST', '/api/projects', {
    key: 'PW',
    repo_path: repo.dir,
    reference_patterns: [{ regex: 'R-[A-Z]+-\\d+', source: 'docs/spec.md' }],
    protected_paths: [{ glob: 'golden/**', unlock_label: 'golden-change' }, { glob: 'vendor/**' }],
  });
  await s.director('POST', '/api/projects', {
    key: 'PN',
    reference_patterns: [{ regex: 'R-[A-Z]+-\\d+', source: 'docs/spec.md' }],
    protected_paths: [{ glob: 'golden/**', unlock_label: 'golden-change' }],
  });
});
after(() => {
  repo.remove();
  return s.close();
});

const DANGLING = "R-EXPORT-1 isn't in docs/spec.md (reference_patterns).";
const MISSING = "Context src/store.py doesn't exist on main (fine if an earlier task creates it; add it to depends_on).";
const SCOPE = 'Scope golden/** is protected (golden/**); only the Director can add "golden-change". Ask when you start.';

test('create_task and create_tasks warn about dangling IDs, missing context and protected scope', async () => {
  const one = await s.call('POST', '/api/tasks', {
    project: 'PW',
    title: 'Export streaks (R-EXPORT-1, R-CORE-1)',
    context: ['src/store.py', 'src/habits.py', 'docs/', 'https://example.com/spec'],
    scope: ['golden/**', 'src/**'],
  });
  assert.equal(one.status, 201, 'warnings never block');
  assert.deepEqual(one.body.warnings, [DANGLING, MISSING, SCOPE]);

  const batch = await s.rpc('create_tasks', {
    tasks: [
      { project: 'PW', title: 'clean', context: ['src/habits.py'], scope: ['src/**'] },
      { project: 'PW', title: 'vendored', scope: ['vendor/lib/**'] },
    ],
  });
  assert.equal(batch[0].warnings, undefined);
  assert.deepEqual(batch[1].warnings, ['Scope vendor/lib/** reaches vendor/**, which no task may change.']);
});

test('update_task warns too, and the unlock label silences the scope warning', async () => {
  const key = (await s.director('POST', '/api/tasks', { project: 'PW', title: 'plain', scope: ['golden/**'] })).body.key;
  const res = await s.call('PATCH', `/api/tasks/${key}`, { description: 'Follow R-EXPORT-1.', context: ['src/store.py'] });
  assert.deepEqual(res.body.warnings, [DANGLING, MISSING, SCOPE]);
  // Fields unrelated to planning don't re-run the checks.
  assert.equal((await s.call('PATCH', `/api/tasks/${key}`, { priority: 'high' })).body.warnings, undefined);
  const unlocked = await s.director('PATCH', `/api/tasks/${key}`, { labels: ['golden-change'] });
  assert.deepEqual(unlocked.body.warnings, [DANGLING, MISSING]);
});

test('briefings list missing_context; a file created later clears it', async () => {
  const key = (await s.director('POST', '/api/tasks', { project: 'PW', title: 'store', status: 'todo', context: ['src/store.py', 'docs/spec.md'] })).body.key;
  const briefing = (await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent')).body;
  assert.deepEqual(briefing.missing_context, ['src/store.py']);
  repo.commit({ 'src/store.py': 'class Store: ...' }, 'add store');
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.missing_context, undefined);
});

test('projects without repo_path get no new warnings', async () => {
  const res = await s.call('POST', '/api/tasks', { project: 'PN', title: 'R-EXPORT-1', context: ['src/store.py'], scope: ['golden/**'] });
  assert.equal(res.status, 201);
  assert.equal(res.body.warnings, undefined);
  assert.equal((await s.call('PATCH', `/api/tasks/${res.body.key}`, { description: 'R-NOPE-2', scope: ['golden/**'] })).body.warnings, undefined);
  assert.equal((await s.call('GET', `/api/tasks/${res.body.key}`)).body.missing_context, undefined);
});
