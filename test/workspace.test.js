import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempRepo } from './helpers.js';

// Briefings say where to work (the checkout, its base branch and head) and what not to touch.
let s;
let repo;
let head;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  head = repo.commit({ 'README.md': 'hi', 'golden/help.txt': 'usage' }, 'base');
  await s.director('POST', '/api/projects', {
    key: 'WS',
    repo_path: repo.dir,
    protected_paths: [{ glob: 'golden/**', unlock_label: 'golden-change' }, { glob: 'vendor/**' }],
  });
  await s.director('POST', '/api/projects', { key: 'WN' });
});
after(() => {
  repo.remove();
  return s.close();
});

test('with repo_path, briefings and get_task carry repo {path, base_branch, head} and protected_paths', async () => {
  const key = (await s.director('POST', '/api/tasks', { project: 'WS', title: 'fix help', status: 'todo' })).body.key;
  const briefing = (await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent')).body;
  assert.deepEqual(briefing.repo, { path: repo.dir, base_branch: 'main', head: head.slice(0, 10) });
  assert.deepEqual(briefing.protected_paths, [
    { glob: 'golden/**', unlock_label: 'golden-change', unlocked: false },
    { glob: 'vendor/**', unlocked: false },
  ]);
  const detail = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.deepEqual(detail.repo, briefing.repo);
  assert.deepEqual(detail.protected_paths, briefing.protected_paths);
  const viaMcp = await s.rpc('get_task', { task: key });
  assert.equal(viaMcp.repo.path, repo.dir);

  // A new commit on main moves head; the task's label unlocks its rule.
  const next = repo.commit({ 'README.md': 'hello' }, 'more');
  const labeled = (await s.director('POST', '/api/tasks', { project: 'WS', title: 'regen golden', status: 'todo', labels: ['golden-change'] })).body.key;
  const b2 = await s.rpc('claim_task', { task: labeled });
  assert.equal(b2.repo.head, next.slice(0, 10));
  assert.deepEqual(b2.protected_paths.map((p) => p.unlocked), [true, false]);
});

test('without repo_path or protected paths, neither field appears', async () => {
  const key = (await s.director('POST', '/api/tasks', { project: 'WN', title: 't', status: 'todo' })).body.key;
  const briefing = (await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent')).body;
  assert.equal(briefing.repo, undefined);
  assert.equal(briefing.protected_paths, undefined);
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.repo, undefined);
  // Protected paths without a repo still show (the rules also check listed files).
  await s.director('PATCH', '/api/projects/WN', { protected_paths: ['docs/vision.md'] });
  const again = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(again.repo, undefined);
  assert.deepEqual(again.protected_paths, [{ glob: 'docs/vision.md', unlocked: false }]);
});
