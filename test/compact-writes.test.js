import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, tempRepo } from './helpers.js';

// MCP write tools answer with what changed and what needs attention; verbose: true returns the task.
let s;
let repo;
let work;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'README.md': 'x' }, 'base');
  work = repo.commit({ 'golden/help.txt': 'new', 'src/app.py': 'y' }, 'work');
  await s.director('POST', '/api/projects', {
    key: 'CW',
    repo_path: repo.dir,
    protected_paths: [{ glob: 'golden/**', unlock_label: 'golden-change' }],
    checks: [{ name: 'tests', command: 'npm test', required: true }],
  });
});
after(() => {
  repo.remove();
  return s.close();
});

const raw = async (name, args) => {
  const res = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent': 'mcp-agent' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result.content[0].text;
};

test('MCP responses are minified JSON', async () => {
  const text = await raw('get_board', { project: 'CW' });
  assert.doesNotMatch(text, /\n/);
  assert.equal(JSON.stringify(JSON.parse(text)), text);
});

test('create_task and create_tasks return compact entries by default, full tasks with verbose', async () => {
  const one = await s.rpc('create_task', { project: 'CW', title: 'Compact', description: 'long text', criteria: ['a', 'b'] });
  assert.deepEqual(one, { key: one.key, status: 'backlog', title: 'Compact', criteria: '0/2 done' });
  const full = await s.rpc('create_task', { project: 'CW', title: 'Full', description: 'long text', verbose: true });
  assert.equal(full.description, 'long text');
  assert.ok('handoff' in full && 'prerequisites' in full);

  const batch = await s.rpc('create_tasks', {
    tasks: [
      { project: 'CW', title: 'one' },
      { project: 'CW', title: 'two', scope: ['golden/**'] },
    ],
  });
  assert.deepEqual(batch.map((t) => Object.keys(t)), [['key', 'status', 'title'], ['key', 'status', 'title', 'warnings']]);
  assert.match(batch[1].warnings[0], /Scope golden\/\*\* is protected/);
  // HTTP is unchanged: the full task.
  const http = await s.call('POST', '/api/tasks', { project: 'CW', title: 'http', description: 'kept' });
  assert.equal(http.body.description, 'kept');
});

test('update_task, check_criteria, release_task and recheck_context say what changed', async () => {
  const key = (await s.rpc('create_task', { project: 'CW', title: 't', status: 'todo', criteria: ['a', 'b'], context: ['README.md'] })).key;
  await s.rpc('claim_task', { task: key });
  assert.deepEqual(await s.rpc('update_task', { task: key, priority: 'high', labels: ['ui'] }), {
    key,
    status: 'in_progress',
    changed: ['priority', 'labels'],
    criteria: '0/2 done',
  });
  const ticked = await s.rpc('check_criteria', { task: key, items: [0], evidence: 'npm test' });
  assert.deepEqual(ticked, { key, status: 'in_progress', changed: ['criteria'], criteria: '1/2 done' });
  const verbose = await s.rpc('check_criteria', { task: key, items: [1], verbose: true });
  assert.deepEqual(verbose.criteria.map((c) => c.done), [true, true]);
  const rechecked = await s.rpc('recheck_context', { task: key });
  assert.deepEqual(rechecked, { key, status: 'in_progress', changed: [], criteria: '2/2 done' });
  const released = await s.rpc('release_task', { task: key, checkpoint: 'halfway' });
  assert.deepEqual(released.changed, ['status', 'assignee', 'checkpoint']);
  assert.equal(released.status, 'todo');
});

test('submit_for_review states each message once: warnings, then violations', async () => {
  const key = (await s.rpc('create_task', { project: 'CW', title: 'submit', status: 'todo', criteria: ['a', '[director] looks right'] })).key;
  await s.rpc('claim_task', { task: key });
  const sub = await s.rpc('submit_for_review', { task: key, summary: 'done', commit: work });
  assert.equal(sub.status, 'review');
  assert.deepEqual(sub.changed, ['status', 'handoff']);
  assert.deepEqual(sub.warnings, ['Check "tests" (required) was not reported. Run `npm test` and include the result in checks.']);
  assert.equal(sub.violations.length, 1);
  assert.match(sub.violations[0], /^Protected path golden\/\*\* touched: golden\/help\.txt\./);
  assert.deepEqual(sub.unchecked_criteria, ['a']);
  assert.deepEqual(sub.awaiting_director, ['looks right']);
  const messages = [...sub.warnings, ...sub.violations];
  assert.equal(new Set(messages).size, messages.length);
  // HTTP keeps its shape (warnings at the top level include the violations, as before).
  const t2 = (await s.rpc('create_task', { project: 'CW', title: 'http submit', status: 'todo' })).key;
  await s.call('POST', `/api/tasks/${t2}/claim`, {}, 'agent');
  const http = await s.call('POST', `/api/tasks/${t2}/submit`, { summary: 'x', commit: work }, 'agent');
  assert.equal(http.body.warnings.length, 2);
  assert.ok(http.body.handoff);
});

test('create_epic is compact too', async () => {
  const epic = await s.rpc('create_epic', { project: 'CW', title: 'Theme', priority: 'high' });
  assert.deepEqual(epic, { key: epic.key, status: 'todo', title: 'Theme' });
  assert.ok((await s.rpc('create_epic', { project: 'CW', title: 'Theme 2', verbose: true })).progress);
});

test('update_project is gone and tools/list is at least 20% under the 46.9 KB it was', async () => {
  const res = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = await res.text();
  assert.ok(!JSON.parse(body).result.tools.some((t) => t.name === 'update_project'));
  assert.ok(body.length <= 46.9 * 1000 * 0.8, `tools/list is ${body.length} bytes`);
});
