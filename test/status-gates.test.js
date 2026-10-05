import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// Each status has one door for agents: in_progress through a claim, review through submit_for_review,
// done through the holder's move (or the Director's verdict when the handoff flagged a problem). Nobody moves a task another agent holds.
let s;
before(async () => {
  s = await startServer();
  await s.director('POST', '/api/projects', { key: 'SG' });
});
after(() => s.close());

const agent = (method, path, body, name = 'agent-a') => s.call(method, path, body, name);
const task = async (fields = {}) => (await s.director('POST', '/api/tasks', { project: 'SG', title: 't', status: 'todo', ...fields })).body.key;
const status = async (key) => (await s.call('GET', `/api/tasks/${key}`)).body.status;
const inReview = async (holder = 'agent-a', handoff = {}) => {
  const key = await task();
  await agent('POST', `/api/tasks/${key}/claim`, {}, holder);
  assert.equal((await agent('POST', `/api/tasks/${key}/submit`, { summary: 'done', ...handoff }, holder)).status, 200);
  return key;
};

test('review verdicts are the Director\'s: agents get 403 over HTTP, and MCP has no review_task', async () => {
  const key = await inReview();
  for (const verdict of ['accept', 'changes']) {
    const res = await agent('POST', `/api/tasks/${key}/review`, { verdict, feedback: 'lgtm' });
    assert.equal(res.status, 403, verdict);
    assert.equal(res.body.error, "Only the Director can accept or send back work (from the board). Tell the human it's ready.");
  }
  assert.equal(await status(key), 'review', 'an agent accepting its own submission no longer lands it in done');

  const tools = (await s.mcp('tools/list')).tools.map((t) => t.name);
  assert.ok(!tools.includes('review_task'));
  assert.ok(tools.includes('get_review_queue'));
  const call = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent': 'agent-a' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'review_task', arguments: { task: key, verdict: 'accept' } } }),
  });
  assert.match((await call.json()).error.message, /Unknown tool: review_task/);

  const sent = await s.director('POST', `/api/tasks/${key}/review`, { verdict: 'changes', feedback: 'One more thing' });
  assert.equal(sent.body.status, 'todo');
  assert.equal(sent.body.rework, true);
  await agent('POST', `/api/tasks/${key}/claim`, {});
  await agent('POST', `/api/tasks/${key}/submit`, { summary: 'fixed' });
  assert.equal((await s.director('POST', `/api/tasks/${key}/review`, { verdict: 'accept' })).body.status, 'done');
});

test('an agent moving flagged work in review to done gets the verdict 403, by move, update and release', async () => {
  const key = await inReview('agent-a', { checks: [{ name: 'lint', passed: false }] });
  const msg = "Only the Director can accept or send back work (from the board). Tell the human it's ready. The handoff flagged: Check \"lint\" failed.";
  const move = await agent('POST', `/api/tasks/${key}/move`, { status: 'done' });
  assert.deepEqual([move.status, move.body.error], [403, msg]);
  const patch = await agent('PATCH', `/api/tasks/${key}`, { status: 'done' });
  assert.deepEqual([patch.status, patch.body.error], [403, msg]);
  const release = await agent('POST', `/api/tasks/${key}/release`, { status: 'done' });
  assert.deepEqual([release.status, release.body.error], [403, msg]);
  assert.match((await s.rpc('move_task', { task: key, status: 'done', agent: 'agent-a' })).error, /Only the Director can accept/);
  assert.equal(await status(key), 'review');
});

test('in_progress only through a claim: move, update and release return 409 naming claim_task', async () => {
  const key = await task({ prerequisites: ['Create the GitHub repository'] });
  for (const res of [
    await agent('POST', `/api/tasks/${key}/move`, { status: 'in_progress' }),
    await agent('PATCH', `/api/tasks/${key}`, { status: 'in_progress' }),
    await agent('POST', `/api/tasks/${key}/release`, { status: 'in_progress' }),
  ]) {
    assert.equal(res.status, 409);
    assert.match(res.body.error, new RegExp(`Claim it instead \\(claim_task ${key}\\)`));
  }
  assert.match((await s.rpc('move_task', { task: key, status: 'in_progress' })).error, /claim_task/);
  assert.equal(await status(key), 'todo', 'the prerequisite still guards it');
  assert.equal((await agent('POST', `/api/tasks/${key}/claim`, {})).status, 409, 'and the claim says why');
});

