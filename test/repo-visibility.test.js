import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, tempRepo } from './helpers.js';

// In Docker the board only sees the KANBAN_REPOS mount, so a repo_path outside it looks missing.
// The 400 says so. (Each test file runs in its own process, so setting the variable here is safe.)
let s;
let repo;
let root;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'README.md': 'x' }, 'base');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-mount-'));
});
after(() => {
  delete process.env.KANBAN_REPOS;
  repo.remove();
  fs.rmSync(root, { recursive: true, force: true });
  return s.close();
});

test('with KANBAN_REPOS set, a repo_path outside it is a 400 naming the visible folder and the fix', async () => {
  process.env.KANBAN_REPOS = `${root}/`;
  const outside = '/Users/someone/elsewhere/repo';
  const res = await s.director('POST', '/api/projects', { key: 'RV', repo_path: outside });
  assert.equal(res.status, 400);
  assert.equal(
    res.body.error,
    `repo_path ${outside} isn't visible to the board server (it runs in a container that sees ${root}). Move the repo under it, or point KANBAN_REPOS at a folder that contains it.`,
  );
  // Inside the mount but really missing: the plain message.
  const inside = await s.director('POST', '/api/projects', { key: 'RV', repo_path: `${root}/nope` });
  assert.equal(inside.body.error, `repo_path does not exist: ${root}/nope`);
  // The settings screen's check says the same.
  await s.director('POST', '/api/projects', { key: 'RW' });
  const check = await s.director('GET', `/api/projects/RW/repo?path=${encodeURIComponent(outside)}`);
  assert.match(check.body.error, /isn't visible to the board server/);
});

test("without KANBAN_REPOS (no Docker), today's message is kept; visible repos still work", async () => {
  delete process.env.KANBAN_REPOS;
  const res = await s.director('POST', '/api/projects', { key: 'RX', repo_path: '/Users/someone/elsewhere/repo' });
  assert.equal(res.body.error, 'repo_path does not exist: /Users/someone/elsewhere/repo');
  process.env.KANBAN_REPOS = path.dirname(repo.dir);
  assert.equal((await s.director('POST', '/api/projects', { key: 'RY', repo_path: repo.dir })).status, 201);
});
