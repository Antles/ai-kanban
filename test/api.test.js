import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app;
let base;

before(async () => {
  app = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.close());

async function call(method, path, body, agent = 'tester', { role } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-agent': agent, ...(role && { 'x-role': role }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('projects: create, validate, conflict', async () => {
  const created = await call('POST', '/api/projects', { key: 'game', name: 'My Game' });
  assert.equal(created.status, 201);
  assert.equal(created.body.key, 'GAME');
  assert.equal((await call('POST', '/api/projects', { key: 'GAME' })).status, 409);
  assert.equal((await call('POST', '/api/projects', { key: '1X' })).status, 400);
  const list = await call('GET', '/api/projects');
  assert.deepEqual(list.body.map((p) => p.key), ['GAME']);
});

test('tasks: create, keys, defaults, validation', async () => {
  const t = await call('POST', '/api/tasks', { project: 'GAME', title: 'Player movement', labels: 'core, input' });
  assert.equal(t.status, 201);
  assert.equal(t.body.key, 'GAME-1');
  assert.equal(t.body.status, 'backlog');
  assert.equal(t.body.priority, 'medium');
  assert.deepEqual(t.body.labels, ['core', 'input']);
  assert.equal(t.body.created_by, 'tester');

  const bad = await call('POST', '/api/tasks', { project: 'GAME', title: 'x', status: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Expected one of/);

  const alias = await call('POST', '/api/tasks', { project: 'GAME', title: 'alias', status: 'In Progress' }, 'human', { role: 'director' });
  assert.equal(alias.body.status, 'in_progress');
  assert.ok(alias.body.started_at);
  await call('DELETE', `/api/tasks/${alias.body.key}`);
});

test('bulk create with batch references, dependencies and claim-next ordering', async () => {
  const res = await call('POST', '/api/tasks/bulk', {
    tasks: [
      { project: 'GAME', title: 'Design save format', status: 'todo', priority: 'low' },
      { project: 'GAME', title: 'Implement save/load', status: 'todo', priority: 'urgent', depends_on: ['#0'] },
      { project: 'GAME', title: 'Main menu', status: 'todo', priority: 'high', labels: ['ui'] },
    ],
  });
  assert.equal(res.status, 201);
  const [design, impl, menu] = res.body;
  assert.equal(impl.blocked, true);
  assert.deepEqual(impl.depends_on, [design.key]);

  // Blocked task can't be claimed directly.
  const blocked = await call('POST', `/api/tasks/${impl.key}/claim`, {}, 'agent-a');
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.blocked_by, [design.key]);

  // Highest priority unblocked first (menu=high beats design=low; impl is blocked).
  const first = await call('POST', '/api/projects/GAME/claim-next', {}, 'agent-a');
  assert.equal(first.body.task.key, menu.key);
  assert.equal(first.body.task.status, 'in_progress');
  assert.equal(first.body.task.assignee, 'agent-a');

  // Label filter excludes non-matching tasks.
  const none = await call('POST', '/api/projects/GAME/claim-next', { labels: ['ui'] }, 'agent-b');
  assert.equal(none.body.task, null);

  const second = await call('POST', '/api/projects/GAME/claim-next', {}, 'agent-b');
  assert.equal(second.body.task.key, design.key);

  // Someone else's task can't be claimed.
  const taken = await call('POST', `/api/tasks/${design.key}/claim`, {}, 'agent-a');
  assert.equal(taken.status, 409);
  assert.equal(taken.body.assignee, 'agent-b');

  // Finishing the dependency unblocks the next task.
  await call('POST', `/api/tasks/${design.key}/move`, { status: 'done' }, 'human', { role: 'director' });
  const third = await call('POST', '/api/projects/GAME/claim-next', {}, 'agent-b');
  assert.equal(third.body.task.key, impl.key);
  assert.equal(third.body.task.blocked, false);

  // Anonymous callers must identify themselves to claim.
  const anon = await call('POST', '/api/projects/GAME/claim-next', {}, '');
  assert.equal(anon.status, 400);
});

