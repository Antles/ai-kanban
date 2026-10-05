import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'IE', name: 'Import Export' });
});
after(() => s.close());

const PAYLOAD = [
  { external_id: 'E1', type: 'epic', title: 'Safety nets', description: 'Guardrails first.' },
  { external_id: 'T01', title: 'Repo guardrails', status: 'todo', priority: 'high', estimate: 2, epic: 'E1', criteria: ['gitignore covers secrets'] },
  { external_id: 'T02', title: 'Core project', status: 'todo', epic: 'E1', depends_on: ['T01'], criteria: ['[director] Builds on your machine'] },
  { external_id: 'T03', title: 'Loose task', labels: ['docs'] },
];

test('external_id is unique per project, searchable, and settable on create and update', async () => {
  const a = await s.call('POST', '/api/tasks', { project: 'IE', title: 'a', external_id: 'X1' });
  assert.equal(a.body.external_id, 'X1');
  const dup = await s.call('POST', '/api/tasks', { project: 'IE', title: 'b', external_id: 'X1' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already IE-1/);
  assert.equal((await s.call('POST', '/api/tasks', { project: 'IE', title: 'c', external_id: 'bad id!' })).status, 400);
  // Another project may reuse it.
  await s.call('POST', '/api/projects', { key: 'IO' });
  assert.equal((await s.call('POST', '/api/tasks', { project: 'IO', title: 'x', external_id: 'X1' })).status, 201);
  assert.deepEqual((await s.call('GET', '/api/tasks?project=IE&external_id=X1')).body.map((t) => t.key), ['IE-1']);
  assert.deepEqual((await s.call('GET', '/api/tasks?project=IE&q=X1')).body.map((t) => t.key), ['IE-1']);
  const renamed = await s.call('PATCH', '/api/tasks/IE-1', { external_id: null });
  assert.equal(renamed.body.external_id, null);
  await s.call('DELETE', '/api/tasks/IE-1');
});

test('import upserts on external_id, links by external_id, and re-importing changes nothing', async () => {
  const first = await s.call('POST', '/api/projects/IE/import', { tasks: PAYLOAD });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.created.map((c) => c.external_id), ['E1', 'T01', 'T02', 'T03']);
  assert.deepEqual([first.body.updated, first.body.unchanged], [[], []]);
  const [t1, t2] = (await s.call('GET', '/api/tasks?project=IE&external_id=T01,T02')).body.sort((x, y) => x.number - y.number);
  const epic = (await s.call('GET', '/api/tasks?project=IE&external_id=E1')).body[0];
  assert.equal(epic.type, 'epic');
  assert.equal(epic.status, 'todo');
  assert.equal(t1.epic, epic.key);
  assert.deepEqual(t2.depends_on, [t1.key]);
  assert.equal(t2.criteria[0].owner, 'human');

  const again = await s.call('POST', '/api/projects/IE/import', { tasks: PAYLOAD });
  assert.deepEqual(again.body.created, []);
  assert.deepEqual(again.body.updated, []);
  assert.equal(again.body.unchanged.length, 4);
  assert.equal((await s.call('GET', '/api/tasks?project=IE')).body.length, 4, 'no duplicates');

  // A changed payload updates in place, keeping fields it doesn't mention (like agent progress).
  await s.call('POST', `/api/tasks/${t1.key}/claim`, {}, 'agent');
  const changed = PAYLOAD.map((p) => (p.external_id === 'T01' ? { ...p, status: undefined, priority: 'urgent' } : p));
  changed.push({ external_id: 'T04', title: 'New one', depends_on: ['T02'] });
  const third = await s.call('POST', '/api/projects/IE/import', { tasks: changed });
  assert.deepEqual(third.body.updated.map((u) => u.external_id), ['T01']);
  assert.deepEqual(third.body.created.map((u) => u.external_id), ['T04']);
  const t1After = (await s.call('GET', `/api/tasks/${t1.key}`)).body;
  assert.deepEqual([t1After.priority, t1After.status, t1After.assignee], ['urgent', 'in_progress', 'agent']);
});

test('import is all or nothing and names the bad item', async () => {
  const before = (await s.call('GET', '/api/tasks?project=IE')).body.length;
  const res = await s.call('POST', '/api/projects/IE/import', { tasks: [{ external_id: 'T09', title: 'ok' }, { external_id: 'T10', status: 'nope', title: 'x' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^tasks\[1\] \(T10\): Invalid status/);
  assert.equal((await s.call('GET', '/api/tasks?project=IE')).body.length, before);
  assert.match((await s.call('POST', '/api/projects/IE/import', { tasks: [{ title: 'no id' }] })).body.error, /external_id is required/);
  assert.match((await s.call('POST', '/api/projects/IE/import', { tasks: [{ external_id: 'A', title: 'a' }, { external_id: 'A', title: 'b' }] })).body.error, /appears twice/);
});

test('export.md lists epics and tasks with status, criteria and dependencies, stably', async () => {
  const res = await s.call('GET', '/api/projects/IE/export.md');
  assert.equal(res.status, 200);
  const md = res.body;
  assert.match(md, /^# Import Export \(IE\)/);
  assert.match(md, /## Safety nets \(IE-\d+ · E1\)/);
  assert.match(md, /### IE-\d+ · T01 · Repo guardrails\n\n- \*\*Status:\*\* In Progress · \*\*Priority:\*\* urgent · \*\*Type:\*\* task · \*\*Estimate:\*\* 2 · \*\*Assignee:\*\* agent/);
  assert.match(md, /- \*\*Depends on:\*\* IE-\d+ \(T01\)/);
  assert.match(md, /- \[ \] \(Director\) Builds on your machine/);
  assert.match(md, /## Not in an epic[\s\S]*Loose task/);
  assert.doesNotMatch(md, /\d{4}-\d{2}-\d{2}T/, 'no timestamps, so re-exports diff cleanly');
  assert.equal((await s.call('GET', '/api/projects/IE/export.md')).body, md);
});

test('import and export over MCP', async () => {
  await s.call('POST', '/api/projects', { key: 'IM' });
  const res = await s.rpc('import_tasks', { project: 'IM', tasks: [{ external_id: 'T1', title: 'from mcp', status: 'todo' }] });
  assert.equal(res.created[0].external_id, 'T1');
  const found = await s.rpc('list_tasks', { project: 'IM', external_id: 'T1' });
  assert.equal(found[0].title, 'from mcp');
  const exportRes = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_markdown', arguments: { project: 'IM' } } }),
  }).then((r) => r.json());
  assert.match(exportRes.result.content[0].text, /### IM-1 · T1 · from mcp/);
});

test('import satisfies a required epic through its epic link', async () => {
  await s.call('POST', '/api/projects', { key: 'IR', required_fields: ['epic'] });
  const res = await s.rpc('import_tasks', {
    project: 'IR',
    tasks: [
      { external_id: 'E1', type: 'epic', title: 'Epic' },
      { external_id: 'T1', title: 'In the epic', epic: 'E1' },
    ],
  });
  assert.deepEqual(res.created?.map((c) => c.external_id), ['E1', 'T1']);
  assert.match((await s.rpc('import_tasks', { project: 'IR', tasks: [{ external_id: 'T2', title: 'no epic', status: 'todo' }] })).error, /epic is required/);
});
