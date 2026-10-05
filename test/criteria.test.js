import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'CR' });
});
after(() => s.close());

const AS3_DESCRIPTION = `_Size: 1 session_

**Build:**
- \`Pcg32\` (seeded).

**Test cases (plain language):**
- The same seed always gives the same sequence.

**Acceptance:**
- [ ] The tests pass, and the first 5 outputs for seed 42 match the reference numbers.
- [ ] Running the test suite twice produces identical output.`;

test('criteria carry an owner (default agent) and evidence; legacy items load as agent', async () => {
  const t = await s.call('POST', '/api/tasks', {
    project: 'CR',
    title: 'owners',
    criteria: ['Unit test passes', '[director] Text readable on your phone', { text: 'Explicit', owner: 'human' }],
  });
  assert.deepEqual(
    t.body.criteria.map((c) => [c.text, c.owner]),
    [['Unit test passes', 'agent'], ['Text readable on your phone', 'human'], ['Explicit', 'human']],
  );

  // A row written before owners existed ({text, done} only) reads back as agent-owned.
  s.app.kanban.db.prepare('UPDATE tasks SET criteria = ? WHERE id = ?').run(JSON.stringify([{ text: 'old', done: true }]), t.body.id);
  const legacy = await s.call('GET', `/api/tasks/${t.body.key}`);
  assert.deepEqual(legacy.body.criteria, [{ text: 'old', done: true, owner: 'agent' }]);
});

test('check_criteria records evidence per item and a shared fallback; unticking drops it', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'CR', title: 'evidence', criteria: ['a', 'b', 'c'] });
  const key = t.body.key;
  const res = await s.call('POST', `/api/tasks/${key}/criteria`, {
    items: [{ item: 0, evidence: 'RngTests.SameSeed passes' }, 'b'],
    evidence: 'dotnet test: 12 passed',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.criteria.map((c) => [c.done, c.evidence]), [
    [true, 'RngTests.SameSeed passes'],
    [true, 'dotnet test: 12 passed'],
    [false, undefined],
  ]);
  const detail = await s.call('GET', `/api/tasks/${key}`);
  const log = detail.body.activity.find((a) => a.action === 'criteria_checked');
  assert.deepEqual(log.detail.evidence, ['RngTests.SameSeed passes', 'dotnet test: 12 passed']);

  // Rewriting the list as plain strings keeps ticks and evidence.
  const rewritten = await s.call('PATCH', `/api/tasks/${key}`, { criteria: ['a', 'b', 'c', 'd'] });
  assert.equal(rewritten.body.criteria[0].evidence, 'RngTests.SameSeed passes');

  const unticked = await s.call('POST', `/api/tasks/${key}/criteria`, { items: [1], done: false });
  assert.deepEqual(unticked.body.criteria[1], { text: 'b', done: false, owner: 'agent' });
});

test('agents get 403 on Director criteria; the Director (X-Role) can tick them', async () => {
  const t = await s.call('POST', '/api/tasks', {
    project: 'CR',
    title: 'permissions',
    criteria: ['agent item', '[director] Readable on the phone'],
  });
  const key = t.body.key;
  const denied = await s.call('POST', `/api/tasks/${key}/criteria`, { items: [1] }, 'claude');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Director criterion/);
  assert.match(denied.body.error, /only the human/);

  // Nor can an agent work around it through PATCH: tick, reassign or drop the item.
  for (const criteria of [
    ['agent item', '[x] [director] Readable on the phone'],
    ['agent item', { text: 'Readable on the phone', owner: 'agent' }],
    ['agent item'],
  ]) {
    assert.equal((await s.call('PATCH', `/api/tasks/${key}`, { criteria }, 'claude')).status, 403, JSON.stringify(criteria));
  }
  // Adding new items (even Director ones) is fine.
  const added = await s.call('PATCH', `/api/tasks/${key}`, { criteria: ['agent item', 'Readable on the phone', '[director] Feels fast'] }, 'claude');
  assert.equal(added.status, 200);
  assert.equal(added.body.criteria.length, 3);

  const ticked = await s.director('POST', `/api/tasks/${key}/criteria`, { items: ['Readable on the phone'] });
  assert.equal(ticked.status, 200);
  assert.equal(ticked.body.criteria[1].done, true);

  // Submitting warns about the agent's open items and lists the Director's separately.
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'claude');
  const submitted = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'done' }, 'claude');
  assert.deepEqual(submitted.body.unchecked_criteria, ['agent item']);
  assert.deepEqual(submitted.body.awaiting_director, ['Feels fast']);
});

test('extracting an AS-3 style checklist moves exactly its lines into criteria', async () => {
  const t = await s.call('POST', '/api/tasks', { project: 'CR', title: 'AS-3', description: AS3_DESCRIPTION });
  const res = await s.call('POST', `/api/tasks/${t.body.key}/criteria/extract`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.extracted, 2);
  assert.deepEqual(res.body.criteria.map((c) => c.text), [
    'The tests pass, and the first 5 outputs for seed 42 match the reference numbers.',
    'Running the test suite twice produces identical output.',
  ]);
  assert.doesNotMatch(res.body.description, /\[ \]/);
  assert.doesNotMatch(res.body.description, /Acceptance/, 'the now-empty label goes too');
  assert.match(res.body.description, /\*\*Test cases \(plain language\):\*\*\n- The same seed/, 'everything else is untouched');

  const again = await s.call('POST', `/api/tasks/${t.body.key}/criteria/extract`, {});
  assert.equal(again.status, 400);
});