test('pre-assigned tasks only go to their assignee, still in priority order', async () => {
  const a = await call('POST', '/api/tasks', { project: 'GAME', title: 'generic', status: 'todo', priority: 'urgent' });
  const b = await call('POST', '/api/tasks', { project: 'GAME', title: 'for artist', status: 'todo', priority: 'low', assignee: 'artist' });
  const got = await call('POST', '/api/projects/GAME/claim-next', {}, 'artist');
  assert.equal(got.body.task.key, a.body.key, 'urgent unassigned beats low pre-assigned');
  const other = await call('POST', '/api/projects/GAME/claim-next', {}, 'someone');
  assert.equal(other.body.task, null, 'nobody else gets the pre-assigned task');
  const again = await call('POST', '/api/projects/GAME/claim-next', {}, 'artist');
  assert.equal(again.body.task.key, b.body.key, 'what the artist already holds is listed, not handed out again');
  assert.deepEqual(again.body.held.map((h) => h.key), [a.body.key]);
});

test('release returns in_progress work to todo', async () => {
  const t = await call('POST', '/api/tasks', { project: 'GAME', title: 'to release', status: 'todo' });
  await call('POST', `/api/tasks/${t.body.key}/claim`, {}, 'agent-c');
  assert.equal((await call('POST', `/api/tasks/${t.body.key}/release`, {}, 'agent-d')).status, 409);
  const released = await call('POST', `/api/tasks/${t.body.key}/release`, {}, 'agent-c');
  assert.equal(released.body.status, 'todo');
  assert.equal(released.body.assignee, null);
});

test('move reorders within a column', async () => {
  const keys = [];
  for (const title of ['r1', 'r2', 'r3']) {
    keys.push((await call('POST', '/api/tasks', { project: 'GAME', title, status: 'review' }, 'human', { role: 'director' })).body.key);
  }
  await call('POST', `/api/tasks/${keys[2]}/move`, { status: 'review', index: 0 });
  const board = await call('GET', '/api/projects/GAME/board');
  const review = board.body.columns.find((c) => c.status === 'review').tasks.map((t) => t.key);
  assert.deepEqual(review, [keys[2], keys[0], keys[1]]);
});

test('patch, dependency cycles, comments, detail, activity', async () => {
  const a = (await call('POST', '/api/tasks', { project: 'GAME', title: 'A' })).body;
  const b = (await call('POST', '/api/tasks', { project: 'GAME', title: 'B', depends_on: [a.key], parent: a.key })).body;
  const cycle = await call('PATCH', `/api/tasks/${a.key}`, { depends_on: [b.key] });
  assert.equal(cycle.status, 400);
  const selfParent = await call('PATCH', `/api/tasks/${a.key}`, { parent: b.key });
  assert.equal(selfParent.status, 400);

  const patched = await call('PATCH', `/api/tasks/${a.key.toLowerCase()}`, { title: 'A2', priority: 'high', assignee: 'bob' });
  assert.equal(patched.body.title, 'A2');
  assert.equal(patched.body.assignee, 'bob');

  const c = await call('POST', `/api/tasks/${a.key}/comments`, { body: 'Progress **note**' }, 'bob');
  assert.equal(c.status, 201);
  assert.equal(c.body.author, 'bob');

  const detail = (await call('GET', `/api/tasks/${a.key}`)).body;
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.comment_count, 1);
  assert.deepEqual(detail.dependents.map((d) => d.key), [b.key]);
  assert.deepEqual(detail.subtasks.map((d) => d.key), [b.key]);
  assert.deepEqual(detail.activity.map((x) => x.action), ['commented', 'updated', 'created']);

  const filtered = await call('GET', `/api/tasks?project=GAME&assignee=bob&priority=high`);
  assert.deepEqual(filtered.body.map((t) => t.key), [a.key]);
  const byLabel = await call('GET', '/api/tasks?label=core');
  assert.deepEqual(byLabel.body.map((t) => t.key), ['GAME-1']);

  const activity = await call('GET', '/api/activity?project=GAME&limit=3');
  assert.equal(activity.body.length, 3);
  assert.equal(activity.body[0].action, 'commented');
});

test('MCP: initialize, list tools, call tools', async () => {
  const rpc = (method, params, id = 1) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-agent': 'mcp-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  const init = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);

  const note = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(note.status, 202);

  const tools = await (await rpc('tools/list', {})).json();
  assert.ok(tools.result.tools.some((t) => t.name === 'claim_next_task'));

  const createdRes = await (await rpc('tools/call', { name: 'create_task', arguments: { project: 'GAME', title: 'via mcp', status: 'todo', priority: 'urgent', verbose: true } })).json();
  const created = JSON.parse(createdRes.result.content[0].text);
  assert.equal(created.created_by, 'mcp-agent');

  const claimed = await (await rpc('tools/call', { name: 'claim_task', arguments: { task: created.key } })).json();
  assert.equal(JSON.parse(claimed.result.content[0].text).assignee, 'mcp-agent');

  const err = await (await rpc('tools/call', { name: 'get_task', arguments: { task: 'GAME-9999' } })).json();
  assert.equal(err.result.isError, true);
});

