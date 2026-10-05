import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'SK' });
});
after(() => s.close());

// Pretend everything on the task happened `hours` ago.
function age(key, hours) {
  const row = s.app.kanban.taskRow(key);
  const then = new Date(Date.now() - hours * 3600000).toISOString();
  s.app.kanban.db.prepare('UPDATE activity SET created_at = ? WHERE task_id = ?').run(then, row.id);
  s.app.kanban.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(then, row.id);
}

test('in-progress claims idle past the threshold (default 24 h) are flagged; the claim is kept', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'SK', title: 'long one', status: 'todo' });
  const key = t.body.key;
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.stale_claim, undefined);

  age(key, 30);
  const stale = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(stale.stale_claim.idle, '30 hours');
  assert.equal(stale.assignee, 'agent-a');
  assert.equal(stale.status, 'in_progress');
  const card = (await s.call('GET', '/api/projects/SK/board')).body.columns.find((c) => c.status === 'in_progress').tasks[0];
  assert.ok(card.stale_claim, 'the board card carries the flag');
  const inbox = (await s.call('GET', '/api/projects/SK/inbox')).body;
  assert.deepEqual(inbox.items.map((i) => [i.kind, i.task, i.assignee]), [['stale', key, 'agent-a']]);

  // Any activity clears it.
  await s.call('POST', `/api/tasks/${key}/comments`, { body: 'still on it' }, 'agent-a');
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.stale_claim, undefined);
});

test('the threshold is per project; 0 turns it off; only in-progress claims count', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'SK', title: 'short leash', status: 'todo' });
  await s.call('POST', `/api/tasks/${t.body.key}/claim`, {}, 'agent-b');
  age(t.body.key, 3);
  assert.equal((await s.call('GET', `/api/tasks/${t.body.key}`)).body.stale_claim, undefined, '3 h < 24 h');
  assert.equal((await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: -1 })).status, 400);
  await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: 2 });
  assert.equal((await s.call('GET', `/api/tasks/${t.body.key}`)).body.stale_claim.idle, '3 hours');
  await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: 0 });
  assert.equal((await s.call('GET', `/api/tasks/${t.body.key}`)).body.stale_claim, undefined);

  await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: 1 });
  const idleTodo = await s.call('POST', '/api/tasks', { project: 'SK', title: 'sitting in todo', status: 'todo' });
  age(idleTodo.body.key, 100);
  assert.equal((await s.call('GET', `/api/tasks/${idleTodo.body.key}`)).body.stale_claim, undefined);
  assert.equal((await s.call('PATCH', '/api/projects/SK', { stale_claim_hours: 48 })).status, 403, 'agents never change it');
});

test('a task waiting on the Director is not a stale claim; the answer restarts the clock', async () => {
  await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: 24 });
  const t = await s.call('POST', '/api/tasks', { project: 'SK', title: 'which rule?', status: 'todo' });
  const key = t.body.key;
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-c');
  const q = await s.call('POST', `/api/tasks/${key}/questions`, { question: 'A or B?', options: ['A', 'B'] }, 'agent-c');
  age(key, 30);
  const waiting = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(waiting.waiting_on_director, true);
  assert.equal(waiting.stale_claim, undefined);
  const inbox = (await s.call('GET', '/api/projects/SK/inbox')).body;
  assert.deepEqual(inbox.items.filter((i) => i.task === key).map((i) => i.kind), ['question'], 'listed once, as the question');

  await s.director('POST', `/api/questions/${q.body.id}/answer`, { option: 0 });
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.stale_claim, undefined, 'the answer is fresh activity');
});

test('sub-hour idle times read in minutes; decimal thresholds work; epics are never flagged', async () => {
  await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: 0.25 });
  const t = await s.call('POST', '/api/tasks', { project: 'SK', title: 'quick', status: 'todo' });
  await s.call('POST', `/api/tasks/${t.body.key}/claim`, {}, 'agent-d');
  age(t.body.key, 0.5);
  assert.equal((await s.call('GET', `/api/tasks/${t.body.key}`)).body.stale_claim.idle, '30 minutes');
  age(t.body.key, 1.2);
  assert.equal((await s.call('GET', `/api/tasks/${t.body.key}`)).body.stale_claim.idle, '1 hour');

  const epic = await s.call('POST', '/api/projects/SK/epics', { title: 'Big theme' });
  const moved = await s.director('PATCH', `/api/tasks/${epic.body.key}`, { status: 'in_progress', assignee: 'agent-d' });
  assert.deepEqual([moved.body.status, moved.body.assignee], ['in_progress', 'agent-d']);
  age(epic.body.key, 100);
  assert.equal((await s.call('GET', `/api/tasks/${epic.body.key}`)).body.stale_claim, undefined);
  await s.director('PATCH', '/api/projects/SK', { stale_claim_hours: 24 });
});
