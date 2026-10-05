import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'IN' });
});
after(() => s.close());

test('an empty inbox', async () => {
  assert.deepEqual((await s.call('GET', '/api/projects/IN/inbox')).body, { project: 'IN', count: 0, items: [] });
});

test('the inbox lists questions, reviews, prerequisites and unblocked gates, oldest first', async () => {
  const [setup, dep, gate, blockedGate, work] = (
    await s.director('POST', '/api/tasks/bulk', {
      tasks: [
        { project: 'IN', title: 'Unity shell', status: 'todo', prerequisites: ['Install Unity 6', '[x] Sign in'] },
        { project: 'IN', title: 'Rules', status: 'todo' },
        { project: 'IN', title: 'Gate G1', status: 'todo', assignee: 'director', depends_on: ['#1'] },
        { project: 'IN', title: 'Gate G2', status: 'todo', assignee: 'Director', depends_on: ['#0'] },
        { project: 'IN', title: 'Feature', status: 'todo', criteria: ['[director] Feels good on the phone', 'tests pass'] },
      ],
    })
  ).body;
  await s.call('POST', `/api/tasks/${dep.key}/questions`, { question: 'Which rule wins?', options: ['a', 'b'] }, 'agent');
  await s.call('POST', `/api/tasks/${work.key}/claim`, {}, 'agent');
  await s.call('POST', `/api/tasks/${work.key}/submit`, { summary: 'done' }, 'agent');

  let inbox = (await s.call('GET', '/api/projects/IN/inbox')).body;
  assert.deepEqual(inbox.items.map((i) => [i.kind, i.task]), [
    ['prerequisite', setup.key],
    ['question', dep.key],
    ['review', work.key],
  ], 'G1 waits on Rules; G2 waits on the setup task');
  assert.equal(inbox.count, 3);
  const [pre, question, review] = inbox.items;
  assert.deepEqual(pre.prerequisites.map(({ added_at, ...p }) => p), [{ text: 'Install Unity 6', done: false, index: 0 }]);
  assert.equal(pre.since, pre.prerequisites[0].added_at);
  assert.equal(question.question.question, 'Which rule wins?');
  assert.equal(review.director_items_open, 1);
  assert.ok(inbox.items.every((i, n) => n === 0 || inbox.items[n - 1].since <= i.since), 'oldest first');

  // Rules done → G1 is unblocked and becomes a gate item; answering and ticking clear theirs.
  await s.director('POST', `/api/tasks/${dep.key}/move`, { status: 'done' });
  await s.director('POST', `/api/questions/${question.question.id}/answer`, { option: 0 });
  await s.director('POST', `/api/tasks/${setup.key}/prerequisites`, { items: [0] });
  inbox = (await s.call('GET', '/api/projects/IN/inbox')).body;
  assert.deepEqual(inbox.items.map((i) => [i.kind, i.task]).sort(), [
    ['gate', gate.key],
    ['review', work.key],
  ].sort(), 'G2 still waits: its dependency (the setup task) is not done, only unblocked');
  assert.ok(!inbox.items.some((i) => i.task === blockedGate.key));

  // The board user's own name counts as the Director too.
  const mine = await s.call('POST', '/api/tasks', { project: 'IN', title: 'Record trailer', status: 'todo', assignee: 'Alex' });
  const withMe = (await s.call('GET', '/api/projects/IN/inbox?me=alex')).body;
  assert.ok(withMe.items.some((i) => i.task === mine.body.key && i.kind === 'gate'));
});

test('a prerequisite item dates from when the prerequisite was added, not the task', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'IN', title: 'Old task', status: 'todo' });
  await new Promise((r) => setTimeout(r, 15));
  const added = await s.call('PATCH', `/api/tasks/${t.body.key}`, { prerequisites: ['Plug in the phone'] });
  const item = (await s.call('GET', '/api/projects/IN/inbox')).body.items.find((i) => i.task === t.body.key);
  assert.equal(item.since, added.body.prerequisites[0].added_at);
  assert.ok(item.since > t.body.created_at);
});

test('a decision recorded with empty tags (as the Inbox sends) gets the task labels and epic', async () => {
  const epic = await s.call('POST', '/api/projects/IN/epics', { title: 'Combat' });
  const t = await s.call('POST', '/api/tasks', { project: 'IN', title: 'Sparks', status: 'todo', labels: ['sim'], epic: epic.body.key });
  const q = await s.call('POST', `/api/tasks/${t.body.key}/questions`, { question: '3 or 2?', options: ['3', '2'] }, 'agent');
  const answered = await s.director('POST', `/api/questions/${q.body.id}/answer`, {
    option: 0,
    record_decision: true,
    decision: { title: 'Sparks per beat', rationale: '', tags: [] },
  });
  assert.equal(answered.status, 200);
  const decisions = (await s.call('GET', '/api/projects/IN/decisions')).body;
  const d = (decisions.decisions ?? decisions).find((x) => x.title === 'Sparks per beat');
  assert.deepEqual(d.tags, ['sim', epic.body.key]);
  const briefing = await s.call('POST', `/api/tasks/${t.body.key}/claim`, {}, 'agent');
  assert.ok(briefing.body.decisions.some((x) => x.id === d.id), 'it reaches its source task briefing');
});
