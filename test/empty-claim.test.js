import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'EC' });
});
after(() => s.close());

test('an empty todo column explains itself', async () => {
  const res = await s.call('POST', '/api/projects/EC/claim-next', {}, 'agent');
  assert.deepEqual(res.body.task, null);
  assert.deepEqual(res.body.reasons, []);
  assert.match(res.body.hint, /To Do column is empty/);
});

test('an empty claim lists why each of the top 5 cards is unavailable', async () => {
  const [dep] = (
    await s.director('POST', '/api/tasks/bulk', {
      tasks: [
        { project: 'EC', title: 'Repo guardrails', status: 'review' },
        { project: 'EC', title: 'Core project', status: 'todo', priority: 'urgent', depends_on: ['#0'] },
        { project: 'EC', title: 'Gate G1', status: 'todo', priority: 'high', assignee: 'director' },
        { project: 'EC', title: 'Unity shell', status: 'todo', priority: 'high', prerequisites: ['Install the .NET 8 SDK'] },
        { project: 'EC', title: 'Spark rules', status: 'todo', priority: 'medium' },
        { project: 'EC', title: 'Tray', status: 'todo', priority: 'low', labels: ['ui'] },
        { project: 'EC', title: 'Sixth', status: 'todo', priority: 'low', assignee: 'someone' },
      ],
    })
  ).body;
  const spark = (await s.call('GET', '/api/tasks?project=EC&q=Spark')).body[0].key;
  await s.call('POST', `/api/tasks/${spark}/questions`, { question: 'Which Spark count wins?\nMore detail' }, 'agent-a');

  // Only the "Tray" task is claimable, and a label filter rules it out too.
  const res = await s.call('POST', '/api/projects/EC/claim-next', { labels: ['audio'] }, 'agent-b');
  assert.equal(res.body.task, null);
  assert.equal(res.body.reasons.length, 5, 'top 5 only');
  const why = Object.fromEntries(res.body.reasons.map((r) => [r.title, r.why]));
  // Every card also fails the label filter; the specific reason comes first.
  assert.equal(why['Core project'], `blocked by ${dep.key} (review); no label audio`);
  assert.equal(why['Gate G1'], 'assigned to director; no label audio');
  assert.equal(why['Unity shell'], 'prerequisite: Install the .NET 8 SDK; no label audio');
  assert.equal(why['Spark rules'], 'waiting on Director: "Which Spark count wins?"; no label audio');
  assert.equal(why.Tray, 'no label audio');
  assert.equal(why.Sixth, undefined);

  const viaMcp = await s.rpc('claim_next_task', { project: 'EC', types: ['bug'] }, 'agent-b');
  assert.equal(viaMcp.task, null);
  assert.ok(viaMcp.reasons.some((r) => r.why === 'type task, not bug'));
});

test('non-empty claims are unchanged: just {task}', async () => {
  const res = await s.call('POST', '/api/projects/EC/claim-next', {}, 'agent-b');
  assert.equal(res.body.task.title, 'Tray');
  assert.deepEqual(Object.keys(res.body), ['task']);
});

test('the board explains a To Do column with nothing claimable', async () => {
  await s.call('POST', '/api/projects', { key: 'EB' });
  const board = async () => (await s.call('GET', '/api/projects/EB/board')).body;
  assert.equal((await board()).next_up_reasons, undefined, 'empty column: nothing to explain');
  await s.call('POST', '/api/tasks', { project: 'EB', title: 'gate', status: 'todo', assignee: 'director' });
  const b = await board();
  assert.equal(b.next_up, null);
  assert.deepEqual(b.next_up_reasons.map((r) => r.why), ['assigned to director']);
});
