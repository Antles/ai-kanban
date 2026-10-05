import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.call('POST', '/api/projects', { key: 'BS', agent_brief: 'Portrait 1080x1920.' });
});
after(() => s.close());

test('brief sections are appended to agent_brief only for matching tasks', async () => {
  const epic = await s.call('POST', '/api/projects/BS/epics', { title: 'Signature layers' });
  assert.equal((await s.director('PATCH', '/api/projects/BS', { brief_sections: [{ body: 'x' }] })).status, 400, 'a section needs a condition');
  assert.equal((await s.director('PATCH', '/api/projects/BS', { brief_sections: [{ match: { type: 'nope' }, body: 'x' }] })).status, 400);
  const saved = await s.director('PATCH', '/api/projects/BS', {
    brief_sections: [
      { title: 'Unity tasks', match: { labels: ['Unity'] }, body: 'Run ./tools/unity-test.sh.' },
      { match: { epic: 'signature layers', type: ['bug'] }, body: 'Add a golden replay for every bug.' },
      { title: 'By key', match: { epic: epic.body.key }, body: 'Read docs/combat.md §4.' },
    ],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.brief_sections[1].match, { epic: 'signature layers', type: ['bug'] });

  const brief = async (task) => (await s.call('POST', `/api/tasks/${task.key}/claim`, {}, 'agent')).body;
  const mk = async (fields) => (await s.call('POST', '/api/tasks', { project: 'BS', title: 't', status: 'todo', ...fields })).body;

  const unity = await brief(await mk({ labels: ['unity', 'ui'] }));
  assert.equal(unity.agent_brief, 'Portrait 1080x1920.\n\n## Unity tasks\n\nRun ./tools/unity-test.sh.');
  assert.deepEqual(unity.brief_sections, ['Unity tasks']);

  const plain = await brief(await mk({ labels: ['core'] }));
  assert.equal(plain.agent_brief, 'Portrait 1080x1920.', 'the main brief is exactly as before');
  assert.equal(plain.brief_sections, undefined);

  // Epic by title AND type bug; the epic-by-key section also applies.
  const bug = await brief(await mk({ type: 'bug', epic: epic.body.key }));
  assert.deepEqual(bug.brief_sections, ['For bug tasks, epic signature layers', 'By key']);
  assert.match(bug.agent_brief, /golden replay/);
  const feature = await brief(await mk({ type: 'feature', epic: epic.body.key }));
  assert.deepEqual(feature.brief_sections, ['By key'], 'type must match too');

  // get_task stays the raw task; the composed brief is for briefings.
  const viaMcp = await s.rpc('claim_task', { task: (await mk({ labels: ['unity'] })).key });
  assert.match(viaMcp.agent_brief, /## Unity tasks/);
});

test('a project with sections but no main brief gets just the sections', async () => {
  await s.call('POST', '/api/projects', { key: 'BN', brief_sections: [{ match: { labels: ['art'] }, body: 'Use the palette.' }] });
  const t = await s.call('POST', '/api/tasks', { project: 'BN', title: 'sprite', status: 'todo', labels: ['art'] });
  const b = await s.call('POST', `/api/tasks/${t.body.key}/claim`, {}, 'agent');
  assert.equal(b.body.agent_brief, '## For tasks labeled art\n\nUse the palette.');
  const u = await s.director('PATCH', '/api/projects/BN', { brief_sections: null });
  assert.deepEqual(u.body.brief_sections, []);
});
