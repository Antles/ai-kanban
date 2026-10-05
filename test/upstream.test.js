import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'UP' });
});
after(() => s.close());

test('briefings carry direct dependencies\' handoffs and final review, trimmed; nothing else changes', async () => {
  const [a, b, c, plain] = (
    await s.call('POST', '/api/tasks/bulk', {
      tasks: [
        { project: 'UP', title: 'Battle skeleton', status: 'todo' },
        { project: 'UP', title: 'L0 rules', status: 'todo', depends_on: ['#0'] },
        { project: 'UP', title: 'Terminal prototype', status: 'todo', depends_on: ['#1'] },
        { project: 'UP', title: 'standalone', status: 'todo' },
      ],
    })
  ).body;

  const long = `Renamed the types: \`BattleState\`, \`Intent\`, \`Unit\`. ${'x'.repeat(3000)}`;
  await s.call('POST', `/api/tasks/${a.key}/claim`, {}, 'agent-a');
  await s.call('POST', `/api/tasks/${a.key}/submit`, { summary: long, commit: 'abc1234', files: ['sim/Battle.cs', 'sim/Intent.cs'] }, 'agent-a');
  await s.director('POST', `/api/tasks/${a.key}/review`, { verdict: 'accept', feedback: 'Good. Keep Intent immutable.' });

  const claimed = await s.call('POST', `/api/tasks/${b.key}/claim`, {}, 'agent-b');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.upstream.length, 1);
  const up = claimed.body.upstream[0];
  assert.equal(up.key, a.key);
  assert.equal(up.title, 'Battle skeleton');
  assert.deepEqual(up.files, ['sim/Battle.cs', 'sim/Intent.cs']);
  assert.equal(up.commit, 'abc1234');
  assert.ok(up.summary.startsWith('Renamed the types'));
  assert.ok(up.summary.length <= 1501 && up.summary.endsWith('…'), `trimmed to ~1500 (got ${up.summary.length})`);
  assert.deepEqual([up.review.verdict, up.review.feedback], ['accepted', 'Good. Keep Intent immutable.']);
  assert.ok((await s.call('GET', `/api/tasks/${b.key}`)).body.upstream, 'get_task has it too');

  // b hands off; c sees b only (direct), never a (transitive).
  await s.call('POST', `/api/tasks/${b.key}/submit`, { summary: 'Rules on top of the skeleton' }, 'agent-b');
  await s.director('POST', `/api/tasks/${b.key}/review`, { verdict: 'accept' });
  const third = await s.call('POST', `/api/tasks/${c.key}/claim`, {}, 'agent-c');
  assert.deepEqual(third.body.upstream.map((u) => u.key), [b.key]);
  assert.equal(third.body.upstream[0].summary, 'Rules on top of the skeleton');
  assert.equal(third.body.upstream[0].review.feedback, null);

  // No dependencies: no upstream key at all.
  const none = await s.call('POST', `/api/tasks/${plain.key}/claim`, {}, 'agent-d');
  assert.equal('upstream' in none.body, false);

  // A dependency without a handoff (moved to done by hand) is left out.
  const manual = await s.call('POST', '/api/tasks', { project: 'UP', title: 'manual', status: 'done' });
  const dependent = await s.call('POST', '/api/tasks', { project: 'UP', title: 'dep', status: 'todo', depends_on: [manual.body.key] });
  assert.equal('upstream' in (await s.call('GET', `/api/tasks/${dependent.body.key}`)).body, false);

  const viaMcp = await s.rpc('get_task', { task: b.key });
  assert.equal(viaMcp.upstream[0].key, a.key);
});
