import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitReader } from '../src/git.js';
import { startServer, tempRepo } from './helpers.js';

// git behind a wrapper that logs every call and can be made slow.
let s;
let repo;
let dir;
let log;
let key;
let merged;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-git-wrapper-'));
  log = path.join(dir, 'calls.log');
  const wrapper = path.join(dir, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> "${log}"\nif [ -f "${dir}/slow" ]; then sleep 0.3; fi\nexec git "$@"\n`, { mode: 0o755 });
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'docs/combat.md': 'C-SPARK-1\n', 'docs/economy.md': 'x' }, 'docs');
  merged = repo.commit({ 'docs/combat.md': 'C-SPARK-1 v2\n' }, 'combat tweak');
  await s.director('POST', '/api/projects', {
    key: 'GA',
    repo_path: repo.dir,
    reference_patterns: [{ regex: 'C-[A-Z]+-\\d+', source: 'docs/combat.md' }],
  });
  key = (await s.director('POST', '/api/tasks', { project: 'GA', title: 'C-SPARK-1', status: 'todo', context: ['docs/combat.md', 'docs/economy.md'] })).body.key;
  GitReader.binary = wrapper;
});
after(() => {
  GitReader.binary = 'git';
  repo.remove();
  fs.rmSync(dir, { recursive: true, force: true });
  return s.close();
});

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

test('a slow git call does not delay unrelated requests', async () => {
  fs.writeFileSync(path.join(dir, 'slow'), '');
  try {
    const started = Date.now();
    const slow = s.call('GET', `/api/tasks/${key}`).then((r) => ({ r, ms: Date.now() - started }));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const fast = await s.call('GET', '/api/projects');
    const fastMs = Date.now() - t0;
    assert.equal(fast.status, 200);
    assert.ok(fastMs < 250, `an unrelated request took ${fastMs} ms while git slept`);
    const { r, ms } = await slow;
    assert.equal(r.status, 200);
    assert.ok(ms >= 300, `the git-backed request did wait for git (${ms} ms)`);
    assert.deepEqual(r.body.references.map((x) => x.id), ['C-SPARK-1']);
  } finally {
    fs.rmSync(path.join(dir, 'slow'));
  }
});

test('repeated identical queries within one request run git once', async () => {
  fs.rmSync(log, { force: true });
  await s.call('GET', `/api/tasks/${key}`);
  const briefing = calls();
  assert.ok(briefing.length > 0);
  assert.equal(new Set(briefing).size, briefing.length, `duplicates in:\n${briefing.join('\n')}`);

  // Submitting work already on main resolves "<sha>^" twice in the code path; git runs once.
  fs.rmSync(log, { force: true });
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent');
  fs.rmSync(log, { force: true });
  const sub = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', commit: merged }, 'agent');
  assert.deepEqual(sub.body.handoff.files, ['docs/combat.md']);
  const submitCalls = calls();
  assert.equal(new Set(submitCalls).size, submitCalls.length, `duplicates in:\n${submitCalls.join('\n')}`);
  assert.equal(submitCalls.filter((c) => c.endsWith(`${merged}^^{commit}`)).length, 1);
});

test('each request gets a fresh reader: a new commit shows up on the next request', async () => {
  const before = (await s.call('GET', `/api/tasks/${key}`)).body.stale_context ?? [];
  repo.commit({ 'docs/economy.md': 'changed' }, 'economy change');
  const after = (await s.call('GET', `/api/tasks/${key}`)).body.stale_context;
  assert.ok(after.some((c) => c.path === 'docs/economy.md' && c.commits_since[0].subject === 'economy change'));
  assert.ok(!before.some((c) => c.path === 'docs/economy.md'));
});
