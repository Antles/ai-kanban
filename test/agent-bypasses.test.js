import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// Each test is one way an agent could switch off or step around a Director rule through ordinary endpoints.
let s;
before(async () => {
  s = await startServer();
  await s.director('POST', '/api/projects', {
    key: 'BY',
    protected_paths: [{ glob: 'sim/**/Golden/**', unlock_label: 'golden-change' }],
    checks: [{ name: 'tests', command: 'npm test', required: true }],
  });
});
after(() => s.close());

const agent = (method, path, body, name = 'agent-a') => s.call(method, path, body, name);
const task = async (fields = {}) => (await s.director('POST', '/api/tasks', { project: 'BY', title: 't', status: 'todo', ...fields })).body;

test('project settings, the glossary and deleting a project are Director-only, over HTTP and MCP', async () => {
  for (const patch of [{ checks: [] }, { protected_paths: [] }, { required_fields: [] }, { agent_brief: 'x' }, { repo_path: '/tmp' }, { name: 'Renamed' }]) {
    const res = await agent('PATCH', '/api/projects/BY', patch);
    assert.equal(res.status, 403, JSON.stringify(patch));
    assert.match(res.body.error, /Only the Director can change project settings.*ask_director/);
  }
  assert.equal((await agent('POST', '/api/projects/BY/glossary/import', { markdown: '**Hero**:\n_Avoid_: unit' })).status, 403);
  assert.equal((await agent('DELETE', '/api/projects/BY')).status, 403);
  assert.ok(!(await s.mcp('tools/list')).tools.some((t) => t.name === 'update_project'), 'MCP is agent-only, so it has no update_project');
  assert.ok(!(await s.mcp('tools/list')).tools.some((t) => t.name === 'import_glossary'), 'nor import_glossary');

  const project = (await s.call('GET', '/api/projects/BY')).body;
  assert.equal(project.checks.length, 1, 'nothing changed');
  assert.equal(project.protected_paths.length, 1);
  assert.equal((await s.director('PATCH', '/api/projects/BY', { name: 'Bypass tests' })).status, 200, 'the Director still can');
});

test('force-claiming past prerequisites and dependencies is Director-only', async () => {
  const dep = await task({ title: 'first' });
  const t = await task({ prerequisites: ['Install Unity'], depends_on: [dep.key] });
  const res = await agent('POST', `/api/tasks/${t.key}/claim`, { force: true });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /Only the Director can force a claim/);
  assert.match((await s.rpc('claim_task', { task: t.key, force: true })).error, /Only the Director can force a claim/);
  assert.equal((await s.call('GET', `/api/tasks/${t.key}`)).body.assignee, null);
  assert.equal((await s.director('POST', `/api/tasks/${t.key}/claim`, { force: true, agent: 'agent-a' })).status, 200);
});

test('a task waiting on the Director cannot be assigned to another agent', async () => {
  const t = await task();
  await agent('POST', `/api/tasks/${t.key}/claim`, {});
  await agent('POST', `/api/tasks/${t.key}/questions`, { question: 'A or B?' });
  const taken = await agent('PATCH', `/api/tasks/${t.key}`, { assignee: 'agent-b' }, 'agent-b');
  assert.equal(taken.status, 403, "another agent can't take it");
  assert.match(taken.body.error, /held by agent-a/);
  const handed = await agent('PATCH', `/api/tasks/${t.key}`, { assignee: 'agent-b' }, 'agent-a');
  assert.equal(handed.status, 403, "its holder can't hand it off while it's parked");
  assert.match(handed.body.error, /waiting on the Director/);
  assert.match((await s.rpc('update_task', { task: t.key, assignee: 'mcp-agent', agent: 'agent-a' })).error, /waiting on the Director/);
  assert.equal((await agent('PATCH', `/api/tasks/${t.key}`, { assignee: 'agent-a' })).status, 200, 'keeping the holder is fine');
  assert.equal((await agent('PATCH', `/api/tasks/${t.key}`, { assignee: null })).status, 200, 'giving it up is fine');
  const next = await agent('POST', '/api/projects/BY/claim-next', {}, 'agent-b');
  assert.notEqual(next.body.task?.key, t.key, 'claim-next still skips it');

  // Before the question, an agent may assign freely.
  const free = await task();
  assert.equal((await agent('PATCH', `/api/tasks/${free.key}`, { assignee: 'agent-b' })).status, 200);
});

