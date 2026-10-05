import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// claim_next_task hands an agent back a held task whose question was just answered, and lists the
// rest of what it holds (held) instead of handing it out, since a parallel session may be working it.
let s;
before(async () => {
  s = await startServer();
});
after(() => s.close());

let n = 0;
const project = async () => {
  const key = `RS${++n}`;
  await s.director('POST', '/api/projects', { key, agent_brief: 'Run npm test.' });
  return key;
};
const task = async (key, fields = {}) => (await s.director('POST', '/api/tasks', { project: key, title: 't', status: 'todo', ...fields })).body.key;
const next = (key, agent = 'agent-a', body = {}) => s.call('POST', `/api/projects/${key}/claim-next`, body, agent);

test('held tasks are listed, not handed out: the caller gets new work and held [{key, title, last_activity_at}]', async () => {
  const p = await project();
  const mine = await task(p, { priority: 'low', title: 'mine' });
  await s.call('POST', `/api/tasks/${mine}/claim`, {}, 'agent-a');
  const shiny = await task(p, { priority: 'urgent', title: 'shiny new work' });

  const res = (await next(p)).body;
  assert.equal(res.task.key, shiny);
  assert.equal(res.task.resumed, undefined);
  assert.equal(res.task.agent_brief, 'Run npm test.');
  assert.equal(res.held.length, 1);
  assert.deepEqual(Object.keys(res.held[0]), ['key', 'title', 'last_activity_at']);
  assert.deepEqual([res.held[0].key, res.held[0].title], [mine, 'mine']);
  assert.equal((await s.call('GET', `/api/tasks/${mine}`)).body.assignee, 'agent-a', 'still held');

  // Nothing left: held comes with the empty claim too, newest activity first; MCP carries it as well.
  await s.call('POST', `/api/tasks/${mine}/comments`, { body: 'still going' }, 'agent-a');
  const empty = await s.rpc('claim_next_task', { project: p, agent: 'agent-a' });
  assert.equal(empty.task, null);
  assert.deepEqual(empty.held.map((h) => h.key), [mine, shiny]);
  // A caller that holds nothing gets no held field.
  assert.equal((await next(p, 'agent-z')).body.held, undefined);
  // Picking one back up is deliberate: claim_task on your own task returns its briefing.
  assert.equal((await s.call('POST', `/api/tasks/${mine}/claim`, {}, 'agent-a')).body.key, mine);
});

test('a held task whose blocking question was answered since the holder last acted comes back by itself', async () => {
  const p = await project();
  const older = await task(p);
  const parked = await task(p);
  await s.call('POST', `/api/tasks/${older}/claim`, {}, 'agent-a');
  await s.call('POST', `/api/tasks/${parked}/claim`, {}, 'agent-a');
  const q = (await s.call('POST', `/api/tasks/${parked}/questions`, { question: 'Export CSV or JSON?\nDetails…', options: ['CSV', 'JSON'] }, 'agent-a')).body;
  const free = await task(p, { priority: 'low' });

  const waiting = (await next(p)).body;
  assert.equal(waiting.task.key, free, 'nothing is resumed while the question is open');
  const parkedEntry = waiting.held.find((h) => h.key === parked);
  assert.equal(parkedEntry.waiting_on_director, true);

  await s.director('POST', `/api/questions/${q.id}/answer`, { option: 'JSON' });
  const back = (await next(p)).body;
  assert.equal(back.task.key, parked, 'answered: handed back');
  assert.equal(back.task.resumed, true);
  assert.equal(back.task.questions[0].answer, 'JSON');
  assert.match(back.task.comments.at(-1).body, /Director answered/);
  assert.deepEqual(back.held.map((h) => h.key).sort(), [older, free].sort());

  // Once resumed, it's acted on: the next call doesn't hand it out again.
  const after = (await next(p)).body;
  assert.equal(after.task, null);
  assert.ok(after.held.some((h) => h.key === parked));
});

