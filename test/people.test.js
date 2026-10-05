import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, hue } from '../public/people.js';

test('initials use the first and the last part of a name', () => {
  assert.equal(initials('claude-code'), 'CC');
  assert.equal(initials('claude-code-b'), 'CB');
  assert.equal(initials('director'), 'D');
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('mcp_agent.two'), 'MT');
  assert.equal(initials('agent-a'), 'AA');
  assert.equal(initials(''), '?');
  assert.notEqual(initials('claude-code'), initials('claude-code-b'));
});

test('hues are stable and in range', () => {
  assert.equal(hue('claude-code'), hue('claude-code'));
  for (const name of ['a', 'claude-code', 'claude-code-b', 'director']) {
    assert.ok(hue(name) >= 0 && hue(name) < 360);
  }
});
