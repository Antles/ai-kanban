import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
let epic;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'RF' });
  epic = (await s.call('POST', '/api/projects/RF/epics', { title: 'Combat' })).body.key;
});
after(() => s.close());

test('without rules nothing changes; rules are validated', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'RF', title: 'anything goes', estimate: 7 });
  assert.equal(t.status, 201);
  assert.equal(t.body.missing_fields, undefined);
  assert.equal((await s.director('PATCH', '/api/projects/RF', { required_fields: ['nope'] })).status, 400);
  assert.equal((await s.director('PATCH', '/api/projects/RF', { allowed_estimates: [1, 'x'] })).status, 400);
  const p = await s.director('PATCH', '/api/projects/RF', { required_fields: ['priority', 'estimate', 'epic'], allowed_estimates: '8, 1, 2, 3, 5, 3' });
  assert.deepEqual(p.body.required_fields, ['priority', 'estimate', 'epic']);
  assert.deepEqual(p.body.allowed_estimates, [1, 2, 3, 5, 8]);
});

test('creating a task in todo returns a 400 naming the missing or invalid field', async () => {
  const missing = await s.call('POST', '/api/tasks', { project: 'RF', title: 'x', priority: 'high', status: 'todo' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /^estimate, epic are required when creating tasks in RF/);
  assert.equal(missing.body.field, 'estimate');
  assert.deepEqual(missing.body.missing, ['estimate', 'epic']);
  const bad = await s.call('POST', '/api/tasks', { project: 'RF', title: 'x', priority: 'high', estimate: 4, epic, status: 'todo' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /estimate 4 is not allowed; use one of 1, 2, 3, 5, 8/);
  const ok = await s.call('POST', '/api/tasks', { project: 'RF', title: 'ok', priority: 'high', estimate: 5, epic });
  assert.equal(ok.status, 201);
  // Subtasks inherit their parent's epic, which counts.
  const sub = await s.call('POST', '/api/tasks', { project: 'RF', title: 'sub', priority: 'low', estimate: 1, parent: ok.body.key });
  assert.equal(sub.status, 201);
  // Allowed estimates hold on update too.
  assert.equal((await s.call('PATCH', `/api/tasks/${ok.body.key}`, { estimate: 13 })).status, 400);
  // Epics only need what applies to them (priority here), also through create_epic.
  assert.match((await s.call('POST', '/api/projects/RF/epics', { title: 'Economy' })).body.error, /priority is required/);
  assert.equal((await s.call('POST', '/api/projects/RF/epics', { title: 'Economy', priority: 'low' })).status, 201);
  assert.match((await s.rpc('create_epic', { project: 'RF', title: 'Audio' })).error, /priority is required/);
});

test('bulk create reports which item failed and creates nothing', async () => {
  const before = (await s.call('GET', '/api/tasks?project=RF')).body.length;
  const res = await s.call('POST', '/api/tasks/bulk', {
    tasks: [
      { project: 'RF', title: 'fine', priority: 'low', estimate: 1, epic, status: 'todo' },
      { project: 'RF', title: 'no estimate', priority: 'low', epic, status: 'todo' },
    ],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^tasks\[1\]: estimate is required/);
  assert.equal(res.body.index, 1);
  assert.equal((await s.call('GET', '/api/tasks?project=RF')).body.length, before);
  const viaMcp = await s.rpc('create_tasks', { tasks: [{ project: 'RF', title: 'mcp', priority: 'low', status: 'todo' }] });
  assert.match(viaMcp.error, /400.*estimate, epic are required/);
});

test('the Director is exempt, and the missing-fields filter finds existing gaps', async () => {
  const quick = await s.director('POST', '/api/tasks', { project: 'RF', title: 'quick add from the board' });
  assert.equal(quick.status, 201);
  assert.deepEqual(quick.body.missing_fields, ['estimate', 'epic']);
  const gaps = await s.call('GET', '/api/tasks?project=RF&missing_fields=true');
  const keys = gaps.body.map((t) => t.key);
  assert.ok(keys.includes(quick.body.key));
  assert.ok(gaps.body.every((t) => t.missing_fields.length));
  const viaMcp = await s.rpc('list_tasks', { project: 'RF', missing_fields: true });
  assert.deepEqual(viaMcp.map((t) => t.key), keys);
  // Filling the gaps clears the flag.
  const fixed = await s.director('PATCH', `/api/tasks/${quick.body.key}`, { estimate: 2, epic });
  assert.equal(fixed.body.missing_fields, undefined);
});

// Required fields gate readiness (entering todo), not capture into backlog.
test('a backlog task may lack required fields: it is created with missing_fields and a warning', async () => {
  await s.director('POST', '/api/projects', { key: 'RB', required_fields: ['priority', 'estimate', 'criteria'], allowed_estimates: [1, 2, 3, 5, 8] });
  const note = await s.call('POST', '/api/tasks', { project: 'RB', title: 'streak thing felt wrong on phone??', labels: ['playtest'] });
  assert.equal(note.status, 201);
  assert.equal(note.body.status, 'backlog');
  assert.deepEqual(note.body.missing_fields, ['estimate', 'criteria']);
  assert.deepEqual(note.body.warnings, ['Needs estimate, criteria before it can move to todo.']);
  const viaMcp = await s.rpc('create_task', { project: 'RB', title: 'capture from MCP' });
  assert.deepEqual(viaMcp.warnings, ['Needs estimate, criteria before it can move to todo.']);
  // A complete task has no warning.
  const full = await s.call('POST', '/api/tasks', { project: 'RB', title: 'sized', estimate: 2, criteria: ['works'] });
  assert.equal(full.body.warnings, undefined);

  // list_tasks with missing_fields still finds them.
  const gaps = (await s.call('GET', '/api/tasks?project=RB&missing_fields=true')).body.map((t) => t.key);
  assert.deepEqual(gaps.sort(), [note.body.key, viaMcp.key].sort());
  assert.deepEqual((await s.rpc('list_tasks', { project: 'RB', missing_fields: true })).map((t) => t.key).sort(), gaps.sort());
});

test('moving to todo with missing required fields is a 400 naming them; filling them in first works', async () => {
  const key = (await s.call('POST', '/api/tasks', { project: 'RB', title: 'unsized' })).body.key;
  for (const res of [
    await s.call('POST', `/api/tasks/${key}/move`, { status: 'todo' }),
    await s.call('PATCH', `/api/tasks/${key}`, { status: 'todo' }),
  ]) {
    assert.equal(res.status, 400);
    assert.match(res.body.error, new RegExp(`^${key} needs estimate, criteria before it can move to todo \\(required in RB: priority, estimate, criteria; estimate one of 1, 2, 3, 5, 8\\)`));
    assert.deepEqual(res.body.missing, ['estimate', 'criteria']);
  }
  assert.match((await s.rpc('move_task', { task: key, status: 'todo' })).error, /needs estimate, criteria/);
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.status, 'backlog', 'nothing moved');
  // Setting the fields and the status in one update is fine.
  const ready = await s.call('PATCH', `/api/tasks/${key}`, { estimate: 3, criteria: ['Streak shows on the phone'], status: 'todo' });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'todo');
  // The Director stays exempt, as on create.
  const board = (await s.call('POST', '/api/tasks', { project: 'RB', title: 'director pulls it in' })).body.key;
  assert.equal((await s.director('POST', `/api/tasks/${board}/move`, { status: 'todo' })).status, 200);
});

test('an update that clears a required field returns the readiness warning', async () => {
  const key = (await s.call('POST', '/api/tasks', { project: 'RB', title: 'sized', estimate: 2, criteria: ['works'] })).body.key;
  const cleared = await s.call('PATCH', `/api/tasks/${key}`, { criteria: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.missing_fields, ['criteria']);
  assert.deepEqual(cleared.body.warnings, ['Needs criteria before it can move to todo.']);
  assert.deepEqual((await s.rpc('update_task', { task: key, estimate: null })).warnings, ['Needs estimate, criteria before it can move to todo.']);
  // Editing something else doesn't repeat it.
  assert.equal((await s.call('PATCH', `/api/tasks/${key}`, { title: 'renamed' })).body.warnings, undefined);
});

test('create_tasks names every failing item in one error, grouped by message, and creates nothing', async () => {
  await s.director('POST', '/api/projects', { key: 'RG', protected_paths: [{ glob: 'golden/**', unlock_label: 'golden-change' }] });
  const before = (await s.call('GET', '/api/tasks?project=RG')).body.length;
  const items = [
    { project: 'RG', title: 'ok' },
    { project: 'RG', title: 'a', labels: ['golden-change'] },
    { project: 'RG', title: 'b', labels: ['golden-change'] },
    { project: 'RG', title: 'c', estimate: 'lots' },
    { project: 'RG', title: 'd', labels: ['golden-change'] },
  ];
  const res = await s.call('POST', '/api/tasks/bulk', { tasks: items });
  assert.equal(res.status, 403);
  const lines = res.body.error.split('\n');
  assert.match(lines[0], /^tasks\[1\], tasks\[2\], tasks\[4\]: Only the Director can add the label "golden-change"/);
  assert.match(lines[1], /^tasks\[3\]: estimate must be a whole number/);
  assert.deepEqual(res.body.errors.map((e) => e.index), [1, 2, 3, 4]);
  assert.equal((await s.call('GET', '/api/tasks?project=RG')).body.length, before);
  const viaMcp = await s.rpc('create_tasks', { tasks: items });
  assert.match(viaMcp.error, /tasks\[1\], tasks\[2\], tasks\[4\]: Only the Director/);
  // A reference to a failed item says so.
  const ref = await s.call('POST', '/api/tasks/bulk', { tasks: [{ project: 'RG', title: 'x', labels: ['golden-change'] }, { project: 'RG', title: 'y', depends_on: ['#0'] }] });
  assert.match(ref.body.error, /tasks\[1\]: Batch reference #0 points to an item that failed/);
});

test("claiming an unready backlog task is a 400, and a release never puts one in To Do", async () => {
  const unsized = (await s.call('POST', '/api/tasks', { project: 'RB', title: 'grab it from backlog' })).body.key;
  const claim = await s.call('POST', `/api/tasks/${unsized}/claim`, {}, 'agent-a');
  assert.equal(claim.status, 400);
  assert.match(claim.body.error, new RegExp(`^${unsized} needs estimate, criteria before it can be claimed \\(required in RB`));
  assert.deepEqual(claim.body.missing, ['estimate', 'criteria']);
  assert.match((await s.rpc('claim_task', { task: unsized })).error, /needs estimate, criteria before it can be claimed/);
  const still = (await s.call('GET', `/api/tasks/${unsized}`)).body;
  assert.deepEqual([still.status, still.assignee], ['backlog', null], 'nothing claimed');
  // A ready backlog task can still be claimed straight away, and the Director is exempt.
  const sized = (await s.call('POST', '/api/tasks', { project: 'RB', title: 'sized backlog', estimate: 1, criteria: ['ok'] })).body.key;
  assert.equal((await s.call('POST', `/api/tasks/${sized}/claim`, {}, 'agent-a')).status, 200);
  assert.equal((await s.call('POST', `/api/tasks/${unsized}/claim`, { agent: 'human' }, 'human', { role: 'director' })).status, 200);

  // A held task whose field was cleared: the warning says it isn't ready; releasing it can't reach To Do.
  for (const via of ['http', 'mcp']) {
    const key = (await s.call('POST', '/api/tasks', { project: 'RB', title: `held ${via}`, status: 'todo', priority: 'medium', estimate: 2, criteria: ['works'] })).body.key;
    const agent = via === 'http' ? 'agent-a' : 'mcp-agent';
    assert.equal((await s.call('POST', `/api/tasks/${key}/claim`, {}, agent)).status, 200);
    const cleared = await s.call('PATCH', `/api/tasks/${key}`, { criteria: [] }, agent);
    assert.deepEqual(cleared.body.warnings, ['Needs criteria to be ready.']);
    if (via === 'http') {
      const toTodo = await s.call('POST', `/api/tasks/${key}/release`, { status: 'todo' }, agent);
      assert.equal(toTodo.status, 400);
      assert.match(toTodo.body.error, new RegExp(`^${key} needs criteria before it can move to todo`));
      const plain = await s.call('POST', `/api/tasks/${key}/release`, {}, agent);
      assert.equal(plain.status, 200);
      assert.deepEqual([plain.body.status, plain.body.assignee], ['backlog', null]);
      assert.deepEqual(plain.body.warnings, ['Released to backlog, not todo: Needs criteria before it can move to todo.']);
    } else {
      assert.match((await s.rpc('release_task', { task: key, status: 'todo' })).error, /needs criteria before it can move to todo/);
      const plain = await s.rpc('release_task', { task: key });
      assert.deepEqual(plain.warnings, ['Released to backlog, not todo: Needs criteria before it can move to todo.']);
      assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.status, 'backlog');
    }
    const next = await s.call('POST', '/api/projects/RB/claim-next', { new_only: true }, 'agent-b');
    assert.notEqual(next.body.task?.key, key, 'claim-next never hands it out');
  }
  // A ready task still goes back to To Do on a plain release.
  const ready = (await s.call('POST', '/api/tasks', { project: 'RB', title: 'ready', status: 'todo', priority: 'medium', estimate: 2, criteria: ['works'] })).body.key;
  await s.call('POST', `/api/tasks/${ready}/claim`, {}, 'agent-c');
  const back = await s.call('POST', `/api/tasks/${ready}/release`, {}, 'agent-c');
  assert.deepEqual([back.body.status, back.body.warnings], ['todo', undefined]);
});