test('review only through submit_for_review: other routes return 409', async () => {
  const key = await task();
  await agent('POST', `/api/tasks/${key}/claim`, {});
  for (const res of [
    await agent('POST', `/api/tasks/${key}/move`, { status: 'review' }),
    await agent('PATCH', `/api/tasks/${key}`, { status: 'review' }),
    await agent('POST', `/api/tasks/${key}/release`, { status: 'review' }),
  ]) {
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Use submit_for_review/);
  }
  assert.equal(await status(key), 'in_progress');
  const t = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(t.handoff, null);
});

test('the holder closes its own task once its criteria are ticked, unless the Director must check it', async () => {
  const plain = await task({ criteria: ['works'] });
  const unclaimed = await agent('POST', `/api/tasks/${plain}/move`, { status: 'done' });
  assert.equal(unclaimed.status, 409);
  assert.match(unclaimed.body.error, /isn't claimed\. Claim it first/);
  await agent('POST', `/api/tasks/${plain}/claim`, {});
  assert.equal((await agent('POST', `/api/tasks/${plain}/move`, { status: 'done' }, 'agent-b')).status, 403, 'not by another agent');
  const unticked = await agent('POST', `/api/tasks/${plain}/move`, { status: 'done' });
  assert.equal(unticked.status, 409);
  assert.match(unticked.body.error, /Tick SG-\d+'s criteria with evidence first \(check_criteria\): works/);
  assert.deepEqual(unticked.body.unchecked_criteria, ['works']);
  await agent('POST', `/api/tasks/${plain}/criteria`, { items: [0], evidence: 'test passes' });
  const closed = await s.rpc('move_task', { task: plain, status: 'done', agent: 'agent-a' });
  assert.equal(closed.status, 'done');

  // Open Director criteria need the human: submit instead. Once the Director ticks them, the holder may close it.
  const director = await task({ criteria: [{ text: 'feels right', owner: 'human' }] });
  await agent('POST', `/api/tasks/${director}/claim`, {});
  for (const res of [
    await agent('POST', `/api/tasks/${director}/move`, { status: 'done' }),
    await agent('PATCH', `/api/tasks/${director}`, { status: 'done' }),
    await agent('POST', `/api/tasks/${director}/release`, { status: 'done' }),
  ]) {
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Director criteria the human must check: feels right\. Submit it with submit_for_review/);
  }
  await s.director('POST', `/api/tasks/${director}/criteria`, { items: [0] });
  assert.equal((await agent('POST', `/api/tasks/${director}/move`, { status: 'done' })).status, 200);

  // Only the Director marks a task as needing review; then its holder must submit it.
  const flagged = await task();
  assert.equal((await agent('PATCH', `/api/tasks/${flagged}`, { needs_review: true })).status, 403);
  assert.equal((await agent('POST', '/api/tasks', { project: 'SG', title: 'x', needs_review: true })).status, 403);
  assert.equal((await s.call('GET', `/api/tasks/${flagged}`)).body.needs_review, false);
  assert.equal((await s.director('PATCH', `/api/tasks/${flagged}`, { needs_review: true })).body.needs_review, true);
  await agent('POST', `/api/tasks/${flagged}/claim`, {});
  const refused = await agent('POST', `/api/tasks/${flagged}/move`, { status: 'done' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /The Director wants to review SG-\d+\. Submit it with submit_for_review/);
  const created = await task({ needs_review: true });
  assert.equal((await s.call('GET', `/api/tasks/${created}`)).body.needs_review, true);

  // Work in review needs the Director only when its handoff flagged a problem.
  const submitted = await inReview();
  assert.equal((await agent('POST', `/api/tasks/${submitted}/move`, { status: 'done' }, 'agent-b')).status, 403, 'not by another agent');
  assert.equal((await agent('POST', `/api/tasks/${submitted}/move`, { status: 'done' })).status, 200);
  const failing = await task();
  await agent('POST', `/api/tasks/${failing}/claim`, {});
  await agent('POST', `/api/tasks/${failing}/submit`, { summary: 'done', checks: [{ name: 'test.sh', passed: false }] });
  const held = await agent('POST', `/api/tasks/${failing}/move`, { status: 'done' });
  assert.equal(held.status, 403);
  assert.match(held.body.error, /Only the Director can accept or send back work.*The handoff flagged: Check "test\.sh" failed\./);
});

test("an agent can't change the status of a task another agent holds (403 naming the holder)", async () => {
  const key = await task();
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  for (const target of ['todo', 'backlog']) {
    for (const res of [
      await agent('POST', `/api/tasks/${key}/move`, { status: target }, 'agent-b'),
      await agent('PATCH', `/api/tasks/${key}`, { status: target }, 'agent-b'),
    ]) {
      assert.equal(res.status, 403, target);
      assert.match(res.body.error, /held by agent-a/);
    }
  }
  assert.equal(await status(key), 'in_progress');
  // Reordering it within its column (no status change) is still fine, and so is its holder parking it.
  assert.equal((await agent('POST', `/api/tasks/${key}/move`, { status: 'in_progress', index: 0 }, 'agent-b')).status, 200);
  assert.equal((await agent('POST', `/api/tasks/${key}/move`, { status: 'todo' }, 'agent-a')).status, 200);
});

test("an agent can't reassign or unassign a task another agent holds, by update or import", async () => {
  const key = await task({ external_id: 'SG-EXT-1' });
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  const held = /held by agent-a\. Pass agent: "agent-a" if that's you, or claim it first\./;
  for (const assignee of [null, 'agent-b']) {
    const res = await agent('PATCH', `/api/tasks/${key}`, { assignee }, 'agent-b');
    assert.deepEqual([res.status, held.test(res.body.error)], [403, true], `PATCH assignee ${assignee}`);
    assert.match((await s.rpc('update_task', { task: key, assignee }, 'agent-b')).error, held, `MCP assignee ${assignee}`);
    const imported = await agent('POST', '/api/projects/SG/import', { tasks: [{ external_id: 'SG-EXT-1', assignee }] }, 'agent-b');
    assert.deepEqual([imported.status, held.test(imported.body.error)], [403, true], `import assignee ${assignee}`);
    assert.match((await s.rpc('import_tasks', { project: 'SG', tasks: [{ external_id: 'SG-EXT-1', assignee }] }, 'agent-b')).error, held);
  }
  const after = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.deepEqual([after.status, after.assignee], ['in_progress', 'agent-a']);
  // Its other fields stay editable, and planners may still assign unassigned work.
  assert.equal((await agent('PATCH', `/api/tasks/${key}`, { labels: ['x'] }, 'agent-b')).status, 200);
  const open = await task();
  assert.equal((await agent('PATCH', `/api/tasks/${open}`, { assignee: 'agent-c' }, 'agent-b')).body.assignee, 'agent-c');
  // The holder may hand its own task off, or let it go.
  assert.equal((await agent('PATCH', `/api/tasks/${key}`, { assignee: 'agent-b' }, 'agent-a')).body.assignee, 'agent-b');
  assert.equal((await s.rpc('update_task', { task: key, assignee: null }, 'agent-b')).assignee, undefined);
  // The Director may reassign anything.
  assert.equal((await s.director('PATCH', `/api/tasks/${key}`, { assignee: 'agent-a' })).body.assignee, 'agent-a');
});

test('agents create and import tasks in backlog or todo only; the other columns keep their doors', async () => {
  const doors = {
    in_progress: [409, /Claim it instead: create it in todo, then claim_task it/],
    review: [409, /Use submit_for_review to put a task in review/],
    done: [403, /Only the Director can create a task in done/],
  };
  for (const [target, [code, msg]] of Object.entries(doors)) {
    const one = await agent('POST', '/api/tasks', { project: 'SG', title: target, status: target });
    assert.deepEqual([one.status, msg.test(one.body.error)], [code, true], `create ${target}`);
    const bulk = await agent('POST', '/api/tasks/bulk', { tasks: [{ project: 'SG', title: 'ok', status: 'todo' }, { project: 'SG', title: target, status: target }] });
    assert.equal(bulk.status, code, `bulk ${target}`);
    assert.match(bulk.body.error, new RegExp(`^tasks\\[1\\]: ${msg.source}`));
    const imported = await agent('POST', '/api/projects/SG/import', { tasks: [{ external_id: `NEW-${target}`, title: target, status: target }] });
    assert.deepEqual([imported.status, msg.test(imported.body.error)], [code, true], `import ${target}`);
    assert.match((await s.rpc('create_task', { project: 'SG', title: target, status: target })).error, msg);
    assert.match((await s.rpc('create_tasks', { tasks: [{ project: 'SG', title: target, status: target }] })).error, msg);
    assert.match((await s.rpc('import_tasks', { project: 'SG', tasks: [{ external_id: `NEW-${target}`, title: target, status: target }] })).error, msg);
  }
  const titles = (await s.call('GET', '/api/tasks?project=SG')).body.map((t) => t.title);
  assert.ok(!Object.keys(doors).some((d) => titles.includes(d)), 'none of them was created');
  assert.ok(!titles.includes('ok'), 'a batch is still all or nothing');
  // Backlog and todo stay open, and the Director may create (or import) a card in any column.
  for (const target of ['backlog', 'todo']) {
    assert.equal((await agent('POST', '/api/tasks', { project: 'SG', title: target, status: target })).body.status, target);
  }
  for (const target of Object.keys(doors)) {
    assert.equal((await s.director('POST', '/api/tasks', { project: 'SG', title: `d-${target}`, status: target })).body.status, target);
  }
  const done = await s.director('POST', '/api/projects/SG/import', { tasks: [{ external_id: 'OLD-1', title: 'shipped', status: 'done' }] });
  assert.equal(done.body.created.length, 1);
});

test('backlog and todo stay open for planning on unassigned tasks', async () => {
  const key = await task({ status: 'backlog' });
  assert.equal((await agent('POST', `/api/tasks/${key}/move`, { status: 'todo' })).body.status, 'todo');
  assert.equal((await agent('PATCH', `/api/tasks/${key}`, { status: 'backlog' }, 'agent-b')).body.status, 'backlog');
  assert.equal((await s.rpc('move_task', { task: key, status: 'todo' })).status, 'todo');
});

test('release: only the holder, unless an agent forces an abandoned claim free', async () => {
  const key = await task();
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  const conflict = await agent('POST', `/api/tasks/${key}/release`, {}, 'agent-b');
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /claimed by agent-a, not agent-b\. Only its holder releases it; if agent-a abandoned it, pass force: true\./);
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.assignee, 'agent-a');
  const forced = await agent('POST', `/api/tasks/${key}/release`, { force: true }, 'agent-b');
  assert.deepEqual([forced.status, forced.body.assignee, forced.body.status], [200, null, 'todo']);
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  assert.equal((await s.rpc('release_task', { task: key, agent: 'agent-b', force: true })).status, 'todo', 'MCP takes force too');
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  const director = await s.director('POST', `/api/tasks/${key}/release`, { force: true });
  assert.deepEqual([director.status, director.body.assignee, director.body.status], [200, null, 'todo']);
  // The holder releasing to todo or backlog is unchanged.
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a');
  assert.equal((await agent('POST', `/api/tasks/${key}/release`, { status: 'backlog' }, 'agent-a')).body.status, 'backlog');
});

