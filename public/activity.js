// Shapes the Activity feed (tested in test/activity.test.js): day sections, and consecutive actions by
// one actor on one task within a few minutes merged into a single entry.

export const MERGE_WINDOW_MS = 5 * 60 * 1000;

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

// "Today", "Yesterday", then "Mon, Sep 28" (with the year when it isn't this year).
export function dayLabel(iso, now = new Date()) {
  const date = new Date(iso);
  if (dayKey(date) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
}

// items: activity newest first. Returns [{day, entries: [{actor, task, items}]}], where items are the
// merged activity rows, newest first. Rows merge when they're adjacent, by the same actor, on the same
// task, and within MERGE_WINDOW_MS of the previous row in the entry.
export function groupActivity(items, now = new Date()) {
  const days = [];
  for (const a of items) {
    const day = dayLabel(a.created_at, now);
    let section = days.at(-1);
    if (section?.day !== day) {
      section = { day, entries: [] };
      days.push(section);
    }
    const last = section.entries.at(-1);
    const prev = last?.items.at(-1);
    const mergeable =
      last && a.task && last.task === a.task && last.actor === a.actor && Date.parse(prev.created_at) - Date.parse(a.created_at) <= MERGE_WINDOW_MS;
    if (mergeable) last.items.push(a);
    else section.entries.push({ actor: a.actor, task: a.task, items: [a] });
  }
  return days;
}
