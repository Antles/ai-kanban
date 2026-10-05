import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

// Claude Code cuts MCP server instructions at about 2,000 characters, so they must fit, rules first.
let s;
let text;
before(async () => {
  s = await startServer();
  text = (await s.mcp('initialize', { protocolVersion: '2025-06-18' })).instructions;
});
after(() => s.close());

test('the MCP instructions are at most 2,000 characters', () => {
  assert.ok(text.length <= 2000, `${text.length} characters`);
});

test('they cover the rules that change what an agent does', () => {
  for (const [rule, re] of [
    ['the workflow', /claim_next_task.*check_criteria.*submit_for_review/s],
    ['agents close their own tasks', /move_task to done\. Needs the Director \(needs_review, Director criteria/],
    ['agents run the sprints', /You run sprints: start the next planned one if none is active/],
    ['Director-only actions', /Director only \(403.*review verdicts.*project settings, unlock labels/],
    ['scope and protected paths', /Stay inside the task's scope and never touch protected_paths/],
    ['stale context', /stale_context.*recheck_context/],
    ['dangling references', /dangling_references.*ask_director/],
    ['a blocking question keeps the claim', /blocking question parks the task, but you keep the claim/],
    ['warnings never block', /never block/],
    ['the guide', /GET \/api\/guide/],
  ]) {
    assert.match(text, re, rule);
  }
});
