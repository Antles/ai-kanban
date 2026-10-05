import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitReader } from '../src/git.js';
import { startServer, tempRepo } from './helpers.js';

let s;
let repo;
let first;
let second;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  first = repo.commit({ 'docs/combat.md': '# Combat\nC-SPARK-1\n', 'sim/a.cs': 'a' }, 'initial');
  repo.git('checkout', '-q', '-b', 'feat/x');
  second = repo.commit({ 'sim/a.cs': 'b', 'sim/b.cs': 'new' }, 'feature work');
  repo.git('checkout', '-q', 'main');
});
after(() => {
  repo.remove();
  return s.close();
});

test('the reader answers read-only queries against a temp repo', async () => {
  const git = new GitReader(repo.dir);
  assert.equal(fs.realpathSync(await git.validate()), fs.realpathSync(repo.dir));
  assert.equal(await git.resolve(second.slice(0, 8)), second);
  assert.equal(await git.resolve('deadbeef'), null);
  assert.equal(await git.resolve('--help'), null, 'refs that look like options are refused');
  assert.equal(await git.hasBranch('feat/x'), true);
  assert.equal(await git.hasBranch('nope'), false);
  assert.equal(await git.baseRef(), 'main');
  assert.equal(await git.baseRef('feat/x'), 'feat/x');
  assert.equal(await git.mergeBase('main', 'feat/x'), first);
  assert.deepEqual(await git.changedFiles(first, second), ['sim/a.cs', 'sim/b.cs']);
  assert.equal(await git.lastCommit('docs/combat.md'), first);
  assert.equal(await git.lastCommit('missing.md'), null);
  assert.deepEqual((await git.commitsSince(first, 'sim/a.cs', 'feat/x')).map((c) => [c.sha, c.subject]), [[second, 'feature work']]);
  assert.match(await git.showFile('main', 'docs/combat.md'), /C-SPARK-1/);
  assert.equal((await git.head()).sha, first);
});

test('only query subcommands, no writing options, and every call has a timeout', async () => {
  const git = new GitReader(repo.dir);
  for (const cmd of ['commit', 'checkout', 'push', 'reset', 'config', 'gc', 'fetch']) {
    await assert.rejects(git.run(cmd), /not allowed/, cmd);
  }
  await assert.rejects(git.run('diff'), /only allowed with --name-only/);
  await assert.rejects(git.run('log', '--output=/tmp/x'), /not allowed/);
  await assert.rejects(git.run('diff', '--name-only', '--ext-diff'), /not allowed/);
  await assert.rejects(git.tryRun('log', '--output=/tmp/x'), /not allowed/, 'tryRun never hides a refusal');
  // Reading leaves the repo untouched: no index lock, same status.
  const status = repo.git('status', '--porcelain');
  await git.changedFiles(first, second);
  assert.equal(repo.git('status', '--porcelain'), status);
  assert.equal(fs.existsSync(path.join(repo.dir, '.git', 'index.lock')), false);
  // A 1 ms budget can't be met: the call is killed and reported as a timeout.
  await assert.rejects(new GitReader(repo.dir, { timeout: 1 }).run('log'), /timed out|failed/);
});

test('repo_path is validated when set; projects without it are unaffected', async () => {
  await s.call('POST', '/api/projects', { key: 'GT' });
  const plain = await s.call('GET', '/api/projects/GT');
  assert.equal(plain.body.repo_path, null);
  assert.deepEqual((await s.call('GET', '/api/projects/GT/repo')).body, { repo_path: null, ok: false, error: 'No repo_path set' });

  const notDir = await s.director('PATCH', '/api/projects/GT', { repo_path: '/definitely/not/here' });
  assert.equal(notDir.status, 400);
  assert.match(notDir.body.error, /does not exist/);
  assert.match((await s.director('PATCH', '/api/projects/GT', { repo_path: 'relative/path' })).body.error, /absolute/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
  const notRepo = await s.director('PATCH', '/api/projects/GT', { repo_path: empty });
  assert.match(notRepo.body.error, /not a git repository/);
  fs.rmSync(empty, { recursive: true });

  const ok = await s.director('PATCH', '/api/projects/GT', { repo_path: `${repo.dir}/`, base_branch: 'main' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.repo_path, repo.dir, 'trailing slash trimmed');
  const status = await s.call('GET', '/api/projects/GT/repo');
  assert.equal(status.body.ok, true);
  assert.equal(status.body.base, 'main');
  assert.equal(status.body.head.sha, first);
  // The settings UI can check a path before saving it.
  assert.equal((await s.director('GET', `/api/projects/GT/repo?path=${encodeURIComponent('/nope')}`)).body.ok, false);
  assert.equal((await s.call('GET', `/api/projects/GT/repo?path=${encodeURIComponent('/etc')}`)).status, 403, 'agents cannot probe paths');

  assert.equal((await s.director('PATCH', '/api/projects/GT', { repo_path: null })).body.repo_path, null);
  assert.match((await s.director('PATCH', '/api/projects/GT', { base_branch: 'bad name;' })).body.error, /branch name/);
});
