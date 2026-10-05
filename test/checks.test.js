import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'CK' });
});
after(() => s.close());

const CHECKS = [
  { name: 'core tests', command: 'dotnet test sim/', required: true },
  { name: 'golden replays', command: './tools/replay.sh', required_when_paths: ['sim/**/Rules/**', '*.replay'] },
  { name: 'lint', command: 'npm run lint' },
];

test('checks are validated project settings and a project without them is unchanged', async () => {
  const before = await s.call('GET', '/api/projects/CK');
  assert.deepEqual(before.body.checks, []);
  assert.equal((await s.director('PATCH', '/api/projects/CK', { checks: [{ name: 'x' }] })).status, 400, 'command is required');
  assert.equal((await s.director('PATCH', '/api/projects/CK', { checks: [CHECKS[0], CHECKS[0]] })).status, 400, 'names are unique');
  const saved = await s.director('PATCH', '/api/projects/CK', { checks: CHECKS });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.checks, [
    { name: 'core tests', command: 'dotnet test sim/', required: true },
    { name: 'golden replays', command: './tools/replay.sh', required: false, required_when_paths: ['sim/**/Rules/**', '*.replay'] },
    { name: 'lint', command: 'npm run lint', required: false },
  ]);
  // Other project edits leave settings alone.
  const renamed = await s.director('PATCH', '/api/projects/CK', { name: 'Checks' });
  assert.equal(renamed.body.checks.length, 3);
});

test('briefings list the checks; submit stores results and warns about missing or failed required ones', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'CK', title: 'rules', status: 'todo' });
  const key = t.body.key;
  const claimed = await s.call('POST', `/api/tasks/${key}/claim`, {}, 'agent');
  assert.equal(claimed.body.checks.length, 3);

  // Nothing reported, touched a rules file: both the always-required and the path-conditional check are missing.
  const first = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', files: ['sim/Core/Rules/Intent.cs'] }, 'agent');
  assert.equal(first.status, 200, 'warnings never fail the submit');
  assert.equal(first.body.status, 'review');
  assert.equal(first.body.warnings.length, 2);
  assert.match(first.body.warnings[0], /"core tests" \(required\) was not reported\. Run `dotnet test sim\/`/);
  assert.match(first.body.warnings[1], /"golden replays" \(required because you changed sim\/Core\/Rules\/Intent\.cs\)/);

  const second = await s.call(
    'POST',
    `/api/tasks/${key}/submit`,
    {
      summary: 'y',
      files: ['sim/Core/Rules/Intent.cs'],
      checks: [
        { name: 'Core Tests', passed: true, output_tail: 'Passed! 42 tests' },
        { name: 'golden replays', passed: false, output_tail: `${'.'.repeat(5000)}hash mismatch e01` },
      ],
    },
    'agent',
  );
  assert.deepEqual(second.body.warnings, ['Check "golden replays" (required because you changed sim/Core/Rules/Intent.cs) failed.']);
  const stored = second.body.handoff.checks;
  assert.equal(stored[1].output_tail.length, 4000, 'output is kept to its tail');
  assert.ok(stored[1].output_tail.endsWith('hash mismatch e01'));
  assert.deepEqual(second.body.handoff.warnings, second.body.warnings, 'the reviewer sees them too');

  // Unrelated files: the conditional check isn't needed; the required one passed: no warnings at all.
  const third = await s.call(
    'POST',
    `/api/tasks/${key}/submit`,
    { summary: 'z', files: ['docs/readme.md'], checks: [{ name: 'core tests', passed: true }] },
    'agent',
  );
  assert.equal(third.body.warnings, undefined);
  assert.equal(third.body.handoff.warnings, undefined);
  assert.equal((await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'z', checks: [{ name: 'a' }] }, 'agent')).status, 400);

  // A glob without a slash matches the file name anywhere.
  const t2 = await s.call('POST', '/api/tasks', { project: 'CK', title: 'replay', status: 'todo' });
  await s.call('POST', `/api/tasks/${t2.body.key}/claim`, {}, 'agent');
  const r = await s.call('POST', `/api/tasks/${t2.body.key}/submit`, { summary: 'x', files: ['data/e01.replay'], checks: [{ name: 'core tests', passed: true }] }, 'agent');
  assert.equal(r.body.warnings.length, 1);
});

test('checks over MCP: set on the project, listed in briefings, reported on submit', async () => {
  await s.call('POST', '/api/projects', { key: 'CM' });
  const p = await s.director('PATCH', '/api/projects/CM', { checks: [{ name: 'tests', command: 'npm test', required: true }] });
  assert.equal(p.body.checks[0].name, 'tests');
  const t = await s.rpc('create_task', { project: 'CM', title: 't', status: 'todo' });
  const claimed = await s.rpc('claim_next_task', { project: 'CM' });
  assert.equal(claimed.task.checks[0].command, 'npm test');
  const sub = await s.rpc('submit_for_review', { task: t.key, summary: 'ok', checks: [{ name: 'tests', passed: false }] });
  assert.deepEqual(sub.warnings, ['Check "tests" (required) failed.']);
  const reset = await s.director('PATCH', '/api/projects/CM', { checks: null });
  assert.deepEqual(reset.body.checks, []);
});
