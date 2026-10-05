import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'PR' });
});
after(() => s.close());

test('prerequisites block claiming until the Director ticks them all', async () => {
  const t = await s.director('POST', '/api/tasks', {
    project: 'PR',
    title: 'Core project',
    status: 'todo',
    priority: 'urgent',
    prerequisites: ['Install the .NET 8 SDK', '- [x] Clone the repo'],
  });
  const key = t.body.key;
  assert.ok(t.body.prerequisites.every((p) => typeof p.added_at === 'string'));
  assert.deepEqual(t.body.prerequisites.map(({ added_at, ...p }) => p), [
    { text: 'Install the .NET 8 SDK', done: false },
    { text: 'Clone the repo', done: true },
  ]);
  assert.deepEqual(t.body.pending_prerequisites, ['Install the .NET 8 SDK']);
  assert.equal(t.body.blocked, true);
  assert.deepEqual(t.body.depends_on, [], 'blocked without any dependency');

  const claim = await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  assert.equal(claim.status, 409);
  assert.match(claim.body.error, /prerequisites: "Install the \.NET 8 SDK"/);
  assert.deepEqual(claim.body.prerequisites, ['Install the .NET 8 SDK']);

  const low = await s.call('POST', '/api/tasks', { project: 'PR', title: 'other', status: 'todo', priority: 'low' });
  const board = await s.call('GET', '/api/projects/PR/board');
  assert.equal(board.body.next_up, low.body.key, 'next_up skips it too');
  const next = await s.call('POST', '/api/projects/PR/claim-next', {}, 'agent-a');
  assert.equal(next.body.task.key, low.body.key);
  assert.deepEqual((await s.call('GET', '/api/tasks?project=PR&blocked=true')).body.map((x) => x.key), [key]);

  // Agents can't tick them, directly or through PATCH, nor remove them.
  assert.equal((await s.call('POST', `/api/tasks/${key}/prerequisites`, { items: [0] }, 'agent-a')).status, 403);
  assert.equal((await s.call('PATCH', `/api/tasks/${key}`, { prerequisites: ['[x] Install the .NET 8 SDK', 'Clone the repo'] })).status, 403);
  assert.equal((await s.call('PATCH', `/api/tasks/${key}`, { prerequisites: ['Clone the repo'] })).status, 403);
  // They can add one (and the others keep their state).
  const added = await s.call('PATCH', `/api/tasks/${key}`, { prerequisites: ['Install the .NET 8 SDK', 'Clone the repo', 'Plug in the phone'] });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.pending_prerequisites, ['Install the .NET 8 SDK', 'Plug in the phone']);

  const one = await s.director('POST', `/api/tasks/${key}/prerequisites`, { items: ['Install the .NET 8 SDK'] });
  assert.deepEqual(one.body.pending_prerequisites, ['Plug in the phone']);
  assert.equal((await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-b')).status, 409);
  const all = await s.director('POST', `/api/tasks/${key}/prerequisites`, { items: [2] });
  assert.equal(all.body.blocked, false);
  const claimed = await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-b');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.assignee, 'agent-b');
});

test('prerequisites via bulk create and MCP; the Director can edit them freely', async () => {
  const bulk = await s.call('POST', '/api/tasks/bulk', {
    tasks: [{ project: 'PR', title: 'unity', status: 'todo', prerequisites: 'Install Unity 6\nAdd iOS module' }],
  });
  const key = bulk.body[0].key;
  assert.equal(bulk.body[0].prerequisites.length, 2);
  const viaMcp = await s.rpc('create_task', { project: 'PR', title: 'mcp', status: 'todo', prerequisites: ['Pair the device'], verbose: true });
  assert.deepEqual(viaMcp.pending_prerequisites, ['Pair the device']);
  const claim = await s.rpc('claim_task', { task: viaMcp.key });
  assert.match(claim.error, /409.*Pair the device/);
  const tick = await s.rpc('update_task', { task: viaMcp.key, prerequisites: ['[x] Pair the device'] });
  assert.match(tick.error, /403/);

  const edited = await s.director('PATCH', `/api/tasks/${key}`, { prerequisites: ['[x] Install Unity 6'] });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.blocked, false);
});