test("the Director's moves on the board are unchanged: every column, any holder", async () => {
  const key = await task({ prerequisites: ['setup'] });
  await agent('POST', `/api/tasks/${key}/claim`, {}, 'agent-a').catch(() => {});
  for (const target of ['in_progress', 'review', 'done', 'todo', 'backlog', 'done']) {
    const res = await s.director('POST', `/api/tasks/${key}/move`, { status: target });
    assert.deepEqual([res.status, res.body.status], [200, target]);
  }
  const held = await task();
  await agent('POST', `/api/tasks/${held}/claim`, {}, 'agent-b');
  assert.equal((await s.director('PATCH', `/api/tasks/${held}`, { status: 'done' })).body.status, 'done');
});

test("deleting: agents get 403 on another agent's task and on review or done; their own and unassigned ones stay open", async () => {
  const exists = async (key) => (await s.call('GET', `/api/tasks/${key}`)).status === 200;

  const held = await task();
  await agent('POST', `/api/tasks/${held}/claim`, {}, 'agent-b');
  const other = await agent('DELETE', `/api/tasks/${held}`);
  assert.equal(other.status, 403);
  assert.equal(other.body.error, `${held} is held by agent-b. Pass agent: "agent-b" if that's you, or claim it first.`);
  assert.ok(await exists(held));

  const reviewed = await inReview('agent-a');
  const review = await agent('DELETE', `/api/tasks/${reviewed}`, undefined, 'agent-a');
  assert.deepEqual(
    [review.status, review.body.error],
    [403, 'Only the Director can delete a task in review (from the board). To propose it, ask_director on your task.'],
  );
  assert.ok(await exists(reviewed), 'its holder cannot drop a submission either');
  const finished = await task({ status: 'done' });
  const done = await agent('DELETE', `/api/tasks/${finished}`);
  assert.deepEqual([done.status, done.body.error], [403, 'Only the Director can delete a task in done (from the board). To propose it, ask_director on your task.']);
  assert.ok(await exists(finished));

  const own = await task();
  await agent('POST', `/api/tasks/${own}/claim`, {});
  for (const key of [own, await task(), await task({ status: 'backlog' })]) {
    assert.deepEqual((await agent('DELETE', `/api/tasks/${key}`)).body, { deleted: key });
    assert.ok(!(await exists(key)));
  }

  for (const key of [held, reviewed, finished]) {
    assert.deepEqual((await s.director('DELETE', `/api/tasks/${key}`)).body, { deleted: key }, 'the Director can delete anything');
  }
});

