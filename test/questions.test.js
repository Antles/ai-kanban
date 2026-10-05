import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'QD' });
});
after(() => s.close());

test('a blocking question parks the task for everyone but its holder until answered', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'QD', title: 'Spark rules', status: 'todo', priority: 'urgent', labels: ['combat'] });
  const key = t.body.key;
  const asked = await s.call(
    'POST',
    `/api/tasks/${key}/questions`,
    {
      question: 'combat.md says 3 Sparks per beat, economy.md says 2. Which wins?',
      options: ['3 (combat.md)', '2 (economy.md)'],
      recommendation: '3: combat.md is newer',
    },
    'agent-a',
  );
  assert.equal(asked.status, 201);
  assert.equal(asked.body.status, 'open');
  assert.equal(asked.body.blocking, true);
  assert.deepEqual(asked.body.options, ['3 (combat.md)', '2 (economy.md)']);

  const card = await s.call('GET', `/api/tasks/${key}`);
  assert.equal(card.body.waiting_on_director, true);
  assert.equal(card.body.open_questions, 1);

  // The unassigned task is skipped by claim-next and refused by claim.
  const other = await s.call('POST', '/api/tasks', { project: 'QD', title: 'other', status: 'todo', priority: 'low' });
  const next = await s.call('POST', '/api/projects/QD/claim-next', {}, 'agent-b');
  assert.equal(next.body.task.key, other.body.key);
  const direct = await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-b');
  assert.equal(direct.status, 409);
  assert.match(direct.body.error, /waiting on the Director/);

  // Its holder keeps it: pre-assigned to agent-a, claim-next still hands it over.
  await s.director('PATCH', `/api/tasks/${key}`, { assignee: 'agent-a' });
  assert.equal((await s.call('POST', '/api/projects/QD/claim-next', {}, 'agent-c')).body.task, null);
  const holder = await s.call('POST', '/api/projects/QD/claim-next', {}, 'agent-a');
  assert.equal(holder.body.task.key, key);
  await s.call('POST', `/api/tasks/${key}/release`, {}, 'agent-a');

  // Non-blocking questions don't park anything.
  const fyi = await s.call('POST', `/api/tasks/${other.body.key}/questions`, { question: 'FYI ok?', blocking: false }, 'agent-b');
  assert.equal(fyi.body.blocking, false);
  assert.equal((await s.call('GET', `/api/tasks/${other.body.key}`)).body.waiting_on_director, false);
});

test('only the Director answers; the answer is a comment, clears the badge and shows in the briefing', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'QD', title: 'Tray size', status: 'todo', labels: ['ui'] });
  const key = t.body.key;
  const q = await s.call('POST', `/api/tasks/${key}/questions`, { question: 'Tray of 4 or 5?', options: ['4', '5'] }, 'agent-a');

  const denied = await s.call('POST', `/api/questions/${q.body.id}/answer`, { option: 0 }, 'agent-a');
  assert.equal(denied.status, 403);
  assert.equal((await s.director('POST', `/api/questions/${q.body.id}/answer`, { option: 7 })).status, 400);
  assert.equal((await s.director('POST', `/api/questions/${q.body.id}/answer`, {})).status, 400);

  const answered = await s.director('POST', `/api/questions/${q.body.id}/answer`, { option: 1, answer: 'Five fits the portrait width.' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.status, 'answered');
  assert.equal(answered.body.answer, '5\n\nFive fits the portrait width.');
  assert.equal((await s.director('POST', `/api/questions/${q.body.id}/answer`, { option: 0 })).status, 409);

  const claimed = await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent-z');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.waiting_on_director, false);
  assert.equal(claimed.body.questions[0].answer, '5\n\nFive fits the portrait width.');
  const comment = claimed.body.comments.at(-1);
  assert.match(comment.body, /Director answered/);
  assert.match(comment.body, /> Tray of 4 or 5\?/);
  assert.equal(comment.author, 'human');
});

