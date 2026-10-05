// Icons for the board and the Capture page. General icons are Lucide symbols in /icons.svg
// (ISC, see icons-LICENSE.txt); status and priority icons are drawn here, Linear style.
// Decorative icons are aria-hidden; pass a label to make one meaningful on its own.

const STATUS_NAMES = { backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
// How much of the inner disc is filled: the status as progress.
const STATUS_FILL = { todo: 0, in_progress: 0.5, review: 0.75 };
const PRIORITY_BARS = { low: 1, medium: 2, high: 3 };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const a11y = (label) => (label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"');

export function icon(name, { label, size = 16, cls = '' } = {}) {
  return `<svg class="icon${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" ${a11y(label)} focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
}

export const statusName = (status) => STATUS_NAMES[status] ?? String(status);

// Backlog: dashed circle. To Do: empty circle. In Progress / Review: a part-filled disc. Done: check circle.
// The <title> is the tooltip; pass decorative: true when the status name is printed next to it.
export function statusIcon(status, { size = 14, decorative = false } = {}) {
  const name = statusName(status);
  let inner;
  if (status === 'backlog') {
    inner = '<circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.1 1.6"/>';
  } else if (status === 'done') {
    inner = '<circle cx="7" cy="7" r="6.75" fill="currentColor"/><path class="tick" d="M4.2 7.3 6.1 9.1 9.8 5.2" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  } else {
    const fill = STATUS_FILL[status] ?? 0;
    // A stroked r=2 circle as wide as its radius paints a pie wedge; the dash length sets the angle.
    const wedge = fill
      ? `<circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="${(fill * 4 * Math.PI).toFixed(2)} 13" transform="rotate(-90 7 7)"/>`
      : '';
    inner = `<circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>${wedge}`;
  }
  const label = decorative ? '' : name;
  return `<svg class="status-icon s-${esc(status)}" viewBox="0 0 14 14" width="${size}" height="${size}" ${a11y(label)} focusable="false">${
    decorative ? '' : `<title>${esc(name)}</title>`
  }${inner}</svg>`;
}

// Low/medium/high: one to three signal bars. Urgent: a filled badge with an exclamation mark.
export function priorityIcon(priority, { size = 14, decorative = false } = {}) {
  const label = `${String(priority).charAt(0).toUpperCase()}${String(priority).slice(1)} priority`;
  let inner;
  if (priority === 'urgent') {
    inner = '<rect x="1" y="1" width="14" height="14" rx="3.5" fill="currentColor"/><path class="mark" d="M8 4.3v4.6" stroke-width="2" stroke-linecap="round"/><circle class="mark-dot" cx="8" cy="11.7" r="1.15"/>';
  } else {
    const on = PRIORITY_BARS[priority] ?? 0;
    inner = [5, 8.5, 12]
      .map((h, i) => `<rect x="${1.5 + i * 5}" y="${14 - h}" width="3" height="${h}" rx="1" fill="currentColor"${i < on ? '' : ' opacity="0.3"'}/>`)
      .join('');
  }
  return `<svg class="prio-icon p-${esc(priority)}" viewBox="0 0 16 16" width="${size}" height="${size}" ${a11y(decorative ? '' : label)} focusable="false">${
    decorative ? '' : `<title>${esc(label)}</title>`
  }${inner}</svg>`;
}
