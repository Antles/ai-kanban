import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, fuzzyRank } from '../public/fuzzy.js';

test('letters must appear in order; prefixes and word starts win', () => {
  assert.equal(fuzzyScore('xyz', 'Repo guardrails'), -1);
  assert.ok(fuzzyScore('rg', 'Repo guardrails') > 0, 'r…g at word starts');
  assert.ok(fuzzyScore('as-12', 'AS-12') > fuzzyScore('as-12', 'Something AS-12'));
  assert.ok(fuzzyScore('guard', 'Repo guardrails') > fuzzyScore('guard', 'g u a r d spaced'));
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('ranking puts the best match first, then the most recent', () => {
  const items = [
    { key: 'AS-1', label: 'Repo guardrails' },
    { key: 'AS-12', label: 'L3: Burst' },
    { key: 'AS-2', label: 'Core project and the test runner' },
  ];
  const texts = (t) => [t.key, t.label];
  assert.deepEqual(fuzzyRank(items, 'as-12', texts).map((t) => t.key)[0], 'AS-12');
  assert.deepEqual(fuzzyRank(items, 'test runner', texts).map((t) => t.key), ['AS-2']);
  const recent = (t) => ({ 'AS-2': 0, 'AS-1': 1 })[t.key] ?? Infinity;
  assert.deepEqual(fuzzyRank(items, 'as', texts, recent).map((t) => t.key).slice(0, 2), ['AS-2', 'AS-1'], 'equal scores: recent first');
  assert.equal(fuzzyRank(items, '', texts).length, 3);
});