test('recorded Decisions get D-numbers, can be listed and fetched, and reach matching briefings (max 10)', async () => {
  const epic = await s.call('POST', '/api/projects/QD/epics', { title: 'Economy' });
  const src = await s.call('POST', '/api/tasks', { project: 'QD', title: 'Sparks', labels: ['combat'], status: 'todo' });
  const q = await s.call('POST', `/api/tasks/${src.body.key}/questions`, { question: 'Sparks per beat?', options: ['2', '3'] }, 'agent-a');
  const a = await s.director('POST', `/api/questions/${q.body.id}/answer`, {
    option: '3',
    record_decision: true,
    decision: { rationale: 'combat.md is the newer source' },
  });
  assert.equal(a.body.decision, 'D-001');
  const d1 = await s.call('GET', '/api/projects/QD/decisions/D-001');
  assert.equal(d1.body.title, 'Sparks per beat?');
  assert.equal(d1.body.decision, '3');
  assert.equal(d1.body.source_task, src.body.key);
  assert.deepEqual(d1.body.tags, ['combat'], 'defaults to the task labels (and epic)');
  assert.equal((await s.call('GET', '/api/projects/QD/decisions/1')).body.id, 'D-001');

  // Agents can't record decisions directly; the Director can.
  assert.equal((await s.call('POST', '/api/projects/QD/decisions', { title: 'x', decision: 'y' })).status, 403);
  const byEpicTitle = await s.director('POST', '/api/projects/QD/decisions', { title: 'Gold cap', decision: '999', tags: ['economy'] });
  assert.equal(byEpicTitle.body.id, 'D-002');
  for (let i = 0; i < 11; i++) await s.director('POST', '/api/projects/QD/decisions', { title: `ui ${i}`, decision: 'ok', tags: ['UI'] });
  await s.director('POST', '/api/projects/QD/decisions', { title: 'unrelated', decision: 'no', tags: ['audio'] });

  const all = await s.call('GET', '/api/projects/QD/decisions');
  assert.equal(all.body.length, 14);
  assert.equal(all.body[0].id, 'D-014', 'newest first');
  assert.equal((await s.call('GET', '/api/projects/QD/decisions?tag=combat')).body.length, 1);

  // combat label → D-001; epic "Economy" (matched by title) → D-002; ui label → 11 decisions, capped at 10 overall.
  const t = await s.call('POST', '/api/tasks', { project: 'QD', title: 't', status: 'todo', labels: ['combat', 'ui'], epic: epic.body.key });
  const briefing = await s.call('POST', `/api/tasks/${t.body.key}/claim`, {}, 'agent-d');
  assert.equal(briefing.body.decisions.length, 10);
  assert.ok(briefing.body.decisions.every((d) => d.tags.some((tag) => ['ui', 'combat', 'economy'].includes(tag.toLowerCase()))));
  assert.ok(!briefing.body.decisions.some((d) => d.title === 'unrelated'));
  const narrow = await s.call('POST', '/api/tasks', { project: 'QD', title: 'n', status: 'todo', epic: epic.body.key });
  const b2 = await s.call('POST', `/api/tasks/${narrow.body.key}/claim`, {}, 'agent-d');
  assert.deepEqual(b2.body.decisions.map((d) => d.id), ['D-002']);
  const none = await s.call('POST', '/api/tasks', { project: 'QD', title: 'none', status: 'todo' });
  assert.equal((await s.call('POST', `/api/tasks/${none.body.key}/claim`, {}, 'agent-d')).body.decisions, undefined);
});

test('MCP: ask_director, list_decisions, get_decision', async () => {
  const t = await s.rpc('create_task', { project: 'QD', title: 'mcp q', status: 'todo', labels: ['combat'] });
  const q = await s.rpc('ask_director', { task: t.key, question: 'Which?', options: ['a', 'b'], recommendation: 'a' });
  assert.equal(q.recommendation, 'a');
  assert.equal(q.asked_by, 'mcp-agent');
  const list = await s.rpc('list_decisions', { project: 'QD', tag: 'combat' });
  assert.deepEqual(list.map((d) => d.id), ['D-001']);
  const one = await s.rpc('get_decision', { project: 'QD', id: 'D-001' });
  assert.equal(one.decision, '3');
  assert.match((await s.rpc('get_decision', { project: 'QD', id: 'D-999' })).error, /404/);
});

test('next_up skips a task waiting on the Director, like claim-next', async () => {
  await s.call('POST', '/api/projects', { key: 'QN' });
  const t = await s.call('POST', '/api/tasks', { project: 'QN', title: 'urgent but parked', status: 'todo', priority: 'urgent' });
  await s.call('POST', `/api/tasks/${t.body.key}/questions`, { question: 'wait?' }, 'agent');
  const board = (await s.call('GET', '/api/projects/QN/board')).body;
  assert.equal(board.next_up, null);
  assert.match(board.next_up_reasons[0].why, /waiting on Director/);
});
