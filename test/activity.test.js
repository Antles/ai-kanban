import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupActivity, dayLabel } from '../public/activity.js';

const now = new Date('2026-09-30T18:00:00');
const at = (iso) => new Date(iso).toISOString();
const row = (id, actor, task, time, action = 'updated') => ({ id, actor, task, action, created_at: at(time), detail: {} });

test('day labels: Today, Yesterday, then dates', () => {
  assert.equal(dayLabel(at('2026-09-30T08:00:00'), now), 'Today');
  assert.equal(dayLabel(at('2026-09-29T23:59:00'), now), 'Yesterday');
  assert.match(dayLabel(at('2026-09-27T12:00:00'), now), /Sep 27/);
  assert.match(dayLabel(at('2025-09-27T12:00:00'), now), /2025/);
});

test('consecutive rows by one actor on one task within 5 minutes merge; anything else starts an entry', () => {
  const items = [
    row(6, 'claude-code', 'KB-1', '2026-09-30T17:10:00', 'submitted'),
    row(5, 'claude-code', 'KB-1', '2026-09-30T17:07:00', 'criteria_checked'),
    row(4, 'claude-code', 'KB-1', '2026-09-30T17:04:00', 'claimed'), // 3 min before the previous row
    row(3, 'claude-code', 'KB-1', '2026-09-30T16:50:00'), // 14 minutes: new entry
    row(2, 'human', 'KB-1', '2026-09-30T16:49:00'), // another actor
    row(1, 'human', 'KB-2', '2026-09-30T16:48:00'), // another task
    row(0, 'human', 'KB-2', '2026-09-29T16:47:00'), // yesterday: new day, new entry
  ];
  const days = groupActivity(items, now);
  assert.deepEqual(days.map((d) => d.day), ['Today', 'Yesterday']);
  assert.deepEqual(
    days[0].entries.map((e) => e.items.map((i) => i.id)),
    [[6, 5, 4], [3], [2], [1]],
  );
  assert.deepEqual(days[1].entries.map((e) => e.items.map((i) => i.id)), [[0]]);
});

test('rows without a task never merge', () => {
  const days = groupActivity([row(2, 'human', null, '2026-09-30T17:00:00', 'sprint_created'), row(1, 'human', null, '2026-09-30T16:59:00', 'sprint_created')], now);
  assert.equal(days[0].entries.length, 2);
});