test('unlock labels are Director-only; agents may change scope', async () => {
  const t = await task({ labels: ['sim'], scope: ['sim/Core/**'] });
  const label = await agent('PATCH', `/api/tasks/${t.key}`, { labels: ['sim', 'golden-change'] });
  assert.equal(label.status, 403);
  assert.match(label.body.error, /golden-change.*unlocks a protected path/);
  assert.equal((await agent('POST', '/api/tasks', { project: 'BY', title: 'sneaky', labels: ['golden-change'] })).status, 403);
  assert.match((await s.rpc('update_task', { task: t.key, labels: ['golden-change'] })).error, /unlocks a protected path/);
  assert.equal((await agent('PATCH', `/api/tasks/${t.key}`, { labels: ['sim', 'ui'] })).status, 200, 'other labels are fine');

  const widened = await agent('PATCH', `/api/tasks/${t.key}`, { scope: ['sim/Core/**', 'docs/combat.md'] });
  assert.deepEqual([widened.status, widened.body.scope], [200, ['sim/Core/**', 'docs/combat.md']]);
  assert.equal((await s.director('PATCH', `/api/tasks/${t.key}`, { labels: ['golden-change'], scope: ['**'] })).status, 200);
});

test('agents cannot set evidence on Director criteria', async () => {
  const t = await task({ criteria: ['[director] Feels right on the phone', 'tests pass'] });
  const res = await agent('PATCH', `/api/tasks/${t.key}`, {
    criteria: [{ text: 'Feels right on the phone', owner: 'human', evidence: 'trust me' }, 'tests pass'],
  });
  assert.equal(res.status, 403);
  assert.equal((await agent('POST', `/api/tasks/${t.key}/criteria`, { items: [{ item: 0, evidence: 'trust me' }], done: false })).status, 403);
  const created = await agent('POST', '/api/tasks', { project: 'BY', title: 'x', criteria: [{ text: 'ok', owner: 'human', evidence: 'seen' }] });
  assert.equal(created.status, 403);
  assert.equal((await s.call('GET', `/api/tasks/${t.key}`)).body.criteria[0].evidence, undefined);
  // Their own items take evidence as before.
  assert.equal((await agent('POST', `/api/tasks/${t.key}/criteria`, { items: [{ item: 1, evidence: 'npm test' }] })).status, 200);
});

test('ask_director is refused on done tasks, epics and tasks another agent holds', async () => {
  const done = await task({ status: 'done' });
  const epic = (await s.director('POST', '/api/projects/BY/epics', { title: 'Theme' })).body;
  const held = await task();
  await agent('POST', `/api/tasks/${held.key}/claim`, {}, 'agent-b');
  const q = { question: 'Which?' };
  assert.equal((await agent('POST', `/api/tasks/${done.key}/questions`, q)).status, 409);
  assert.equal((await agent('POST', `/api/tasks/${epic.key}/questions`, q)).status, 409);
  const other = await agent('POST', `/api/tasks/${held.key}/questions`, q);
  assert.equal(other.status, 403);
  assert.match(other.body.error, /held by agent-b/);
  assert.match((await s.rpc('ask_director', { task: held.key, question: 'Which?' })).error, /held by agent-b/);
  assert.equal((await agent('POST', `/api/tasks/${held.key}/questions`, q, 'agent-b')).status, 201, 'the holder may ask');
  const open = await task();
  assert.equal((await agent('POST', `/api/tasks/${open.key}/questions`, q)).status, 201, 'so may anyone on an unassigned task');
});