test('extract_criteria flag on bulk create, PATCH and MCP; code fences are left alone', async () => {
  const withFence = `Intro\n\n\`\`\`\n- [ ] not a criterion\n\`\`\`\n\n- [x] Already done\n- [ ] Still open`;
  const bulk = await s.call('POST', '/api/tasks/bulk', {
    tasks: [{ project: 'CR', title: 'bulk', description: withFence, extract_criteria: true, criteria: ['Still open'] }],
  });
  assert.deepEqual(bulk.body[0].criteria.map((c) => [c.text, c.done]), [['Still open', false], ['Already done', true]]);
  assert.match(bulk.body[0].description, /- \[ \] not a criterion/);

  const plain = await s.call('POST', '/api/tasks', { project: 'CR', title: 'patch', description: '- [ ] one' });
  const patched = await s.call('PATCH', `/api/tasks/${plain.body.key}`, { extract_criteria: true });
  assert.deepEqual(patched.body.criteria.map((c) => c.text), ['one']);
  assert.equal(patched.body.description, '');

  const viaMcp = await s.rpc('create_task', { project: 'CR', title: 'mcp', description: '- [ ] from mcp', extract_criteria: true, verbose: true });
  assert.deepEqual(viaMcp.criteria.map((c) => c.text), ['from mcp']);
  const other = await s.rpc('create_task', { project: 'CR', title: 'mcp2', description: '- [ ] later' });
  const updated = await s.rpc('update_task', { task: other.key, extract_criteria: true, verbose: true });
  assert.deepEqual(updated.criteria.map((c) => c.text), ['later']);

  // MCP callers are always agents.
  const human = await s.rpc('create_task', { project: 'CR', title: 'mcp3', criteria: ['[director] only me'] });
  const denied = await s.rpc('check_criteria', { task: human.key, items: [0] });
  assert.match(denied.error, /403/);
  const tools = await s.mcp('tools/list');
  const check = tools.tools.find((t) => t.name === 'check_criteria');
  assert.ok(check.inputSchema.properties.evidence);
  assert.match(check.description, /evidence/);
});

test('agents cannot create ticked Director items by extraction, on create, or by flipping an owner', async () => {
  // Extraction (PATCH flag and endpoint) brings Director items in unticked for agents.
  const a = await s.call('POST', '/api/tasks', { project: 'CR', title: 'x', description: '- [x] [director] sounds right\n- [x] mine' }, 'claude');
  const viaFlag = await s.call('PATCH', `/api/tasks/${a.body.key}`, { extract_criteria: true }, 'claude');
  assert.deepEqual(viaFlag.body.criteria.map((c) => [c.text, c.owner, c.done]), [['sounds right', 'human', false], ['mine', 'agent', true]]);
  const b = await s.call('POST', '/api/tasks', { project: 'CR', title: 'y', description: '- [x] [director] looks right' }, 'claude');
  const viaEndpoint = await s.call('POST', `/api/tasks/${b.body.key}/criteria/extract`, {}, 'claude');
  assert.equal(viaEndpoint.body.criteria[0].done, false);
  const byDirector = await s.call('POST', '/api/tasks', { project: 'CR', title: 'z', description: '- [x] [director] ok' }, 'human', { role: 'director' });
  assert.equal((await s.director('POST', `/api/tasks/${byDirector.body.key}/criteria/extract`, {})).body.criteria[0].done, true);

  // Creating one already ticked (single, bulk, MCP, import) is refused.
  const ticked = { project: 'CR', title: 't', criteria: [{ text: 'hm', owner: 'human', done: true }] };
  assert.equal((await s.call('POST', '/api/tasks', ticked, 'claude')).status, 403);
  assert.equal((await s.call('POST', '/api/tasks/bulk', { tasks: [ticked] }, 'claude')).status, 403);
  assert.match((await s.rpc('create_task', { ...ticked, criteria: ['[x] [director] hm'] })).error, /403/);
  assert.equal((await s.call('POST', '/api/projects/CR/import', { tasks: [{ ...ticked, external_id: 'Z1' }] }, 'claude')).status, 403);
  assert.equal((await s.call('POST', '/api/tasks', { project: 'CR', title: 'p', prerequisites: ['[x] installed'] }, 'claude')).status, 403);

  // Flipping a ticked agent item to the Director is refused.
  const c = await s.call('POST', '/api/tasks', { project: 'CR', title: 'flip', criteria: ['mine'] }, 'claude');
  await s.call('POST', `/api/tasks/${c.body.key}/criteria`, { items: [0] }, 'claude');
  const flip = await s.call('PATCH', `/api/tasks/${c.body.key}`, { criteria: [{ text: 'mine', owner: 'human' }] }, 'claude');
  assert.equal(flip.status, 403);
});