test('auth: API key required when configured', async () => {
  const secured = createApp({ dbPath: ':memory:', apiKey: 's3cret' });
  await new Promise((resolve) => secured.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${secured.server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/projects`)).status, 401);
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    assert.equal((await fetch(`${url}/api/projects`, { headers: { authorization: 'Bearer s3cret' } })).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally {
    await secured.close();
  }
});

test('guide and openapi are served', async () => {
  const guide = await fetch(`${base}/api/guide`);
  assert.match(await guide.text(), new RegExp(base.replace(/[.]/g, '\\.')));
  const spec = await (await fetch(`${base}/api/openapi.json`)).json();
  assert.equal(spec.openapi, '3.0.3');
});

test('columns sort by priority; next_up is what claim-next returns', async () => {
  await call('POST', '/api/projects', { key: 'PRIO' });
  const mk = async (title, priority, extra = {}) =>
    (await call('POST', '/api/tasks', { project: 'PRIO', title, status: 'todo', priority, ...extra })).body.key;
  const low = await mk('low', 'low');
  const med = await mk('med', 'medium');
  const urgent = await mk('urgent', 'urgent');
  const high = await mk('high', 'high');
  const blockedUrgent = await mk('blocked urgent', 'urgent', { depends_on: [low] });

  let board = (await call('GET', '/api/projects/PRIO/board')).body;
  const todo = () => board.columns.find((c) => c.status === 'todo').tasks.map((t) => t.key);
  assert.deepEqual(todo(), [urgent, blockedUrgent, high, med, low]);
  assert.equal(board.next_up, urgent);

  // Reprioritizing re-sorts immediately.
  await call('PATCH', `/api/tasks/${low}`, { priority: 'urgent' });
  board = (await call('GET', '/api/projects/PRIO/board')).body;
  assert.deepEqual(todo(), [urgent, blockedUrgent, low, high, med]);

  // Dragging "med" to the very top makes it urgent (fits its new neighbours).
  const moved = await call('POST', `/api/tasks/${med}/move`, { status: 'todo', index: 0 });
  assert.equal(moved.body.priority, 'urgent');
  board = (await call('GET', '/api/projects/PRIO/board')).body;
  assert.equal(todo()[0], med);
  assert.equal(board.next_up, med);

  // Dragging "urgent" to the bottom demotes it to the lowest neighbour's priority.
  const demoted = await call('POST', `/api/tasks/${urgent}/move`, { status: 'todo', index: 99 });
  assert.equal(demoted.body.priority, 'high');
  board = (await call('GET', '/api/projects/PRIO/board')).body;
  assert.equal(todo().at(-1), urgent);

  // Moving within the same priority keeps the priority.
  const same = await call('POST', `/api/tasks/${low}/move`, { status: 'todo', index: 0 });
  assert.equal(same.body.priority, 'urgent');

  const claimed = await call('POST', '/api/projects/PRIO/claim-next', {}, 'agent');
  assert.equal(claimed.body.task.key, low);
});

test('milestones: create, attach, filter, progress, claim by milestone, close, delete', async () => {
  await call('POST', '/api/projects', { key: 'MS' });
  const t1 = (await call('POST', '/api/tasks', { project: 'MS', title: 'one', status: 'todo', priority: 'urgent' })).body.key;
  const m = await call('POST', '/api/projects/MS/milestones', { name: 'Vertical slice', due_date: '2026-11-01', tasks: [t1] });
  assert.equal(m.status, 201);
  assert.equal(m.body.total, 1);
  assert.equal((await call('POST', '/api/projects/MS/milestones', { name: 'vertical SLICE' })).status, 409);
  assert.equal((await call('POST', '/api/projects/MS/milestones', { name: 'x', due_date: 'soon' })).status, 400);

  // Attach by name on create, case-insensitively.
  const t2 = (await call('POST', '/api/tasks', { project: 'MS', title: 'two', status: 'todo', milestone: 'vertical slice' })).body;
  assert.equal(t2.milestone, 'Vertical slice');
  const other = (await call('POST', '/api/tasks', { project: 'MS', title: 'other', status: 'todo', priority: 'urgent' })).body.key;
  assert.equal((await call('POST', '/api/tasks', { project: 'MS', title: 'bad', milestone: 'nope' })).status, 404);

  const inMs = await call('GET', '/api/tasks?project=MS&milestone=Vertical%20slice');
  assert.deepEqual(inMs.body.map((t) => t.key), [t1, t2.key]);
  const none = await call('GET', '/api/tasks?project=MS&milestone=none');
  assert.deepEqual(none.body.map((t) => t.key), [other]);

  // claim-next restricted to the milestone skips the (equally urgent) task outside it.
  await call('PATCH', `/api/tasks/${t1}`, { priority: 'low' });
  const claimed = await call('POST', '/api/projects/MS/claim-next', { milestone: 'Vertical slice' }, 'agent');
  assert.equal(claimed.body.task.key, t2.key);

  await call('POST', `/api/tasks/${t2.key}/move`, { status: 'done' }, 'human', { role: 'director' });
  const detail = await call('GET', `/api/milestones/${m.body.id}`);
  assert.equal(detail.body.progress, 50);
  assert.equal(detail.body.tasks.length, 2);

  const closed = await call('PATCH', `/api/milestones/${m.body.id}`, { status: 'closed', add_tasks: [other] });
  assert.equal(closed.body.status, 'closed');
  assert.equal(closed.body.total, 3);

  const board = (await call('GET', '/api/projects/MS/board')).body;
  assert.equal(board.milestones.length, 1);

  const cleared = await call('PATCH', `/api/tasks/${other}`, { milestone: null });
  assert.equal(cleared.body.milestone, null);

  await call('DELETE', `/api/milestones/${m.body.id}`, undefined, 'human', { role: 'director' });
  assert.equal((await call('GET', `/api/tasks/${t1}`)).body.milestone, null);
  const log = (await call('GET', '/api/activity?project=MS&limit=100')).body.map((a) => a.action);
  assert.ok(log.includes('milestone_created') && log.includes('milestone_deleted'));
});

test('MCP milestone tools', async () => {
  const rpc = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': 'mcp-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(!body.result.isError, body.result.content[0].text);
    return JSON.parse(body.result.content[0].text);
  };
  await rpc('create_milestone', { project: 'GAME', name: 'Alpha' });
  const task = await rpc('create_task', { project: 'GAME', title: 'alpha task', milestone: 'Alpha', priority: 'high', verbose: true });
  assert.equal(task.milestone, 'Alpha');
  const updated = await rpc('update_milestone', { milestone: 'Alpha', project: 'GAME', due_date: '2026-12-24' });
  assert.equal(updated.due_date, '2026-12-24');
  const list = await rpc('list_milestones', { project: 'GAME' });
  assert.deepEqual(list.map((m) => [m.name, m.total]), [['Alpha', 1]]);
});

test('migrating a v1 database keeps data and adds every later table and column', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb, MIGRATIONS } = await import('../src/db.js');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
  const file = path.join(dir, 'v1.db');
  // Build a v1 database by running only the first migration.
  const raw = new DatabaseSync(file);
  raw.exec(MIGRATIONS[0]);
  raw.exec('PRAGMA user_version = 1');
  raw.exec(`INSERT INTO projects (key, name, created_at, updated_at) VALUES ('OLD', 'Old', 'x', 'x');
            INSERT INTO tasks (project_id, number, title, created_at, updated_at) VALUES (1, 1, 'kept', 'x', 'x');`);
  raw.close();
  const upgraded = openDb(file);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const kept = upgraded.prepare('SELECT title, milestone_id, epic_id, sprint_id, estimate, criteria, rework FROM tasks').get();
  assert.equal(kept.title, 'kept');
  assert.equal(kept.sprint_id, null);
  assert.equal(kept.criteria, '[]');
  assert.equal(kept.rework, 0);
  upgraded.close();
  fs.rmSync(dir, { recursive: true });
});

test('epics: create, attach, inherit, excluded from board and claims, progress', async () => {
  await call('POST', '/api/projects', { key: 'EP' });
  const a = (await call('POST', '/api/tasks', { project: 'EP', title: 'a', status: 'todo', estimate: 3 })).body.key;
  const epic = await call('POST', '/api/projects/EP/epics', { title: 'Save system', description: 'Persist progress', tasks: [a] });
  assert.equal(epic.status, 201);
  assert.equal(epic.body.type, 'epic');
  assert.equal(epic.body.progress.total, 1);

  // Attach by epic title, and subtasks inherit the parent's epic.
  const b = (await call('POST', '/api/tasks', { project: 'EP', title: 'b', status: 'todo', priority: 'urgent', epic: 'save SYSTEM', estimate: 5 })).body;
  assert.equal(b.epic, epic.body.key);
  const sub = (await call('POST', '/api/tasks', { project: 'EP', title: 'b.1', parent: b.key })).body;
  assert.equal(sub.epic, epic.body.key);

  // Epics are not board cards, can't be claimed, and are never "next up".
  const board = (await call('GET', '/api/projects/EP/board')).body;
  const keys = board.columns.flatMap((c) => c.tasks.map((t) => t.key));
  assert.ok(!keys.includes(epic.body.key));
  assert.equal(board.epics[0].key, epic.body.key);
  assert.equal(board.next_up, b.key);
  assert.equal((await call('POST', `/api/tasks/${epic.body.key}/claim`, {}, 'agent')).status, 409);

  // Can't nest epics, can't put a regular task under a non-epic.
  const epic2 = (await call('POST', '/api/projects/EP/epics', { title: 'Other' })).body.key;
  assert.equal((await call('PATCH', `/api/tasks/${epic2}`, { epic: epic.body.key })).status, 400);
  assert.equal((await call('PATCH', `/api/tasks/${a}`, { epic: b.key })).status, 400);
  // An epic with tasks can't stop being an epic.
  assert.equal((await call('PATCH', `/api/tasks/${epic.body.key}`, { type: 'task' })).status, 400);

  const claimed = await call('POST', '/api/projects/EP/claim-next', { epic: epic.body.key }, 'agent');
  assert.equal(claimed.body.task.key, b.key);
  await call('POST', `/api/tasks/${b.key}/move`, { status: 'done' }, 'human', { role: 'director' });

  const detail = (await call('GET', `/api/tasks/${epic.body.key}`)).body;
  assert.deepEqual(detail.children.map((t) => t.key).sort(), [a, b.key, sub.key].sort());
  assert.equal(detail.progress.points_total, 8);
  assert.equal(detail.progress.points_done, 5);

  assert.deepEqual((await call('GET', `/api/tasks?project=EP&epic=none`)).body.map((t) => t.key), []);
  assert.equal((await call('PATCH', `/api/tasks/${a}`, { estimate: 2.5 })).status, 400);
});

test('sprints: plan, start one at a time, complete with carry-over', async () => {
  await call('POST', '/api/projects', { key: 'SP' });
  const mk = async (title, extra = {}) => (await call('POST', '/api/tasks', { project: 'SP', title, status: 'todo', ...extra })).body.key;
  const [t1, t2, t3, t4] = [await mk('t1', { estimate: 2 }), await mk('t2', { estimate: 3 }), await mk('t3'), await mk('t4')];

  const s1 = await call('POST', '/api/projects/SP/sprints', { goal: 'Foundations', tasks: [t1, t2], end_date: '2026-10-10', start_date: '2026-10-01' });
  assert.equal(s1.status, 201);
  assert.equal(s1.body.name, 'Sprint 1');
  assert.equal(s1.body.points_total, 5);
  const s2 = (await call('POST', '/api/projects/SP/sprints', { name: 'Polish', tasks: [t3] })).body;
  assert.equal((await call('POST', '/api/projects/SP/sprints', { name: 'bad', start_date: '2026-10-05', end_date: '2026-10-01' })).status, 400);
  const byName = await call('POST', '/api/tasks', { project: 'SP', title: 't5', sprint: 'polish' });
  assert.equal(byName.body.sprint, 'Polish');

  // Only one active sprint.
  assert.equal((await call('PATCH', `/api/sprints/${s1.body.id}`, { status: 'active' })).body.status, 'active');
  assert.equal((await call('PATCH', `/api/sprints/${s2.id}`, { status: 'active' })).status, 409);

  // "active" resolves within a project, for filters and claims.
  assert.deepEqual((await call('GET', '/api/tasks?project=SP&sprint=active')).body.map((t) => t.key), [t1, t2]);
  const claimed = await call('POST', '/api/projects/SP/claim-next', { sprint: 'active' }, 'agent');
  assert.equal(claimed.body.task.sprint, 'Sprint 1');

  // Completing carries unfinished work to the next planned sprint by default.
  await call('POST', `/api/tasks/${t1}/move`, { status: 'done' }, 'human', { role: 'director' });
  const done = await call('PATCH', `/api/sprints/${s1.body.id}`, { status: 'completed' });
  assert.equal(done.body.status, 'completed');
  assert.deepEqual(done.body.carried_over, [t2]);
  assert.equal(done.body.carried_to, 'Polish');
  assert.equal((await call('GET', `/api/tasks/${t1}`)).body.sprint, 'Sprint 1', 'done work stays in its sprint');

  // Or explicitly to unscheduled.
  await call('PATCH', `/api/sprints/${s2.id}`, { status: 'active' });
  const done2 = await call('PATCH', `/api/sprints/${s2.id}`, { status: 'completed', carry_over_to: null });
  assert.equal(done2.body.carried_to, null);

  const plan = (await call('GET', '/api/projects/SP/plan')).body;
  assert.deepEqual(plan.sprints.map((s) => [s.name, s.status]), [['Sprint 1', 'completed'], ['Polish', 'completed']]);
  assert.deepEqual(plan.unscheduled.map((t) => t.key).sort(), [t2, t3, t4, 'SP-5'].sort());

  // add/remove tasks, delete sprint.
  const s3 = (await call('POST', '/api/projects/SP/sprints', {})).body;
  assert.equal(s3.name, 'Sprint 3');
  const upd = await call('PATCH', `/api/sprints/${s3.id}`, { add_tasks: [t3, t4], remove_tasks: [t4] });
  assert.equal(upd.body.total, 1);
  await call('DELETE', `/api/sprints/${s3.id}`, undefined, 'human', { role: 'director' });
  assert.equal((await call('GET', `/api/tasks/${t3}`)).body.sprint, null);
  const log = (await call('GET', '/api/activity?project=SP&limit=200')).body.map((a) => a.action);
  for (const action of ['sprint_created', 'sprint_started', 'sprint_completed', 'sprint_deleted']) assert.ok(log.includes(action), action);
});

test('MCP epic and sprint tools', async () => {
  const rpc = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': 'planner' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    assert.ok(!body.result.isError, body.result.content[0].text);
    return JSON.parse(body.result.content[0].text);
  };
  await call('POST', '/api/projects', { key: 'MCPS' });
  const epic = await rpc('create_epic', { project: 'MCPS', title: 'Combat' });
  const tasks = await rpc('create_tasks', {
    tasks: [
      { project: 'MCPS', title: 'Rounds', epic: epic.key, estimate: 3, status: 'todo' },
      { project: 'MCPS', title: 'Intents', epic: 'Combat', estimate: 5, status: 'todo', depends_on: ['#0'] },
    ],
  });
  const sprint = await rpc('create_sprint', { project: 'MCPS', goal: 'Core loop', tasks: tasks.map((t) => t.key) });
  assert.equal(sprint.points_total, 8);
  const started = await rpc('update_sprint', { sprint: 'Sprint 1', project: 'MCPS', status: 'active' });
  assert.equal(started.status, 'active');
  const plan = await rpc('get_plan', { project: 'MCPS' });
  assert.equal(plan.sprints[0].tasks.length, 2);
  assert.equal(plan.epics[0].progress.total, 2);
  const next = await rpc('claim_next_task', { project: 'MCPS', sprint: 'active' });
  assert.equal(next.task.title, 'Rounds');
});

test('criteria and context: create, preserve ticks, check off, briefing on claim', async () => {
  await call('POST', '/api/projects', { key: 'CR', agent_brief: 'Portrait 1080x1920. Pixel-perfect: no filtering.' });
  const t = await call('POST', '/api/tasks', {
    project: 'CR',
    title: 'Double jump',
    status: 'todo',
    criteria: ['Second jump only while airborne', '- [x] Resets on landing'],
    context: 'docs/movement.md\nAssets/Scripts/Player/',
  });
  assert.equal(t.status, 201);
  assert.deepEqual(t.body.criteria, [
    { text: 'Second jump only while airborne', done: false, owner: 'agent' },
    { text: 'Resets on landing', done: true, owner: 'agent' },
  ]);
  assert.deepEqual(t.body.context, ['docs/movement.md', 'Assets/Scripts/Player/']);

  const checked = await call('POST', `/api/tasks/${t.body.key}/criteria`, { items: [0] });
  assert.equal(checked.body.criteria[0].done, true);
  assert.equal((await call('POST', `/api/tasks/${t.body.key}/criteria`, { items: ['nope'] })).status, 400);
  const unchecked = await call('POST', `/api/tasks/${t.body.key}/criteria`, { items: ['Resets on landing'], done: false });
  assert.equal(unchecked.body.criteria[1].done, false);

  // Rewriting the list keeps ticks on unchanged items.
  const patched = await call('PATCH', `/api/tasks/${t.body.key}`, { criteria: ['Second jump only while airborne', 'Unit test'] });
  assert.deepEqual(patched.body.criteria, [
    { text: 'Second jump only while airborne', done: true, owner: 'agent' },
    { text: 'Unit test', done: false, owner: 'agent' },
  ]);

  const claimed = await call('POST', '/api/projects/CR/claim-next', {}, 'agent-x');
  assert.equal(claimed.body.task.key, t.body.key);
  assert.equal(claimed.body.task.agent_brief, 'Portrait 1080x1920. Pixel-perfect: no filtering.');
  assert.deepEqual(claimed.body.task.context, ['docs/movement.md', 'Assets/Scripts/Player/']);
  assert.ok(Array.isArray(claimed.body.task.comments));
  assert.equal(claimed.body.task.activity, undefined, 'briefings leave out the audit log');

  const direct = await call('POST', '/api/tasks', { project: 'CR', title: 'other', status: 'todo' });
  const claimedDirect = await call('POST', `/api/tasks/${direct.body.key}/claim`, {}, 'agent-x');
  assert.equal(claimedDirect.body.agent_brief, 'Portrait 1080x1920. Pixel-perfect: no filtering.');

  const project = await call('PATCH', '/api/projects/CR', { agent_brief: 'Updated brief' }, 'human', { role: 'director' });
  assert.equal(project.body.agent_brief, 'Updated brief');
});

test('review: submit with handoff, request changes, rework comes first, accept', async () => {
  await call('POST', '/api/projects', { key: 'RV' });
  const [work, other] = (
    await call('POST', '/api/tasks/bulk', {
      tasks: [
        { project: 'RV', title: 'Party select screen', status: 'todo', priority: 'medium', criteria: ['Shows 4 slots', 'Fits portrait'] },
        { project: 'RV', title: 'Urgent unrelated', status: 'todo', priority: 'urgent' },
      ],
    })
  ).body;
  await call('POST', `/api/tasks/${work.key}/claim`, {}, 'claude-ui');
  await call('POST', `/api/tasks/${work.key}/criteria`, { items: [0] }, 'claude-ui');

  assert.equal((await call('POST', `/api/tasks/${work.key}/submit`, {}, 'claude-ui')).status, 400, 'summary is required');
  const submitted = await call(
    'POST',
    `/api/tasks/${work.key}/submit`,
    { summary: 'Built the screen', branch: 'feat/party', commit: 'abc123', files: ['PartySelect.cs'], verify: 'Open Party scene' },
    'claude-ui',
  );
  assert.equal(submitted.body.status, 'review');
  assert.equal(submitted.body.handoff.branch, 'feat/party');
  assert.equal(submitted.body.handoff.submitted_by, 'claude-ui');
  assert.deepEqual(submitted.body.unchecked_criteria, ['Fits portrait']);

  // Someone claiming it to review doesn't change who the rework goes back to.
  await call('POST', `/api/tasks/${work.key}/claim`, {}, 'reviewer');
  const queue = await call('GET', '/api/projects/RV/review');
  assert.deepEqual(queue.body.map((t) => t.key), [work.key]);
  assert.equal(queue.body[0].reviews[0].event, 'submitted');

  assert.equal((await call('POST', `/api/tasks/${work.key}/review`, { verdict: 'changes' }, 'human', { role: 'director' })).status, 400, 'feedback required');
  const sent = await call('POST', `/api/tasks/${work.key}/review`, { verdict: 'request changes', feedback: 'Cut off on 19.5:9 screens' }, 'human', { role: 'director' });
  assert.equal(sent.body.status, 'todo');
  assert.equal(sent.body.assignee, 'claude-ui');
  assert.equal(sent.body.rework, true);
  assert.equal((await call('POST', `/api/tasks/${work.key}/review`, { verdict: 'accept' }, 'human', { role: 'director' })).status, 409, 'not in review');

  // Rework beats a higher-priority unassigned task for the agent that owns it, but nobody else gets it.
  assert.equal((await call('POST', '/api/projects/RV/claim-next', {}, 'someone-else')).body.task.key, other.key);
  const again = await call('POST', '/api/projects/RV/claim-next', {}, 'claude-ui');
  assert.equal(again.body.task.key, work.key);
  assert.match(again.body.task.comments.at(-1).body, /Changes requested.*round 1[\s\S]*19\.5:9/);
  assert.equal(again.body.task.reviews.at(-1).event, 'changes_requested');

  const resubmitted = await call('POST', `/api/tasks/${work.key}/submit`, { summary: 'Fixed safe area' }, 'claude-ui');
  assert.equal(resubmitted.body.rework, false);
  const accepted = await call('POST', `/api/tasks/${work.key}/review`, { verdict: 'accept' }, 'human', { role: 'director' });
  assert.equal(accepted.body.status, 'done');
  assert.ok(accepted.body.completed_at);
  const detail = await call('GET', `/api/tasks/${work.key}`);
  assert.deepEqual(
    detail.body.reviews.map((r) => [r.event, r.round]),
    [['submitted', 1], ['changes_requested', 1], ['submitted', 2], ['accepted', 2]],
  );
});

test('attachments: upload raw, list, download, reject unsafe types, delete', async () => {
  const t = await call('POST', '/api/tasks', { project: 'RV', title: 'Playtest: HP bar overlaps notch', labels: ['playtest'] });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await fetch(`${base}/api/tasks/${t.body.key}/attachments?filename=${encodeURIComponent('shots/notch.png')}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-agent': 'phone' },
    body: png,
  });
  assert.equal(up.status, 201);
  const file = await up.json();
  assert.equal(file.filename, 'notch.png');
  assert.equal(file.size, png.length);
  assert.equal(file.created_by, 'phone');

  const down = await fetch(`${base}${file.url}`);
  assert.equal(down.headers.get('content-type'), 'image/png');
  assert.match(down.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await down.arrayBuffer()), png);

  const html = await fetch(`${base}/api/tasks/${t.body.key}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'text/html' },
    body: '<script>alert(1)</script>',
  });
  assert.equal(html.status, 415);

  const detail = await call('GET', `/api/tasks/${t.body.key}`);
  assert.equal(detail.body.attachment_count, 1);
  assert.equal(detail.body.attachments[0].id, file.id);

  assert.equal((await call('DELETE', `/api/attachments/${file.id}`)).status, 200);
  assert.equal((await fetch(`${base}${file.url}`)).status, 404);
});

test('capture page is served', async () => {
  const res = await fetch(`${base}/capture`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /capture\.js/);
});

test('MCP review, criteria and attachment tools', async () => {
  const rpc = async (name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': 'mcp-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json()).result;
  };
  const text = (result) => JSON.parse(result.content[0].text);
  const t = text(await rpc('create_task', { project: 'RV', title: 'mcp flow', status: 'todo', criteria: ['a', 'b'] }));
  await rpc('claim_task', { task: t.key });
  assert.deepEqual(text(await rpc('check_criteria', { task: t.key, items: [0, 'b'], verbose: true })).criteria.map((c) => c.done), [true, true]);
  const sub = text(await rpc('submit_for_review', { task: t.key, summary: 'done', files: ['a.cs'] }));
  assert.equal(sub.status, 'review');
  assert.equal(sub.unchecked_criteria, undefined);
  assert.ok(text(await rpc('get_review_queue', { project: 'RV' })).some((x) => x.key === t.key));
  assert.equal((await call('POST', `/api/tasks/${t.key}/review`, { verdict: 'accept' }, 'human', { role: 'director' })).body.status, 'done');

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await fetch(`${base}/api/tasks/${t.key}/attachments?filename=s.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
  const { id } = await up.json();
  const image = await rpc('get_attachment', { id });
  assert.equal(image.content[1].type, 'image');
  assert.equal(image.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(image.content[1].data, 'base64').toString('hex'), png.toString('hex'));
});
