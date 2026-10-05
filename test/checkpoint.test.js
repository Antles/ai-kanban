import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'CP' });
});
after(() => s.close());

test('release sets the checkpoint; the next briefing shows it before the description', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'CP', title: 'Battle skeleton', description: 'Build the state.', status: 'todo' });
  const key = t.body.key;
  assert.equal(t.body.checkpoint, null);
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  const released = await s.call(
    'POST',
    `/api/tasks/${key}/release`,
    { checkpoint: 'Done: BattleState + events. Next: replay hash. Branch feat/battle @ 1a2b3c.' },
    'agent-a',
  );
  assert.equal(released.body.status, 'todo');
  assert.deepEqual(Object.keys(released.body.checkpoint), ['body', 'by', 'at']);
  assert.equal(released.body.checkpoint.by, 'agent-a');

  const briefing = await s.call('POST', '/api/projects/CP/claim-next', {}, 'agent-b');
  const keys = Object.keys(briefing.body.task);
  assert.ok(keys.indexOf('checkpoint') < keys.indexOf('description'), 'checkpoint comes before the description');
  assert.match(briefing.body.task.checkpoint.body, /Next: replay hash/);
});

test('add_comment with checkpoint replaces the note; plain comments and releases without one keep it', async () => {
  const t = await s.director('POST', '/api/tasks', { project: 'CP', title: 't', status: 'in_progress', assignee: 'agent-c' });
  const key = t.body.key;
  const c = await s.call('POST', `/api/tasks/${key}/comments`, { body: 'Halfway: loader done, validator next.', checkpoint: true }, 'agent-c');
  assert.equal(c.status, 201);
  assert.equal(c.body.checkpoint, true);
  await s.call('POST', `/api/tasks/${key}/comments`, { body: 'just a note' }, 'agent-c');
  let detail = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(detail.checkpoint.body, 'Halfway: loader done, validator next.');
  assert.equal(detail.comments.length, 2, 'the checkpoint comment is still a comment');

  await s.call('POST', `/api/tasks/${key}/comments`, { body: 'Validator done too. Next: CLI.', checkpoint: true }, 'agent-c');
  await s.call('POST', `/api/tasks/${key}/release`, {}, 'agent-c');
  detail = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(detail.checkpoint.body, 'Validator done too. Next: CLI.', 'replaced, then kept by a plain release');

  const cleared = await s.call('PATCH', `/api/tasks/${key}`, { checkpoint: null });
  assert.equal(cleared.body.checkpoint, null);
});

test('checkpoint over MCP', async () => {
  const t = await s.rpc('create_task', { project: 'CP', title: 'mcp', status: 'todo' });
  await s.rpc('claim_task', { task: t.key });
  const released = await s.rpc('release_task', { task: t.key, checkpoint: 'Stopped at step 2', verbose: true });
  assert.equal(released.checkpoint.body, 'Stopped at step 2');
  const c = await s.rpc('add_comment', { task: t.key, body: 'Step 3 next', checkpoint: true });
  assert.equal(c.checkpoint, true);
  const again = await s.rpc('claim_task', { task: t.key });
  assert.equal(again.checkpoint.body, 'Step 3 next');
});

test('checkpoint edits are logged as set/cleared pairs', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'CP', title: 'log' });
  await s.call('PATCH', `/api/tasks/${t.body.key}`, { checkpoint: 'note' });
  await s.call('PATCH', `/api/tasks/${t.body.key}`, { checkpoint: null });
  const changes = (await s.call('GET', `/api/tasks/${t.body.key}`)).body.activity.filter((a) => a.detail.changes?.checkpoint).map((a) => a.detail.changes.checkpoint);
  assert.deepEqual(changes, [['set', null], [null, 'set']]);
});
