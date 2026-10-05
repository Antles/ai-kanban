import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempRepo } from './helpers.js';

// Work on a task (ticks, submits, context re-checks) belongs to the agent holding it. Subagents that
// share one X-Agent say who they are with "agent".
let s;
let repo;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'docs/spec.md': 'v1' }, 'base');
  await s.director('POST', '/api/projects', { key: 'HO', repo_path: repo.dir });
});
after(() => {
  repo.remove();
  return s.close();
});

const held = async (holder = 'agent-b') => {
  const t = (await s.director('POST', '/api/tasks', { project: 'HO', title: 't', status: 'todo', criteria: ['works'], context: ['docs/spec.md'] })).body;
  if (holder) assert.equal((await s.call('POST', `/api/tasks/${t.key}/claim`, {}, holder)).status, 200);
  return t.key;
};

test("ticks, submits and re-checks on another agent's task get 403 naming the holder and change nothing", async () => {
  const key = await held('agent-b');
  const tick = await s.call('POST', `/api/tasks/${key}/criteria`, { items: [0] }, 'agent-a');
  assert.equal(tick.status, 403);
  assert.match(tick.body.error, new RegExp(`${key} is held by agent-b\\. Pass agent: "agent-b" if that's you, or claim it first\\.`));
  const submit = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'mine now' }, 'agent-a');
  assert.equal(submit.status, 403);
  assert.match(submit.body.error, /held by agent-b/);
  const recheck = await s.call('POST', `/api/tasks/${key}/context/recheck`, {}, 'agent-a');
  assert.equal(recheck.status, 403);

  const after = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(after.criteria[0].done, false);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.handoff, null);
  assert.ok(!after.activity.some((a) => a.actor === 'agent-a'), 'nothing was logged for agent-a');

  // Over MCP too (the connection's X-Agent is mcp-agent).
  assert.match((await s.rpc('check_criteria', { task: key, items: [0] })).error, /held by agent-b/);
  assert.match((await s.rpc('submit_for_review', { task: key, summary: 'x' })).error, /held by agent-b/);
  assert.match((await s.rpc('recheck_context', { task: key })).error, /held by agent-b/);
});

test('submitting a task nobody holds is a 409 asking to claim it first', async () => {
  const key = await held(null);
  const res = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x' }, 'agent-a');
  assert.equal(res.status, 409);
  assert.match(res.body.error, new RegExp(`${key} isn't claimed\\. Claim it first \\(claim_task ${key}\\), then submit\\.`));
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.status, 'todo');
  // Ticks on an unclaimed task stay open (a planner fixing up criteria).
  assert.equal((await s.call('POST', `/api/tasks/${key}/criteria`, { items: [0] }, 'agent-a')).status, 200);
});

test('agent: a subagent acts under its own name, over MCP and HTTP', async () => {
  const key = await held(null);
  const claimed = await s.rpc('claim_task', { task: key, agent: 'claude-code-b' });
  assert.equal(claimed.assignee, 'claude-code-b');
  assert.match((await s.rpc('check_criteria', { task: key, items: [0] })).error, /held by claude-code-b/, 'without agent it is the connection');

  const as = { agent: 'claude-code-b' };
  assert.equal((await s.rpc('add_comment', { task: key, body: 'starting', ...as })).author, 'claude-code-b');
  assert.deepEqual((await s.rpc('update_task', { task: key, priority: 'high', ...as })).changed, ['priority']);
  assert.equal((await s.rpc('check_criteria', { task: key, items: [0], evidence: 'npm test', ...as })).criteria, '1/1 done');
  assert.equal((await s.rpc('recheck_context', { task: key, ...as })).key, key);
  const q = await s.rpc('ask_director', { task: key, question: 'FYI', blocking: false, ...as });
  assert.equal(q.asked_by, 'claude-code-b');
  const sub = await s.rpc('submit_for_review', { task: key, summary: 'done', ...as, verbose: true });
  assert.equal(sub.status, 'review');
  assert.equal(sub.handoff.submitted_by, 'claude-code-b');

  const log = (await s.call('GET', `/api/activity?task=${key}`)).body;
  const actors = new Set(log.filter((a) => a.action !== 'created').map((a) => a.actor));
  assert.deepEqual([...actors], ['claude-code-b'], 'every step is recorded as the subagent');

  // HTTP takes the same "agent" in the body.
  const other = await held(null);
  await s.call('POST', `/api/tasks/${other}/claim`, { agent: 'sub-2' }, 'lead');
  assert.equal((await s.call('POST', `/api/tasks/${other}/criteria`, { items: [0] }, 'lead')).status, 403);
  assert.equal((await s.call('POST', `/api/tasks/${other}/criteria`, { items: [0], agent: 'sub-2' }, 'lead')).status, 200);
  const comment = await s.call('POST', `/api/tasks/${other}/comments`, { body: 'hi', agent: 'sub-2' }, 'lead');
  assert.equal(comment.body.author, 'sub-2');
  const httpSub = await s.call('POST', `/api/tasks/${other}/submit`, { summary: 'ok', agent: 'sub-2' }, 'lead');
  assert.equal(httpSub.body.handoff.submitted_by, 'sub-2');
});

test("comments stay open to everyone, and the Director's board actions are unchanged", async () => {
  const key = await held('agent-b');
  assert.equal((await s.call('POST', `/api/tasks/${key}/comments`, { body: 'saw this' }, 'agent-a')).status, 201);
  assert.equal((await s.director('POST', `/api/tasks/${key}/criteria`, { items: [0] })).status, 200);
  assert.equal((await s.director('POST', `/api/tasks/${key}/context/recheck`, {})).status, 200);
  const sub = await s.director('POST', `/api/tasks/${key}/submit`, { summary: 'closing it out for them' });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'review');
});
