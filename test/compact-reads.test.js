import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// MCP reads return enough to choose from, with the details one get_task away. HTTP is unchanged.
let s;
before(async () => {
  s = await startServer();
  await s.director('POST', '/api/projects', { key: 'CR', agent_brief: 'A long brief. '.repeat(50), checks: [{ name: 't', command: 'npm test' }] });
});
after(() => s.close());

test('list_tasks returns summaries with attachment ids by default, full objects with full: true', async () => {
  const epic = (await s.director('POST', '/api/projects/CR/epics', { title: 'Theme' })).body.key;
  const key = (await s.director('POST', '/api/tasks', { project: 'CR', title: 'playtest note', labels: ['playtest'], epic, estimate: 2 })).body.key;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await (await fetch(`${s.base}/api/tasks/${key}/attachments?filename=shot.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json();
  const plain = (await s.director('POST', '/api/tasks', { project: 'CR', title: 'plain' })).body.key;

  const list = await s.rpc('list_tasks', { project: 'CR', label: 'playtest' });
  assert.deepEqual(list, [
    {
      key,
      title: 'playtest note',
      status: 'backlog',
      type: 'task',
      priority: 'medium',
      labels: ['playtest'],
      epic,
      estimate: 2,
      attachments: [{ id: up.id, filename: 'shot.png', mime: 'image/png' }],
    },
  ]);
  const bare = (await s.rpc('list_tasks', { project: 'CR' })).find((t) => t.key === plain);
  assert.deepEqual(Object.keys(bare), ['key', 'title', 'status', 'type', 'priority']);

  const full = await s.rpc('list_tasks', { project: 'CR', label: 'playtest', full: true });
  assert.equal(full[0].attachment_count, 1);
  assert.ok('description' in full[0] && 'criteria' in full[0]);
  const http = (await s.call('GET', '/api/tasks?project=CR&label=playtest')).body;
  assert.deepEqual(Object.keys(http[0]), Object.keys(full[0]), 'HTTP is unchanged');
});

test('the default list_tasks for 23 tasks like KB\'s stays under 10 KB', async () => {
  await s.director('POST', '/api/projects', { key: 'CS' });
  const long = 'Explain an empty claim_next_task and say which of the top five To Do cards is blocked, by what. '.repeat(20);
  await s.director('POST', '/api/tasks/bulk', {
    tasks: Array.from({ length: 23 }, (_, i) => ({
      project: 'CS',
      title: `Return compact MCP write responses and trim the tool schemas, part ${i}`,
      description: long,
      criteria: ['One', 'Two', 'Three', 'Four', 'Five'].map((c) => `${c}: ${long.slice(0, 200)}`),
      labels: ['agent-feedback', 'api', 'mcp'],
      estimate: 3,
      priority: 'high',
      status: 'todo',
      context: ['src/service.js', 'src/mcp.js', 'docs/agent-guide.md'],
    })),
  });
  const res = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent': 'probe' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: { project: 'CS' } } }),
  });
  const text = (await res.json()).result.content[0].text;
  assert.equal(JSON.parse(text).length, 23);
  assert.ok(text.length < 10000, `${text.length} bytes`);
  const full = (await s.call('GET', '/api/tasks?project=CS')).body;
  assert.ok(JSON.stringify(full).length > 10 * text.length, 'the full objects are an order of magnitude bigger');
});

test('get_task omits the activity log unless asked; HTTP and claim briefings are unchanged', async () => {
  const key = (await s.director('POST', '/api/tasks', { project: 'CR', title: 'activity', status: 'todo' })).body.key;
  await s.call('POST', `/api/tasks/${key}/comments`, { body: 'hello' }, 'agent');
  const lean = await s.rpc('get_task', { task: key });
  assert.equal(lean.activity, undefined);
  assert.equal(lean.comments.length, 1);
  const withLog = await s.rpc('get_task', { task: key, activity: true });
  assert.ok(withLog.activity.some((a) => a.action === 'commented'));
  assert.ok((await s.call('GET', `/api/tasks/${key}`)).body.activity.length >= 2, 'HTTP keeps it');
  const briefing = await s.rpc('claim_task', { task: key });
  assert.equal(briefing.activity, undefined, 'briefings never had it');
  assert.equal(briefing.agent_brief.length > 100, true);
});

test('list_projects returns only key, name, description and counts over MCP', async () => {
  const projects = await s.rpc('list_projects', {});
  for (const p of projects) assert.deepEqual(Object.keys(p), ['key', 'name', 'description', 'task_counts']);
  const http = (await s.call('GET', '/api/projects')).body.find((p) => p.key === 'CR');
  assert.ok(http.agent_brief && http.checks, 'HTTP is unchanged');
});
