// What a board card should signal at a glance (tested in test/card-state.test.js).

// The first state that needs a human, in order of precedence, or null for a neutral edge:
// waiting on the Director's answer, blocked by the Director's setup step, sent back for rework, stale.
export function cardEdge(t) {
  if (t.waiting_on_director) return 'waiting';
  if (t.pending_prerequisites?.length) return 'setup';
  if (t.rework) return 'rework';
  if (t.stale_claim) return 'stale';
  return null;
}

// Blocked only by other tasks: nothing for anyone to do on it yet, so it renders quieter.
export const quietCard = (t) => Boolean(t.blocked_by?.length) && !t.pending_prerequisites?.length && !cardEdge(t) && t.status !== 'done';