test("deleting attachments: agents get 403 on another agent's task and on review or done; their own and unassigned ones stay open", async () => {
  const attach = async (key) => {
    const res = await fetch(`${s.base}/api/tasks/${key}/attachments?filename=shot.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-agent': 'agent-a' },
      body: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    return (await res.json()).id;
  };
  const exists = async (id) => (await s.call('GET', `/api/attachments/${id}`)).status === 200;

  const held = await task();
  await agent('POST', `/api/tasks/${held}/claim`, {}, 'agent-b');
  const heldShot = await attach(held);
  const other = await agent('DELETE', `/api/attachments/${heldShot}`);
  assert.equal(other.status, 403);
  assert.equal(other.body.error, `${held} is held by agent-b. Pass agent: "agent-b" if that's you, or claim it first.`);
  assert.ok(await exists(heldShot));

  const reviewed = await inReview('agent-a');
  const reviewShot = await attach(reviewed);
  const review = await agent('DELETE', `/api/attachments/${reviewShot}`, undefined, 'agent-a');
  assert.deepEqual(
    [review.status, review.body.error],
    [403, 'Only the Director can delete an attachment on a task in review (from the board). To propose it, ask_director on your task.'],
  );
  assert.ok(await exists(reviewShot), 'its holder cannot remove the evidence of a submission either');
  const finished = await task({ status: 'done' });
  const doneShot = await attach(finished);
  const done = await agent('DELETE', `/api/attachments/${doneShot}`);
  assert.deepEqual(
    [done.status, done.body.error],
    [403, 'Only the Director can delete an attachment on a task in done (from the board). To propose it, ask_director on your task.'],
  );
  assert.ok(await exists(doneShot));

  const own = await task();
  await agent('POST', `/api/tasks/${own}/claim`, {});
  for (const key of [own, await task(), await task({ status: 'backlog' })]) {
    const id = await attach(key);
    assert.deepEqual((await agent('DELETE', `/api/attachments/${id}`)).body, { deleted: id, task: key });
    assert.ok(!(await exists(id)));
  }

  for (const [id, key] of [[heldShot, held], [reviewShot, reviewed], [doneShot, finished]]) {
    assert.deepEqual((await s.director('DELETE', `/api/attachments/${id}`)).body, { deleted: id, task: key }, 'the Director can delete any attachment');
    assert.ok(!(await exists(id)));
  }
});

test('agents run the plan: they start, complete and delete sprints, and delete milestones', async () => {
  const sprint = (await agent('POST', '/api/projects/SG/sprints', { name: 'Agent sprint' })).body;
  const milestone = (await agent('POST', '/api/projects/SG/milestones', { name: 'Agent milestone' })).body;
  const scheduled = await task();
  await agent('PATCH', `/api/tasks/${scheduled}`, { sprint: sprint.id, milestone: milestone.id });

  assert.equal((await s.rpc('update_sprint', { sprint: sprint.id, status: 'active' })).status, 'active');
  assert.equal((await agent('PATCH', `/api/sprints/${sprint.id}`, { status: 'completed', carry_over_to: null })).body.status, 'completed');

  assert.deepEqual((await agent('DELETE', `/api/sprints/${sprint.id}`)).body, { deleted: 'Agent sprint', tasks_unscheduled: true });
  assert.deepEqual((await agent('DELETE', `/api/milestones/${milestone.id}`)).body, { deleted: 'Agent milestone', tasks_detached: true });
  assert.equal((await s.call('GET', `/api/sprints/${sprint.id}`)).status, 404);
  assert.equal((await s.call('GET', `/api/milestones/${milestone.id}`)).status, 404);
  const kept = (await s.call('GET', `/api/tasks/${scheduled}`)).body;
  assert.deepEqual([kept.key, kept.sprint, kept.milestone], [scheduled, null, null], 'the task itself stays');
});
