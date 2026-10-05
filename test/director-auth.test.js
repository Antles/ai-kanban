import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, tempRepo } from './helpers.js';

const KEY = 'correct-horse-battery-staple';
let s;
let repo;
before(async () => {
  s = await startServer({ directorKey: KEY });
  repo = tempRepo();
  repo.commit({ 'README.md': 'x' }, 'init');
  await s.director('POST', '/api/projects', { key: 'DA', repo_path: repo.dir, required_fields: ['estimate'] });
});
after(() => {
  repo.remove();
  return s.close();
});

// What an agent can send: the board UI's X-Role header, with no key or a guessed one.
const spoof = (method, path, body) => s.call(method, path, body, 'sneaky', { role: 'director' });
const guess = (method, path, body) => s.call(method, path, body, 'sneaky', { role: 'director', directorKey: 'guess' });
const withKey = (method, path, body) => s.call(method, path, body, 'human', { role: 'director', directorKey: KEY });

async function fixture() {
  const t = await withKey('POST', '/api/tasks', {
    project: 'DA',
    title: 'Feature',
    status: 'in_progress',
    estimate: 2,
    criteria: ['[director] Feels good on the phone', 'tests pass'],
    prerequisites: ['Plug in the phone'],
  });
  assert.equal(t.status, 201);
  const q = await s.call('POST', `/api/tasks/${t.body.key}/questions`, { question: 'A or B?', options: ['A', 'B'] }, 'agent');
  return { key: t.body.key, question: q.body.id };
}

test('/api/auth says how the request is seen, never the key', async () => {
  assert.deepEqual((await spoof('GET', '/api/auth')).body, { role: 'agent', director_key_required: true });
  assert.deepEqual((await guess('GET', '/api/auth')).body, { role: 'agent', director_key_required: true, director_key_accepted: false });
  assert.deepEqual((await withKey('GET', '/api/auth')).body, { role: 'director', director_key_required: true, director_key_accepted: true });
});

test('X-Role: director without the key is an agent on every Director-only action', async () => {
  const { key, question } = await fixture();
  const actions = [
    ['tick a Director criterion', 'POST', `/api/tasks/${key}/criteria`, { items: [0] }],
    ['tick a Director criterion by edit', 'PATCH', `/api/tasks/${key}`, { criteria: ['[x] [director] Feels good on the phone', 'tests pass'] }],
    ['tick a prerequisite', 'POST', `/api/tasks/${key}/prerequisites`, { items: [0] }],
    ['tick a prerequisite by edit', 'PATCH', `/api/tasks/${key}`, { prerequisites: ['[x] Plug in the phone'] }],
    ['answer a question', 'POST', `/api/questions/${question}/answer`, { option: 0 }],
    ['record a decision', 'POST', '/api/projects/DA/decisions', { title: 'x', decision: 'y' }],
    ['check a candidate repo path', 'GET', `/api/projects/DA/repo?path=${encodeURIComponent(repo.dir)}`],
    ['create with a ticked prerequisite', 'POST', '/api/tasks', { project: 'DA', title: 't', estimate: 1, prerequisites: ['[x] done already'] }],
    ['create with a ticked Director criterion', 'POST', '/api/tasks', { project: 'DA', title: 't', estimate: 1, criteria: ['[x] [director] ok'] }],
  ];
  for (const [what, method, path, body] of actions) {
    for (const send of [spoof, guess]) {
      const res = await send(method, path, body);
      assert.equal(res.status, 403, `${what} (${send === spoof ? 'header only' : 'wrong key'}): ${JSON.stringify(res.body)}`);
    }
  }
  // Required fields apply to agents (the Director is exempt).
  const missing = await spoof('POST', '/api/tasks', { project: 'DA', title: 'no estimate', status: 'todo' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /estimate/);

  // Nothing changed.
  const after = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.deepEqual(after.criteria.map((c) => c.done), [false, false]);
  assert.deepEqual(after.pending_prerequisites, ['Plug in the phone']);
  assert.equal(after.waiting_on_director, true);
});

test('with the key, every Director action works; the key never shows up', async () => {
  const { key, question } = await fixture();
  assert.equal((await withKey('POST', `/api/tasks/${key}/criteria`, { items: [0] })).status, 200);
  assert.equal((await withKey('POST', `/api/tasks/${key}/prerequisites`, { items: [0] })).status, 200);
  assert.equal((await withKey('POST', `/api/questions/${question}/answer`, { option: 0, record_decision: true })).status, 200);
  assert.equal((await withKey('POST', '/api/projects/DA/decisions', { title: 'x', decision: 'y' })).status, 201);
  assert.equal((await withKey('GET', `/api/projects/DA/repo?path=${encodeURIComponent(repo.dir)}`)).status, 200);
  const created = await withKey('POST', '/api/tasks', { project: 'DA', title: 'no estimate', prerequisites: ['[x] done'] });
  assert.equal(created.status, 201, 'the Director is exempt from required fields');

  const everything = JSON.stringify([
    (await withKey('GET', `/api/tasks/${key}`)).body,
    (await withKey('GET', '/api/activity?project=DA&limit=500')).body,
    (await withKey('GET', '/api/projects/DA')).body,
    (await withKey('GET', '/api/projects/DA/inbox')).body,
    (await s.call('GET', '/api/guide')).body,
    (await s.call('GET', '/api/openapi.json')).body,
  ]);
  assert.ok(!everything.includes(KEY));
  assert.ok(!fs.readFileSync(new URL('../docs/agent-guide.md', import.meta.url), 'utf8').includes(KEY));
});

test('MCP stays agent-only, even with the key', async () => {
  const { key } = await fixture();
  const res = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent': 'm', 'x-role': 'director', 'x-director-key': KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_criteria', arguments: { task: key, items: [0] } } }),
  });
  const { result } = await res.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Director/);
});

test('without a key configured the board runs open, as before', async () => {
  const open = await startServer();
  try {
    assert.deepEqual((await open.call('GET', '/api/auth')).body, { role: 'agent', director_key_required: false });
    assert.equal((await open.director('GET', '/api/auth')).body.role, 'director');
    await open.director('POST', '/api/projects', { key: 'OP' });
    const t = await open.call('POST', '/api/tasks', { project: 'OP', title: 't', criteria: ['[director] ok'] });
    assert.equal((await open.call('POST', `/api/tasks/${t.body.key}/criteria`, { items: [0] }, 'x', { role: 'director' })).status, 200);
  } finally {
    await open.close();
  }
});