test('two sessions sharing one agent name never get the same task', async () => {
  const p = await project();
  const first = await task(p, { priority: 'high', title: 'PS-1' });
  const second = await task(p, { priority: 'low', title: 'PS-2' });
  // Session 1 claims and works; seconds later session 2 (same X-Agent) asks for work.
  const one = (await next(p, 'claude-code')).body.task;
  assert.equal(one.key, first);
  await s.call('POST', `/api/tasks/${first}/comments`, { body: 'starting' }, 'claude-code');
  const two = await s.rpc('claim_next_task', { project: p }, 'claude-code');
  assert.equal(two.task.key, second, 'session 2 gets the free card, not session 1\'s');
  assert.deepEqual(two.held.map((h) => h.key), [first]);

  // An answered question goes to exactly one of them: whichever asks first resumes it.
  const parked = await task(p, { title: 'parked' });
  await s.call('POST', `/api/tasks/${parked}/claim`, {}, 'claude-code');
  const q = (await s.call('POST', `/api/tasks/${parked}/questions`, { question: 'A or B?' }, 'claude-code')).body;
  const spare = await task(p, { priority: 'low', title: 'spare' });
  await s.director('POST', `/api/questions/${q.id}/answer`, { answer: 'A' });
  const a = (await next(p, 'claude-code')).body.task;
  const b = (await s.rpc('claim_next_task', { project: p }, 'claude-code')).task;
  assert.deepEqual([a.key, a.resumed], [parked, true]);
  assert.equal(b.key, spare);
  assert.equal(b.resumed, undefined);
});

test('an empty claim lists the caller\'s parked tasks in reasons; other agents never see them', async () => {
  const p = await project();
  const parked = await task(p, { title: 'export' });
  await s.call('POST', `/api/tasks/${parked}/claim`, {}, 'agent-a');
  await s.call('POST', `/api/tasks/${parked}/questions`, { question: 'The task says to export all rows.\nBut docs say 100.' }, 'agent-a');
  const blocked = await task(p, { prerequisites: ['Set up the repo'] });

  const res = (await next(p)).body;
  assert.equal(res.task, null);
  assert.equal(res.reasons[0].key, parked);
  assert.match(res.reasons[0].why, /^yours, waiting on the Director: "The task says to export all rows\." \(asked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/);
  assert.equal(res.reasons[1].key, blocked);

  const other = (await next(p, 'agent-b')).body;
  assert.equal(other.task, null);
  assert.deepEqual(other.reasons.map((r) => r.key), [blocked], "agent-b isn't shown agent-a's task");
  assert.equal(other.held, undefined);

  // The filters apply to parked tasks too: one outside them isn't listed in reasons (held still has it).
  const filtered = (await next(p, 'agent-a', { labels: ['audio'] })).body;
  assert.ok(!filtered.reasons.some((r) => r.key === parked));
  assert.deepEqual(filtered.held.map((h) => h.key), [parked]);
});

test("other agents' results are unchanged: nobody is offered a task someone else holds", async () => {
  const p = await project();
  const held = await task(p, { priority: 'urgent' });
  await s.call('POST', `/api/tasks/${held}/claim`, {}, 'agent-a');
  const free = await task(p, { priority: 'low' });
  const got = (await next(p, 'agent-b')).body.task;
  assert.equal(got.key, free);
  assert.equal(got.resumed, undefined);
  assert.equal((await next(p, 'agent-c')).body.task, null);
  assert.equal((await s.call('GET', `/api/tasks/${held}`)).body.assignee, 'agent-a');
});

test('a blocking ask_director response says the asker keeps the claim and how it comes back', async () => {
  const p = await project();
  const key = await task(p);
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'mcp-agent');
  const asked = await s.rpc('ask_director', { task: key, question: 'A or B?' });
  assert.equal(asked.task, key, 'the question still names its task');
  assert.deepEqual(asked.parked, {
    task: key,
    status: 'in_progress',
    note: "You keep the claim; claim_next_task returns it to you once it's answered. Do other work meanwhile.",
  });
  const fyi = await s.rpc('ask_director', { task: key, question: 'FYI', blocking: false });
  assert.equal(fyi.parked, undefined);
  const open = await task(p);
  const unheld = await s.rpc('ask_director', { task: open, question: 'Which?' });
  assert.equal(unheld.parked.note, 'Nobody can claim it until the Director answers.');
});
