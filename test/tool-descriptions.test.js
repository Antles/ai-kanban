import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// The tool descriptions are the one text an agent is sure to see in full, so they say who may set a
// field and how to do what they point to.
let s;
let tools;
before(async () => {
  s = await startServer();
  tools = Object.fromEntries((await s.mcp('tools/list')).tools.map((t) => [t.name, t]));
});
after(() => s.close());

const prop = (tool, name) => tools[tool].inputSchema.properties[name];

test('create_tasks says project is required unless parent is given', () => {
  assert.match(prop('create_tasks', 'tasks').items.properties.project.description, /Required unless parent is given/);
});

test('labels say which values are Director-only; scope says how to widen it', () => {
  assert.match(prop('create_task', 'labels').description, /unlock label \(e\.g\. golden-change\) is Director-only; ask_director for it/);
  assert.match(prop('create_task', 'scope').description, /Widen via update_task\./);
  // The update and batch tools share create_task's field docs (KB-32).
  assert.equal(prop('update_task', 'scope').description, 'See create_task.');
});

test("claim_task's force is Director only", () => {
  assert.match(prop('claim_task', 'force').description, /^Director only/);
});

test("submit_for_review's media gives the upload recipe and says local paths are stored as text", () => {
  const media = prop('submit_for_review', 'media').description;
  assert.match(media, /POST \/api\/tasks\/:key\/attachments\?filename=NAME \(raw file body, its Content-Type, X-Agent header\)/);
  assert.match(media, /local paths are stored as text and can't be opened/);
  assert.match(media, /"repo:<path>"/);
});

test('claim_next_task says stale_context and dangling_references need repo_path', () => {
  assert.match(tools.claim_next_task.description, /stale_context, missing_context and dangling_references \(these need the project's repo_path\)/);
});
