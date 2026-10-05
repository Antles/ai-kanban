// All board logic lives here. The REST API and the MCP endpoint are thin
// adapters over this class, so both behave identically.
import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, matchesGlob, globsOverlap } from './glob.js';
import { GitReader, GitError } from './git.js';
import { parseGlossary, lintGlossary, glossaryWarning } from './glossary.js';
import { matchAllSafe, REGEX_BUDGET_MS } from './safe-regex.js';

export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];
export const STATUS_NAMES = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
// "epic" is special: epics group tasks, never appear as board cards, and can't be claimed.
export const TYPES = ['task', 'feature', 'bug', 'chore', 'spike', 'epic'];
export const MILESTONE_STATUSES = ['open', 'closed'];
export const SPRINT_STATUSES = ['planned', 'active', 'completed'];
export const REVIEW_VERDICTS = ['accept', 'changes'];
// Screenshots, clips and logs from quick captures or agent handoffs. Served back with these
// exact types, so nothing that a browser would execute (HTML, SVG) is allowed.
export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'text/plain',
  'application/json',
];
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Types for files attached from the repo by path (submit media "repo:<path>"), by extension.
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
};
// Who may tick a criterion. "human" items are the Director's to verify (e.g. "readable on your phone").
export const CRITERION_OWNERS = ['agent', 'human'];
// Requests from the board UI are the Director (see resolveRole in server.js). Everything else (agents, MCP) is an agent.
export const ROLES = ['agent', 'director'];
// Assignee names that mean "the human". Tasks assigned to one of them are gates in the Director inbox.
export const DIRECTOR_NAMES = (process.env.DIRECTOR_NAMES ?? 'director,human')
  .split(',')
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);

const STATUS_ALIASES = {
  to_do: 'todo',
  ready: 'todo',
  inprogress: 'in_progress',
  doing: 'in_progress',
  in_review: 'review',
  complete: 'done',
  completed: 'done',
};

const VERDICT_ALIASES = {
  accepted: 'accept',
  approve: 'accept',
  approved: 'accept',
  reject: 'changes',
  rejected: 'changes',
  request_changes: 'changes',
  changes_requested: 'changes',
};

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const TASK_SELECT = `
  SELECT t.*, p.key AS project_key,
    (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM attachments x WHERE x.task_id = t.id) AS attachment_count,
    (SELECT COUNT(*) FROM questions oq WHERE oq.task_id = t.id AND oq.answered_at IS NULL) AS open_questions,
    (SELECT MAX(la.created_at) FROM activity la WHERE la.task_id = t.id) AS last_activity_at,
    (SELECT oq.question FROM questions oq WHERE oq.task_id = t.id AND oq.answered_at IS NULL AND oq.blocking = 1
     ORDER BY oq.id LIMIT 1) AS waiting_question,
    CASE WHEN pt.id IS NULL THEN NULL ELSE pp.key || '-' || pt.number END AS parent_key,
    m.name AS milestone_name,
    CASE WHEN et.id IS NULL THEN NULL ELSE p.key || '-' || et.number END AS epic_key,
    s.name AS sprint_name
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN tasks pt ON pt.id = t.parent_id
  LEFT JOIN projects pp ON pp.id = pt.project_id
  LEFT JOIN milestones m ON m.id = t.milestone_id
  LEFT JOIN tasks et ON et.id = t.epic_id
  LEFT JOIN sprints s ON s.id = t.sprint_id`;

const RELATED_SELECT = `
  SELECT t.id, p.key || '-' || t.number AS key, t.title, t.status, t.assignee
  FROM tasks t JOIN projects p ON p.id = t.project_id`;

const DEPENDENCIES_SQL = `${RELATED_SELECT}
  JOIN task_dependencies d ON d.depends_on_id = t.id
  WHERE d.task_id = ? ORDER BY p.key, t.number`;

const DEPENDENTS_SQL = `${RELATED_SELECT}
  JOIN task_dependencies d ON d.task_id = t.id
  WHERE d.depends_on_id = ? ORDER BY p.key, t.number`;

const SUBTASKS_SQL = `${RELATED_SELECT} WHERE t.parent_id = ? ORDER BY t.number`;

const STATUS_ORDER_SQL = `CASE t.status ${STATUSES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END`;
const PRIORITY_RANK_SQL = `CASE t.priority ${PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(' ')} END`;
// Columns are ordered by priority (highest first), then by manual position.
// claim-next hands out work in exactly this order, so the board shows what agents will get.
const BOARD_ORDER_SQL = `${PRIORITY_RANK_SQL} DESC, t.position, t.id`;
const priorityRank = (priority) => PRIORITIES.indexOf(priority);
const NOT_EPIC_SQL = "t.type <> 'epic'";
const UNFINISHED_DEPENDENCY_SQL = `EXISTS (
  SELECT 1 FROM task_dependencies d JOIN tasks dt ON dt.id = d.depends_on_id
  WHERE d.task_id = t.id AND dt.status <> 'done')`;

// Something the human must do before an agent can start (install an SDK, set up a device).
const OPEN_PREREQUISITE_SQL = `EXISTS (
  SELECT 1 FROM json_each(t.prerequisites) WHERE json_extract(json_each.value, '$.done') = 0)`;
// Blocked = waiting on unfinished dependencies or on the human's prerequisites.
const BLOCKED_SQL = `(${UNFINISHED_DEPENDENCY_SQL} OR ${OPEN_PREREQUISITE_SQL})`;

// A blocking question the Director hasn't answered yet.
const WAITING_SQL = `EXISTS (
  SELECT 1 FROM questions wq WHERE wq.task_id = t.id AND wq.blocking = 1 AND wq.answered_at IS NULL)`;

// Upstream handoff summaries in briefings are trimmed to about this many characters.
const UPSTREAM_SUMMARY_CHARS = 1500;

const now = () => new Date().toISOString();
const taskKey = (row) => `${row.project_key}-${row.number}`;

function text(value, field, { max = 10000, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, `${field} is required`);
    return value;
  }
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string`);
  const v = value.trim();
  if (required && !v) throw new ApiError(400, `${field} is required`);
  if (v.length > max) throw new ApiError(400, `${field} must be at most ${max} characters`);
  return v;
}

function oneOf(value, allowed, field) {
  const v = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!allowed.includes(v)) {
    throw new ApiError(400, `Invalid ${field} "${value}". Expected one of: ${allowed.join(', ')}`);
  }
  return v;
}

function normStatus(value) {
  const v = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return oneOf(STATUS_ALIASES[v] ?? v, STATUSES, 'status');
}

// Accepts an array or a comma-separated string.
function csv(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function normLabels(value) {
  const labels = [...new Set(csv(value))];
  if (labels.some((l) => l.length > 50)) throw new ApiError(400, 'labels must be at most 50 characters each');
  if (labels.length > 30) throw new ApiError(400, 'at most 30 labels per task');
  return labels;
}

function agentName(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const v = String(value).trim();
  if (v.length > 64) throw new ApiError(400, 'agent/assignee names must be at most 64 characters');
  return v || null;
}

function normEstimate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new ApiError(400, 'estimate must be a whole number of points (0-1000) or null');
  return n;
}

function isoDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const v = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new ApiError(400, `${field} must be YYYY-MM-DD (or null)`);
  return v;
}

const today = () => new Date().toISOString().slice(0, 10);

// Accepts an array or a newline-separated string (paths and URLs may contain commas).
function lines(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split('\n');
  return list.map((v) => String(v).trim()).filter(Boolean);
}

const CHECKBOX_RE = /^\s*(?:[-*+]\s+)?\[([ xX])\]\s+(.*)$/;
const CHECKBOX_LINE_RE = /^\s*[-*+]\s+\[[ xX]\]\s+\S/;
const OWNER_TAG_RE = /^\s*\[(human|director)\]\s*/i;

function normOwner(value) {
  const v = String(value).trim().toLowerCase();
  return oneOf(v === 'director' ? 'human' : v, CRITERION_OWNERS, 'owner');
}

// One checklist entry: a string ("- [x] text", "[director] text") or {text, done, owner?, evidence?}.
function parseCheckItem(item, field) {
  let raw = typeof item === 'string' ? item : item?.text;
  if (typeof raw !== 'string') throw new ApiError(400, `${field} items must be strings or {text, done} objects`);
  const obj = typeof item === 'object' ? item : {};
  let done = typeof obj.done === 'boolean' ? obj.done : undefined;
  let owner = obj.owner === undefined || obj.owner === null ? undefined : normOwner(obj.owner);
  const evidence = obj.evidence === undefined ? undefined : text(obj.evidence, 'evidence', { max: 2000 }) || null;
  const m = raw.match(CHECKBOX_RE);
  if (m) {
    raw = m[2];
    done ??= m[1] !== ' ';
  }
  raw = raw.replace(/^\s*[-*+]\s+/, '');
  const tag = raw.match(OWNER_TAG_RE);
  if (tag) {
    raw = raw.slice(tag[0].length);
    owner ??= 'human';
  }
  const value = raw.trim();
  if (!value) return null;
  if (value.length > 500) throw new ApiError(400, `${field} items must be at most 500 characters`);
  return { text: value, done, owner, evidence };
}

// Criteria as stored before owners existed load as agent-owned.
const readCriteria = (json) =>
  JSON.parse(json).map((c) => ({ text: c.text, done: c.done, owner: c.owner ?? 'agent', ...(c.evidence && { evidence: c.evidence }) }));

// Acceptance criteria: a checklist of {text, done, owner, evidence?}. Items may be strings
// (optionally "- [ ] ..." / "- [x] ...", and "[director] ..." for a human-owned item) or objects.
// A plain string keeps the state of an existing item with the same text (tick, owner, evidence),
// so agents can rewrite the list without losing anything.
function normCriteria(value, existing = []) {
  if (value === undefined) return undefined;
  const list = value === null || value === '' ? [] : Array.isArray(value) ? value : String(value).split('\n');
  const before = new Map(existing.map((c) => [c.text, c]));
  const items = [];
  for (const entry of list) {
    const parsed = parseCheckItem(entry, 'criteria');
    if (!parsed) continue;
    const prev = before.get(parsed.text);
    const item = { text: parsed.text, done: parsed.done ?? prev?.done ?? false, owner: parsed.owner ?? prev?.owner ?? 'agent' };
    const evidence = parsed.evidence === undefined ? prev?.evidence : parsed.evidence;
    if (evidence) item.evidence = evidence;
    items.push(item);
  }
  if (items.length > 50) throw new ApiError(400, 'at most 50 acceptance criteria per task');
  return items;
}

// The repo path in a context entry ("docs/auth.md", "docs/auth.md#sessions", "docs/auth.md §4"),
// or null for URLs and task keys.
function contextPath(ref) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) || /^[A-Z][A-Z0-9]*-\d+$/.test(ref)) return null;
  const p = ref.split(/[\s#]/)[0].replace(/^\.\//, '');
  return p && !p.startsWith('-') && !p.startsWith('/') ? p : null;
}

// An ID from outside the board (a backlog doc's "T07"), unique per project.
function normExternalId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const v = String(value).trim();
  if (!/^[\w.:-]{1,64}$/.test(v)) throw new ApiError(400, 'external_id must be 1-64 letters, digits or . _ : -');
  return v;
}

// A resume note for a partly finished task: what's done, what's next, the branch. One per task;
// a new one replaces the old.
function makeCheckpoint(value, actor) {
  const body = text(value, 'checkpoint', { max: 20000 });
  return body ? JSON.stringify({ body, by: actor, at: now() }) : null;
}

// Task scope: globs of the files the task may change.
function normScope(value) {
  if (value === undefined) return undefined;
  return globList(value ?? [], 'scope');
}

const fileList = (files, max = 5) => `${files.slice(0, max).join(', ')}${files.length > max ? ` and ${files.length - max} more` : ''}`;

// Prerequisites: a checklist of {text, done, added_at} the human works through before an agent starts.
function normPrerequisites(value, existing = []) {
  if (value === undefined) return undefined;
  const list = value === null || value === '' ? [] : Array.isArray(value) ? value : String(value).split('\n');
  const before = new Map(existing.map((p) => [p.text, p]));
  const items = [];
  const ts = now();
  for (const entry of list) {
    const parsed = parseCheckItem(entry, 'prerequisites');
    if (!parsed) continue;
    const prev = before.get(parsed.text);
    items.push({ text: parsed.text, done: parsed.done ?? prev?.done ?? false, added_at: prev ? prev.added_at : ts });
  }
  if (items.length > 30) throw new ApiError(400, 'at most 30 prerequisites per task');
  return items;
}

// Agents may add prerequisites, but only the human ticks, unticks or removes them.
function assertAgentPrerequisiteChange(key, before, after) {
  const next = new Map(after.map((p) => [p.text, p]));
  const prev = new Map(before.map((p) => [p.text, p]));
  const bad = before.find((p) => next.get(p.text)?.done !== p.done) ?? after.find((p) => !prev.has(p.text) && p.done);
  if (bad) {
    throw new ApiError(403, `Only the Director can tick, untick or remove prerequisites (on ${key}: "${bad.text}"). Agents may add new ones.`);
  }
}

// ------------------------------------------------------- project settings
// Optional per-project rules, stored as JSON in projects.settings and exposed as top-level
// project fields. Each entry validates a value and supplies the default (a project without
// settings behaves exactly as before).

const obj = (value, field) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, `${field} must be an object`);
  return value;
};
const list = (value, field, max) => {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw new ApiError(400, `${field} must be an array`);
  if (value.length > max) throw new ApiError(400, `${field}: at most ${max} entries`);
  return value;
};
const globList = (value, field) => {
  const globs = lines(Array.isArray(value) ? value : csv(value));
  if (globs.length > 50 || globs.some((g) => g.length > 300)) throw new ApiError(400, `${field}: at most 50 globs of 300 characters`);
  return globs;
};

const SETTINGS = {
  // Commands an agent runs before submitting; the server never runs them.
  checks: {
    default: [],
    norm(value) {
      const seen = new Set();
      return list(value, 'checks', 30).map((raw, i) => {
        const c = obj(raw, `checks[${i}]`);
        const name = text(c.name, `checks[${i}].name`, { max: 100, required: true });
        if (seen.has(name.toLowerCase())) throw new ApiError(400, `checks: duplicate name "${name}"`);
        seen.add(name.toLowerCase());
        const whenPaths = globList(c.required_when_paths, `checks[${i}].required_when_paths`);
        return {
          name,
          command: text(c.command, `checks[${i}].command`, { max: 2000, required: true }),
          required: c.required === true,
          ...(whenPaths.length && { required_when_paths: whenPaths }),
        };
      });
    },
  },
};

SETTINGS.brief_sections = {
  // Extra standing rules for some tasks: appended to agent_brief in briefings of tasks that match.
  default: [],
  norm(value) {
    return list(value, 'brief_sections', 30).map((raw, i) => {
      const sec = obj(raw, `brief_sections[${i}]`);
      const m = sec.match === undefined ? {} : obj(sec.match, `brief_sections[${i}].match`);
      const labels = normLabels(m.labels);
      const types = csv(m.type).map((t) => oneOf(t, TYPES, `brief_sections[${i}].match.type`));
      const epic = text(m.epic, `brief_sections[${i}].match.epic`, { max: 500 }) || null;
      if (!labels.length && !types.length && !epic) {
        throw new ApiError(400, `brief_sections[${i}].match needs labels, epic or type (the main agent_brief already applies to every task)`);
      }
      return {
        ...(sec.title && { title: text(sec.title, `brief_sections[${i}].title`, { max: 120 }) }),
        match: { ...(labels.length && { labels }), ...(epic && { epic }), ...(types.length && { type: types }) },
        body: text(sec.body, `brief_sections[${i}].body`, { max: 20000, required: true }),
      };
    });
  },
};

SETTINGS.repo_path = {
  // The project's git checkout, read-only. Enables the repo-aware checks.
  default: null,
  norm(value) {
    // Checked against git beforehand (Kanban.assertRepoPath), since that's asynchronous.
    const p = text(value, 'repo_path', { max: 1000 });
    if (!p) return null;
    return p.replace(/\/+$/, '') || '/';
  },
};

SETTINGS.base_branch = {
  // Where work merges; handoff diffs are taken from its merge base. Default: main, then master.
  default: null,
  norm(value) {
    const b = text(value, 'base_branch', { max: 200 });
    if (b && !/^[\w./-]+$/.test(b)) throw new ApiError(400, 'base_branch must be a branch name');
    return b || null;
  },
};

SETTINGS.protected_paths = {
  // Files agents must not touch unless the task carries the unlocking label (e.g. golden files).
  default: [],
  norm(value) {
    return list(value, 'protected_paths', 50).map((raw, i) => {
      const r = typeof raw === 'string' ? { glob: raw } : obj(raw, `protected_paths[${i}]`);
      const unlock = text(r.unlock_label, `protected_paths[${i}].unlock_label`, { max: 50 });
      return { glob: text(r.glob, `protected_paths[${i}].glob`, { max: 300, required: true }), ...(unlock && { unlock_label: unlock }) };
    });
  },
};

SETTINGS.reference_patterns = {
  // Rule IDs cited in tasks ("R-AUTH-2") and the doc that defines them. With repo_path, briefings
  // point each ID at its line and flag IDs the doc no longer contains.
  default: [],
  norm(value) {
    return list(value, 'reference_patterns', 20).map((raw, i) => {
      const r = obj(raw, `reference_patterns[${i}]`);
      const regex = text(r.regex, `reference_patterns[${i}].regex`, { max: 200, required: true });
      // Patterns run on every briefing; refuse nested quantifiers like (a+)+ that can backtrack forever.
      if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(regex)) {
        throw new ApiError(400, `reference_patterns[${i}].regex has a nested quantifier; use a simple pattern like "C-[A-Z]+-\\d+"`);
      }
      try {
        new RegExp(regex, 'g');
      } catch (err) {
        throw new ApiError(400, `reference_patterns[${i}].regex is not a valid regular expression: ${err.message}`);
      }
      const source = text(r.source, `reference_patterns[${i}].source`, { max: 500, required: true }).replace(/^\.\//, '');
      if (source.startsWith('-') || source.startsWith('/')) throw new ApiError(400, `reference_patterns[${i}].source must be a path inside the repo`);
      return { regex, source };
    });
  },
};

// Fields agents must set when creating a task (the board UI is exempt; its "missing fields" filter finds the gaps).
export const REQUIRABLE_FIELDS = ['priority', 'estimate', 'epic', 'criteria', 'labels'];
SETTINGS.required_fields = {
  default: [],
  norm(value) {
    return [...new Set(csv(value).map((f) => oneOf(f, REQUIRABLE_FIELDS, 'required field')))];
  },
};

SETTINGS.allowed_estimates = {
  // Story point values tasks may use, e.g. [1, 2, 3, 5, 8]. Empty: any whole number.
  default: [],
  norm(value) {
    const nums = csv(value).map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 1000)) throw new ApiError(400, 'allowed_estimates must be whole numbers (0-1000)');
    if (nums.length > 20) throw new ApiError(400, 'allowed_estimates: at most 20 values');
    return [...new Set(nums)].sort((a, b) => a - b);
  },
};

SETTINGS.glossary = {
  // [{term, avoid: [words], allow?: [phrases]}]: task text and handoffs using an avoided word get a warning.
  default: [],
  norm(value) {
    return list(value, 'glossary', 300).map((raw, i) => {
      const g = obj(raw, `glossary[${i}]`);
      const avoid = lines(Array.isArray(g.avoid) ? g.avoid : csv(g.avoid));
      const allow = lines(Array.isArray(g.allow) ? g.allow : csv(g.allow));
      if (!avoid.length) throw new ApiError(400, `glossary[${i}].avoid needs at least one word`);
      if ([...avoid, ...allow].some((w) => w.length > 100)) throw new ApiError(400, `glossary[${i}]: words must be at most 100 characters`);
      return { term: text(g.term, `glossary[${i}].term`, { max: 100, required: true }), avoid, ...(allow.length && { allow }) };
    });
  },
};

SETTINGS.stale_claim_hours = {
  // In-progress tasks with no activity for this long are flagged (the claim is kept). 0 turns it off.
  default: 24,
  norm(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 24 * 365) throw new ApiError(400, 'stale_claim_hours must be a number of hours (0 turns it off)');
    return n;
  },
};

SETTINGS.capture_label = {
  // The label quick captures (/capture) get, and the one triage looks for.
  default: 'capture',
  norm(value) {
    const [label, ...more] = normLabels(value);
    if (!label || more.length) throw new ApiError(400, 'capture_label must be one label');
    return label;
  },
};

const idleFor = (ms) => {
  const h = ms / 3600000;
  const n = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  return h >= 48 ? n(Math.floor(h / 24), 'day') : h >= 1 ? n(Math.floor(h), 'hour') : n(Math.max(1, Math.floor(h * 60)), 'minute');
};

// Which required fields a task (as stored) lacks.
function missingFields(task, required) {
  if (task.type === 'epic') return [];
  return required.filter((f) =>
    f === 'priority' ? false : f === 'estimate' ? task.estimate === null : f === 'epic' ? !task.epic : !task[f]?.length,
  );
}

// Required fields gate readiness, not capture: a backlog task may lack them until it moves to todo.
// Backlog tasks may lack required fields until they move to todo; past backlog they just aren't ready.
const readinessWarning = (missing, status = 'backlog') =>
  `Needs ${missing.join(', ')} ${status === 'backlog' ? 'before it can move to todo' : 'to be ready'}.`;
const withWarnings = (task, warnings) => (warnings.length ? { ...task, warnings: [...(task.warnings ?? []), ...warnings] } : task);

function checkEstimate(estimate, allowed, key) {
  if (estimate === null || estimate === undefined || !allowed.length || allowed.includes(estimate)) return;
  throw new ApiError(400, `estimate ${estimate} is not allowed${key ? ` on ${key}` : ''}; use one of ${allowed.join(', ')}`, { field: 'estimate' });
}

// A section matches when every condition it sets holds: any of its labels, the epic (key or title), the type.
function sectionMatches(section, task, epicTitle) {
  const { labels, epic, type } = section.match;
  if (labels && !labels.some((l) => task.labels.some((x) => x.toLowerCase() === l.toLowerCase()))) return false;
  if (type && !type.includes(task.type)) return false;
  if (epic && ![task.epic, epicTitle].some((e) => e && e.toLowerCase() === epic.toLowerCase())) return false;
  return true;
}

const sectionTitle = (sec) =>
  sec.title ??
  `For ${[
    sec.match.labels && `tasks labeled ${sec.match.labels.join(' or ')}`,
    sec.match.type && `${sec.match.type.join('/')} tasks`,
    sec.match.epic && `epic ${sec.match.epic}`,
  ]
    .filter(Boolean)
    .join(', ')}`;

function readSettings(row) {
  const stored = JSON.parse(row.settings ?? '{}');
  return Object.fromEntries(Object.entries(SETTINGS).map(([key, spec]) => [key, stored[key] ?? structuredClone(spec.default)]));
}

// Checks reported in a handoff: [{name, passed, output_tail?}].
function normCheckResults(value) {
  return list(value, 'checks', 50).map((raw, i) => {
    const r = obj(raw, `checks[${i}]`);
    if (typeof r.passed !== 'boolean') throw new ApiError(400, `checks[${i}].passed must be true or false`);
    const tail = text(r.output_tail, `checks[${i}].output_tail`, { max: 100000 });
    return {
      name: text(r.name, `checks[${i}].name`, { max: 100, required: true }),
      passed: r.passed,
      ...(tail && { output_tail: tail.slice(-4000) }),
    };
  });
}

// Which configured checks the handoff should have reported, and what it's missing.
function checkWarnings(checks, results, files) {
  const warnings = [];
  const warned = new Set();
  for (const c of checks) {
    const byPath = c.required_when_paths?.length ? files.filter((f) => matchesAny(f, c.required_when_paths)) : [];
    if (!c.required && !byPath.length) continue;
    const why = c.required ? 'required' : `required because you changed ${byPath.slice(0, 3).join(', ')}${byPath.length > 3 ? ', …' : ''}`;
    const r = results.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    if (!r) warnings.push(`Check "${c.name}" (${why}) was not reported. Run \`${c.command}\` and include the result in checks.`);
    else if (!r.passed) {
      warnings.push(`Check "${c.name}" (${why}) failed.`);
      warned.add(r.name.toLowerCase());
    }
  }
  // A failure is worth the reviewer's eye whether or not the project asked for that check.
  for (const r of results) {
    if (!r.passed && !warned.has(r.name.toLowerCase())) warnings.push(`Check "${r.name}" failed.`);
  }
  return warnings;
}

const humanItemError = (key, c) =>
  new ApiError(
    403,
    `"${c.text}" on ${key} is a Director criterion (owner: human): only the human can tick, untick, reassign or remove it. ` +
      'Do the work toward it and say in your submit summary how the Director can check it.',
    { owner: 'human', criterion: c.text },
  );

// Agents may add criteria (including Director ones) but never change the state of a Director item.
function assertAgentCriteriaChange(key, before, after) {
  const next = new Map(after.map((c) => [c.text, c]));
  for (const p of before) {
    if (p.owner !== 'human') continue;
    const c = next.get(p.text);
    if (!c || c.owner !== 'human' || c.done !== p.done || (c.evidence ?? null) !== (p.evidence ?? null)) throw humanItemError(key, p);
  }
  // No ticked Director item may appear unless it was already a ticked Director item (e.g. by flipping a ticked agent item's owner).
  const prev = new Map(before.map((c) => [c.text, c]));
  for (const c of after) {
    const p = prev.get(c.text);
    if (c.owner === 'human' && c.done && !(p?.owner === 'human' && p.done)) throw humanItemError(key, c);
    if (c.owner === 'human' && c.evidence && !(p?.owner === 'human' && p.evidence === c.evidence)) throw humanItemError(key, c);
  }
}

// On create, an agent may add Director criteria and prerequisites, but not already ticked ones
// (or ones carrying evidence: that's the Director's to judge).
const directorOnly = (what) => new ApiError(403, `Only the Director can ${what} (from the board). To propose it, ask_director on your task.`);

// Labels that unlock a protected path ("golden-change"): adding one lifts a guard, so only the Director may.
const unlockLabels = (settings) => new Set(settings.protected_paths.map((r) => r.unlock_label).filter(Boolean));

function assertAgentNewChecklists(criteria, prerequisites) {
  const ticked = criteria.find((c) => c.owner === 'human' && (c.done || c.evidence));
  if (ticked) throw humanItemError('a new task', ticked);
  const done = prerequisites.find((p) => p.done);
  if (done) throw new ApiError(403, `Only the Director can tick prerequisites ("${done.text}"); create it unticked.`);
}

// Appends extracted checklist lines to criteria, skipping texts already present. Only the Director's
// extraction keeps "[x]" on Director items; for agents they come out unticked.
function withExtracted(criteria, lines, role = 'agent') {
  const have = new Set(criteria.map((c) => c.text));
  const fresh = lines
    .map((l) => parseCheckItem(l, 'criteria'))
    .filter((c) => c && !have.has(c.text) && have.add(c.text))
    .map((c) => (role !== 'director' && c.owner === 'human' ? { ...c, done: false } : c));
  return normCriteria([...criteria, ...fresh], criteria);
}

// Moves "- [ ]" lines out of a Markdown description. A heading or bold label that only
// introduced those lines ("**Acceptance:**") goes too. Fenced code is left alone.
function extractChecklist(description) {
  const isLabel = (line) => /^\s*#{1,6}\s+\S/.test(line) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(line);
  const items = [];
  const kept = [];
  const emptied = new Set();
  let fence = false;
  let label = -1;
  for (const line of description.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && CHECKBOX_LINE_RE.test(line)) {
      items.push(line);
      if (label >= 0) emptied.add(label);
      continue;
    }
    if (!fence && isLabel(line)) label = kept.length;
    kept.push(line);
  }
  const out = kept.filter((line, i) => {
    if (!emptied.has(i)) return true;
    const next = kept.slice(i + 1).find((l) => l.trim());
    return next !== undefined && !isLabel(next);
  });
  return {
    items,
    description: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

// Context refs: repo paths, docs, URLs an agent should read before starting.
function normContext(value) {
  if (value === undefined) return undefined;
  const refs = [...new Set(lines(value))];
  if (refs.some((r) => r.length > 500)) throw new ApiError(400, 'context entries must be at most 500 characters');
  if (refs.length > 30) throw new ApiError(400, 'at most 30 context entries per task');
  return refs;
}

function normHandoff(input, actor) {
  const files = lines(input.files);
  if (files.length > 300) throw new ApiError(400, 'handoff files: at most 300 entries');
  const media = lines(input.media);
  if (media.length > 30) throw new ApiError(400, 'handoff media: at most 30 entries');
  return {
    summary: text(input.summary, 'summary', { max: 20000, required: true }),
    branch: text(input.branch, 'branch', { max: 200 }) || null,
    commit: text(input.commit, 'commit', { max: 100 }) || null,
    files,
    verify: text(input.verify, 'verify', { max: 20000 }) || null,
    media,
    submitted_by: actor,
    submitted_at: now(),
  };
}

// Handing work in (review) or finishing it clears the "sent back for rework" flag.
const criteriaSummary = (items) => `${items.filter((c) => c.done).length}/${items.length}`;

const reworkAfter = (row, status) => (['review', 'done'].includes(status) ? 0 : row.rework);

// Work on a task (ticking criteria, submitting, re-checking context, asking on it) is its holder's.
// Unassigned tasks are open; the Director may act on any task.
function assertHolder(row, actor, role = 'agent') {
  if (role === 'director' || !row.assignee || row.assignee === actor) return;
  throw new ApiError(
    403,
    `${taskKey(row)} is held by ${row.assignee}. Pass agent: "${row.assignee}" if that's you, or claim it first.`,
    { assignee: row.assignee },
  );
}

const VERDICT_DIRECTOR_ONLY = "Only the Director can accept or send back work (from the board). Tell the human it's ready.";

// One door per status for agents: in_progress through a claim, review through submit_for_review, and
// done through its holder's move once nothing needs the Director (or the Director's verdict).
// Work in review counts as needing the Director only when its handoff flagged a problem.
// Nobody changes the status of a task another agent holds. Backlog <-> todo stays open for planning.
function assertAgentStatusChange(row, status, actor, role = 'agent') {
  if (role === 'director' || status === row.status) return;
  const key = taskKey(row);
  assertHolder(row, actor);
  if (status === 'in_progress') {
    throw new ApiError(409, `Claim it instead (claim_task ${key}): a claim checks its dependencies, prerequisites and Director questions.`);
  }
  if (status === 'review') throw new ApiError(409, `Use submit_for_review to put ${key} in review: it records the handoff and runs the checks.`);
  if (status === 'done') {
    if (row.status === 'review') {
      const handoff = row.handoff ? JSON.parse(row.handoff) : {};
      const failed = (handoff.checks ?? []).filter((c) => !c.passed).map((c) => c.name);
      const flagged = [...(handoff.violations ?? []).map((v) => v.message), ...failed.map((name) => `Check "${name}" failed.`)];
      if (flagged.length) throw new ApiError(403, `${VERDICT_DIRECTOR_ONLY} The handoff flagged: ${flagged.join(' ')}`, { flagged });
    }
    if (row.needs_review) {
      throw new ApiError(403, `The Director wants to review ${key}. Submit it with submit_for_review; the Director accepts it from the board.`);
    }
    if (!row.assignee) throw new ApiError(409, `${key} isn't claimed. Claim it first (claim_task ${key}), then move it to done.`);
    const criteria = readCriteria(row.criteria);
    const forDirector = criteria.filter((c) => c.owner === 'human' && !c.done).map((c) => c.text);
    if (forDirector.length) {
      throw new ApiError(403, `${key} has Director criteria the human must check: ${forDirector.join('; ')}. Submit it with submit_for_review.`, {
        awaiting_director: forDirector,
      });
    }
    const unchecked = criteria.filter((c) => c.owner !== 'human' && !c.done).map((c) => c.text);
    if (unchecked.length) {
      throw new ApiError(
        409,
        `Tick ${key}'s criteria with evidence first (check_criteria): ${unchecked.join('; ')}. If one can't be met, submit_for_review and say why.`,
        { unchecked_criteria: unchecked },
      );
    }
  }
}

// New tasks get the same doors: agents create (or import) them in backlog or todo, then claim and submit them.
function assertAgentCreateStatus(status, role = 'agent') {
  if (role === 'director' || status === 'backlog' || status === 'todo') return;
  if (status === 'in_progress') {
    throw new ApiError(409, 'Claim it instead: create it in todo, then claim_task it (a claim checks its dependencies, prerequisites and Director questions).');
  }
  if (status === 'review') throw new ApiError(409, 'Use submit_for_review to put a task in review: create it in todo, claim it, then submit it with its handoff.');
  throw new ApiError(403, 'Only the Director can create a task in done. Create it in backlog or todo; the Director accepts finished work from the board.');
}

// Validates an attachment like the upload endpoint does: allowed type, not empty, at most 20 MB.
function checkAttachment({ filename, mime, data }, label = null) {
  const at = label ? `${label}: ` : '';
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (!ATTACHMENT_TYPES.includes(type)) {
    throw new ApiError(415, `${at}Unsupported attachment type "${type || '(none)'}". Allowed: ${ATTACHMENT_TYPES.join(', ')}`);
  }
  if (!data?.length) throw new ApiError(400, `${at}Attachment is empty`);
  if (data.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, `${at}Attachments must be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  const ext = type.split('/')[1].replace('quicktime', 'mov').replace('plain', 'txt').replace('jpeg', 'jpg');
  const name =
    String(filename ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/[\u0000-\u001f"]/g, '')
      .trim()
      .slice(0, 200) || `attachment.${ext}`;
  return { name, type, data };
}

function requireAgent(value) {
  const name = agentName(value);
  if (!name || name === 'anonymous') {
    throw new ApiError(400, 'Identify yourself: send an X-Agent header or pass "agent" in the request body');
  }
  return name;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function statusTimestamps(prev, status, ts) {
  const started = ['in_progress', 'review', 'done'].includes(status);
  return {
    started_at: prev.started_at ?? (started ? ts : null),
    completed_at: status === 'done' ? (prev.status === 'done' ? prev.completed_at : ts) : null,
  };
}

function formatActivity(row) {
  return {
    id: row.id,
    project: row.project_key,
    task: row.task_key,
    actor: row.actor,
    action: row.action,
    detail: JSON.parse(row.detail),
    created_at: row.created_at,
  };
}

const plain = (row) => ({ ...row });
const decisionId = (n) => `D-${String(n).padStart(3, '0')}`;

export class Kanban {
  constructor(db, { onChange = () => {} } = {}) {
    this.db = db;
    this.onChange = onChange;
    this.stmts = new Map();
  }

  // ---------------------------------------------------------------- helpers

  q(sql) {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  // Public mutating methods wrap their work in exactly one tx; helpers never open one.
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  emit(type, project, task = null) {
    this.onChange({ type, project, task });
  }

  log(projectId, taskId, key, actor, action, detail = {}) {
    this.q(
      'INSERT INTO activity (project_id, task_id, task_key, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(projectId, taskId, key, actor, action, JSON.stringify(detail), now());
  }

  // --------------------------------------------------------------- projects

  projectRow(key) {
    const row = this.q('SELECT * FROM projects WHERE key = ?').get(String(key ?? '').trim().toUpperCase());
    if (!row) throw new ApiError(404, `Project not found: ${key}`);
    return row;
  }

  formatProject(row) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const c of this.q('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status').all(row.id)) {
      counts[c.status] = c.n;
    }
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      agent_brief: row.agent_brief,
      ...readSettings(row),
      task_counts: counts,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listProjects() {
    return this.q('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map((r) => this.formatProject(r));
  }

  getProject(key) {
    return this.formatProject(this.projectRow(key));
  }

  // Refuses a repo_path that isn't the top of a git work tree.
  async assertRepoPath(value) {
    const p = text(value, 'repo_path', { max: 1000 });
    if (!p) return;
    let top;
    try {
      top = await new GitReader(p).validate();
    } catch (err) {
      throw new ApiError(400, err.message);
    }
    // A folder inside the repo would make path lookups (log -- path, show rev:path) disagree.
    if (fs.realpathSync(p) !== fs.realpathSync(top)) {
      throw new ApiError(400, `repo_path must be the top of the repository (${top}), not a folder inside it`);
    }
  }

  async createProject(input, actor) {
    if (input.repo_path) await this.assertRepoPath(input.repo_path);
    const key = String(input.key ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
      throw new ApiError(400, 'Project key must be 2-10 characters: a letter followed by letters or digits (e.g. "APP")');
    }
    const name = text(input.name, 'name', { max: 200 }) || key;
    const description = text(input.description, 'description', { max: 20000 }) ?? '';
    const brief = text(input.agent_brief, 'agent_brief', { max: 20000 }) ?? '';
    const settings = this.settingsPatch({}, input);
    const project = this.tx(() => {
      if (this.q('SELECT 1 FROM projects WHERE key = ?').get(key)) {
        throw new ApiError(409, `Project ${key} already exists`);
      }
      const ts = now();
      const { lastInsertRowid } = this.q(
        'INSERT INTO projects (key, name, description, agent_brief, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(key, name, description, brief, JSON.stringify(settings), ts, ts);
      this.log(Number(lastInsertRowid), null, null, actor, 'project_created', { name });
      return this.getProject(key);
    });
    this.emit('project.created', key);
    return project;
  }

  async updateProject(key, patch, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw directorOnly('change project settings');
    if (patch.repo_path) await this.assertRepoPath(patch.repo_path);
    const project = this.tx(() => {
      const row = this.projectRow(key);
      const name = patch.name === undefined ? row.name : text(patch.name, 'name', { max: 200, required: true });
      const description =
        patch.description === undefined ? row.description : (text(patch.description, 'description', { max: 20000 }) ?? '');
      const brief =
        patch.agent_brief === undefined ? row.agent_brief : (text(patch.agent_brief, 'agent_brief', { max: 20000 }) ?? '');
      const before = JSON.parse(row.settings);
      const settings = this.settingsPatch(before, patch, row);
      const changed = Object.keys(SETTINGS).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(before[k]));
      this.q('UPDATE projects SET name = ?, description = ?, agent_brief = ?, settings = ?, updated_at = ? WHERE id = ?').run(
        name,
        description,
        brief,
        JSON.stringify(settings),
        now(),
        row.id,
      );
      this.log(row.id, null, null, actor, 'project_updated', {
        name,
        ...(brief !== row.agent_brief && { brief: 'edited' }),
        ...(changed.length && { settings: changed }),
      });
      return this.getProject(row.key);
    });
    this.emit('project.updated', project.key);
    return project;
  }

  // Validates the settings present in `input` and merges them over `current`. null resets one.
  settingsPatch(current, input, row = null) {
    const next = { ...current };
    for (const [key, spec] of Object.entries(SETTINGS)) {
      if (input[key] === undefined) continue;
      if (input[key] === null) delete next[key];
      else next[key] = spec.norm(input[key], { row, kanban: this });
    }
    return next;
  }

  // Glossary findings for a task's text (and its handoff), or [] when the project has no glossary.
  glossaryFindings(projectId, task) {
    const { glossary } = this.settingsFor(projectId);
    if (!glossary.length) return [];
    const fields = { title: task.title, description: task.description, criteria: (task.criteria ?? []).map((c) => c.text).join('\n') };
    if (task.handoff) Object.assign(fields, { handoff_summary: task.handoff.summary, handoff_verify: task.handoff.verify });
    return lintGlossary(glossary, fields);
  }

  withGlossaryWarnings(task) {
    const findings = this.glossaryFindings(this.projectRow(task.project).id, { ...task, handoff: null });
    return findings.length ? { ...task, warnings: findings.map(glossaryWarning) } : task;
  }

  // Replaces (or merges into) the glossary from CONTEXT.md-style Markdown, pasted or read from the repo.
  async importGlossary(key, { markdown, path: file, mode = 'replace' } = {}, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw directorOnly('change the glossary');
    const project = this.projectRow(key);
    let source = text(markdown, 'markdown', { max: 500000 });
    if (!source) {
      if (!file) throw new ApiError(400, 'Send markdown (the file content) or path (a file in the project repo)');
      source = await this.repoFile(key, file);
    }
    const parsed = parseGlossary(source);
    if (!parsed.length) throw new ApiError(400, 'No glossary entries found: expected "**Term**:" lines followed by "_Avoid_: word, word" lines');
    const current = readSettings(project).glossary;
    const merged =
      oneOf(mode, ['replace', 'merge'], 'mode') === 'merge'
        ? [...current.filter((g) => !parsed.some((p) => p.term.toLowerCase() === g.term.toLowerCase())), ...parsed]
        : parsed;
    const updated = await this.updateProject(key, { glossary: merged }, actor, { role });
    return { ...updated, imported: parsed.length };
  }

  // A read-only git reader for the project's repo_path, or null when it has none.
  repoFor(projectId) {
    const { repo_path: repoPath } = this.settingsFor(projectId);
    return repoPath ? new GitReader(repoPath) : null;
  }

  // The baseline entries a task keeps when its context changes: the ones still in its context.
  // New entries are filled in by recordBaselines once the change is saved (git is asynchronous,
  // transactions aren't).
  keptBaseline(context, previous = {}) {
    const out = {};
    for (const ref of context) {
      const p = contextPath(ref);
      if (p && previous[p]) out[p] = previous[p];
    }
    return out;
  }

  // Records the last commit touching each repo-path context entry that has no baseline yet (or
  // every entry, with reset): the point the task was written against. Returns the baseline.
  async recordBaselines(taskId, { reset = false } = {}) {
    const row = this.taskRow(taskId);
    const settings = this.settingsFor(row.project_id);
    const previous = JSON.parse(row.context_baseline);
    if (!settings.repo_path) return previous;
    const git = new GitReader(settings.repo_path);
    const rev = await git.baseRef(settings.base_branch);
    const out = {};
    for (const ref of JSON.parse(row.context)) {
      const p = contextPath(ref);
      if (!p) continue;
      if (!reset && previous[p]) out[p] = previous[p];
      else {
        const sha = await git.lastCommit(p, rev);
        if (sha) out[p] = sha;
      }
    }
    // The context may have been edited while git ran; only write if it's the one we looked at.
    this.q('UPDATE tasks SET context_baseline = ? WHERE id = ? AND context = ?').run(JSON.stringify(out), row.id, row.context);
    return out;
  }

  // Context docs that changed since the task recorded its baseline (or, without one, since it was created),
  // and rule IDs it cites, checked against their source docs.
  async repoInsights(row, git = this.repoFor(row.project_id)) {
    const settings = this.settingsFor(row.project_id);
    if (!git) return {};
    const rev = await git.baseRef(settings.base_branch);
    const baseline = JSON.parse(row.context_baseline);
    const stale = [];
    const missingContext = [];
    for (const ref of JSON.parse(row.context)) {
      const p = contextPath(ref);
      if (!p) continue;
      if (!(await git.exists(rev, p))) {
        missingContext.push(p);
        continue;
      }
      // A baseline commit the repo no longer has (rewritten history) can't be compared against, so
      // say so and fall back to the task's creation time rather than reporting nothing.
      const missing = Boolean(baseline[p]) && !(await git.resolve(baseline[p]));
      const commits = baseline[p] && !missing ? await git.commitsSince(baseline[p], p, rev) : await git.commitsAfter(row.created_at, p, rev);
      if (commits.length || missing) {
        stale.push({
          path: p,
          since: missing ? row.created_at : (baseline[p] ?? row.created_at),
          commits_since: commits.slice(0, 20),
          ...(missing && { baseline_missing: baseline[p] }),
        });
      }
    }
    const references = [];
    const dangling = [];
    let referenceError = null;
    if (settings.reference_patterns.length) {
      const haystack = [row.title, row.description, ...readCriteria(row.criteria).map((c) => c.text)].join('\n');
      const docs = new Map();
      // Patterns come from project settings, so they run in a worker under a time budget.
      const found = await matchAllSafe(settings.reference_patterns.map((p) => p.regex), haystack);
      if (found.timed_out !== undefined) {
        const { regex } = settings.reference_patterns[found.timed_out];
        referenceError = `Reference pattern ${regex} took longer than ${REGEX_BUDGET_MS} ms and was skipped; simplify it in Project settings.`;
      }
      for (const [i, { source }] of settings.reference_patterns.entries()) {
        const ids = found.matches?.[i] ?? [];
        if (!ids.length) continue;
        if (!docs.has(source)) docs.set(source, await git.showFile(rev, source));
        const doc = docs.get(source);
        const docLines = doc?.split('\n') ?? [];
        for (const id of ids) {
          const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`);
          const at = docLines.findIndex((l) => re.test(l));
          if (at < 0) dangling.push({ id, source, ...(doc === null && { source_missing: true }) });
          else {
            references.push({
              id,
              source,
              line: at + 1,
              excerpt: docLines.slice(Math.max(0, at - 1), at + 3).join('\n').slice(0, 600),
            });
          }
        }
      }
    }
    return {
      ...(missingContext.length && { missing_context: missingContext }),
      ...(stale.length && { stale_context: stale }),
      ...(references.length && { references }),
      ...(dangling.length && { dangling_references: dangling }),
      ...(referenceError && { reference_error: referenceError }),
    };
  }

  // Problems a worker would hit later, reported to whoever writes the task (warnings, never errors):
  // cited rule IDs their source doc lacks, context paths missing on the base branch, and a scope that
  // reaches into a protected path without the unlock label. Only for projects with repo_path.
  async planningWarnings(taskId) {
    const row = this.taskRow(taskId);
    const settings = this.settingsFor(row.project_id);
    if (!settings.repo_path || row.type === 'epic') return [];
    const git = new GitReader(settings.repo_path);
    const insights = await this.repoInsights(row, git);
    const base = await git.baseRef(settings.base_branch);
    const out = [];
    for (const d of insights.dangling_references ?? []) {
      out.push(d.source_missing ? `${d.id}: its source ${d.source} isn't in the repo (reference_patterns).` : `${d.id} isn't in ${d.source} (reference_patterns).`);
    }
    for (const p of insights.missing_context ?? []) {
      out.push(`Context ${p} doesn't exist on ${base} (fine if an earlier task creates it; add it to depends_on).`);
    }
    const labels = JSON.parse(row.labels);
    for (const glob of JSON.parse(row.scope)) {
      for (const rule of settings.protected_paths) {
        if ((rule.unlock_label && labels.includes(rule.unlock_label)) || !globsOverlap(glob, rule.glob)) continue;
        out.push(
          rule.unlock_label
            ? `Scope ${glob} is protected (${rule.glob}); only the Director can add "${rule.unlock_label}". Ask when you start.`
            : `Scope ${glob} reaches ${rule.glob}, which no task may change.`,
        );
      }
    }
    return [...new Set(out)];
  }

  // Where to work and what not to touch: the checkout with its base branch and head, and the protected
  // paths (unlocked when this task carries the label). Each is omitted when its setting is empty.
  async workspaceFor(row, git = this.repoFor(row.project_id)) {
    const settings = this.settingsFor(row.project_id);
    const out = {};
    if (git) {
      const base = await git.baseRef(settings.base_branch);
      const head = await git.head(base);
      out.repo = { path: settings.repo_path, base_branch: base, head: head ? head.sha.slice(0, 10) : null };
    }
    if (settings.protected_paths.length) {
      const labels = JSON.parse(row.labels);
      out.protected_paths = settings.protected_paths.map((r) => ({ ...r, unlocked: Boolean(r.unlock_label && labels.includes(r.unlock_label)) }));
    }
    return out;
  }

  // "I re-read the context docs": moves every baseline to the docs' latest commit.
  async recheckContext(ref, actor, { role = 'agent' } = {}) {
    const row = this.taskRow(ref);
    assertHolder(row, actor, role);
    if (!this.settingsFor(row.project_id).repo_path) throw new ApiError(400, `${row.project_key} has no repo_path, so there is nothing to re-check`);
    const baseline = await this.recordBaselines(row.id, { reset: true });
    this.tx(() => {
      this.q('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), row.id);
      this.log(row.project_id, row.id, taskKey(row), actor, 'context_rechecked', { paths: Object.keys(baseline) });
    });
    const task = await this.getTask(row.id);
    this.emit('task.updated', task.project, task.key);
    return task;
  }

  // Reads one file from the project repo at the base branch (for rule-ID links in the UI).
  async repoFile(key, file) {
    const project = this.projectRow(key);
    const settings = readSettings(project);
    if (!settings.repo_path) throw new ApiError(400, `${project.key} has no repo_path`);
    const p = contextPath(String(file ?? ''));
    if (!p) throw new ApiError(400, 'path must be a file path inside the repo');
    const git = new GitReader(settings.repo_path);
    const content = await git.showFile(await git.baseRef(settings.base_branch), p);
    if (content === null) throw new ApiError(404, `Not in the repo: ${p}`);
    return content;
  }

  // What the settings UI shows next to repo_path: whether it's a usable repo and where HEAD is.
  async repoStatus(key, { path: candidate } = {}, { role = 'agent' } = {}) {
    if (candidate !== undefined && role !== 'director') throw new ApiError(403, 'Only the Director can check a path before saving it');
    const project = this.projectRow(key);
    const { repo_path: saved, base_branch: base } = readSettings(project);
    const repoPath = candidate ?? saved;
    if (!repoPath) return { repo_path: null, ok: false, error: 'No repo_path set' };
    const git = new GitReader(repoPath);
    try {
      const toplevel = await git.validate();
      const baseRef = await git.baseRef(base);
      return { repo_path: repoPath, ok: true, toplevel, head: await git.head(), base: baseRef, base_head: await git.head(baseRef) };
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      return { repo_path: repoPath, ok: false, error: err.message };
    }
  }

  settingsFor(projectId) {
    return readSettings(this.q('SELECT settings FROM projects WHERE id = ?').get(projectId));
  }

  deleteProject(key, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw directorOnly('delete a project');
    const row = this.projectRow(key);
    this.tx(() => this.q('DELETE FROM projects WHERE id = ?').run(row.id));
    this.emit('project.deleted', row.key);
    return { deleted: row.key, by: actor };
  }

  // ------------------------------------------------------------------ tasks

  taskRow(ref) {
    const s = String(ref ?? '').trim();
    let row;
    if (/^\d+$/.test(s)) {
      row = this.q(`${TASK_SELECT} WHERE t.id = ?`).get(Number(s));
    } else {
      const m = s.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
      if (m) row = this.q(`${TASK_SELECT} WHERE p.key = ? AND t.number = ?`).get(m[1].toUpperCase(), Number(m[2]));
    }
    if (!row) throw new ApiError(404, `Task not found: ${s || '(empty)'}`);
    return row;
  }

  formatTask(row) {
    const task = this.formatTaskBase(row);
    const { required_fields: required, allowed_estimates: allowed, stale_claim_hours: staleHours } = this.settingsFor(row.project_id);
    const missing = required.length ? missingFields(task, required) : [];
    // An estimate the project no longer allows (the list changed after the task was sized) needs redoing too.
    if (task.type !== 'epic' && task.estimate !== null && allowed.length && !allowed.includes(task.estimate) && !missing.includes('estimate')) {
      missing.push('estimate');
    }
    const lastActivity = row.last_activity_at ?? row.updated_at;
    const idle = Date.now() - Date.parse(lastActivity);
    // Waiting on the Director isn't the agent's idleness; answering the question posts a comment,
    // which restarts the clock.
    const stale =
      task.status === 'in_progress' &&
      task.type !== 'epic' &&
      Boolean(task.assignee) &&
      !task.waiting_on_director &&
      staleHours > 0 &&
      idle > staleHours * 3600000;
    return {
      ...task,
      last_activity_at: lastActivity,
      ...(stale && { stale_claim: { idle: idleFor(idle), since: lastActivity } }),
      ...(missing.length && { missing_fields: missing }),
    };
  }

  formatTaskBase(row) {
    const deps = this.q(DEPENDENCIES_SQL).all(row.id);
    const prerequisites = JSON.parse(row.prerequisites);
    const pending = prerequisites.filter((p) => !p.done).map((p) => p.text);
    return {
      id: row.id,
      key: taskKey(row),
      project: row.project_key,
      number: row.number,
      external_id: row.external_id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      type: row.type,
      assignee: row.assignee,
      labels: JSON.parse(row.labels),
      parent: row.parent_key,
      milestone: row.milestone_name,
      milestone_id: row.milestone_id,
      epic: row.epic_key,
      sprint: row.sprint_name,
      sprint_id: row.sprint_id,
      estimate: row.estimate,
      criteria: readCriteria(row.criteria),
      context: JSON.parse(row.context),
      scope: JSON.parse(row.scope),
      handoff: row.handoff ? JSON.parse(row.handoff) : null,
      checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null,
      rework: row.rework === 1,
      needs_review: row.needs_review === 1,
      waiting_on_director: row.waiting_question !== null,
      open_questions: row.open_questions,
      prerequisites,
      pending_prerequisites: pending,
      depends_on: deps.map((d) => d.key),
      blocked_by: deps.filter((d) => d.status !== 'done').map((d) => d.key),
      blocked: pending.length > 0 || deps.some((d) => d.status !== 'done'),
      position: row.position,
      comment_count: row.comment_count,
      attachment_count: row.attachment_count,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
  }

  listTasks(f = {}) {
    const where = ['1 = 1'];
    const params = [];
    const inList = (column, values) => {
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    if (f.project) {
      where.push('t.project_id = ?');
      params.push(this.projectRow(f.project).id);
    }
    if (f.status) inList('t.status', csv(f.status).map(normStatus));
    if (f.priority) inList('t.priority', csv(f.priority).map((p) => oneOf(p, PRIORITIES, 'priority')));
    if (f.type) inList('t.type', csv(f.type).map((t) => oneOf(t, TYPES, 'type')));
    if (f.assignee) inList('t.assignee', csv(f.assignee));
    if (f.unassigned === true || f.unassigned === 'true') where.push('t.assignee IS NULL');
    if (f.blocked === true || f.blocked === 'true') where.push(BLOCKED_SQL);
    if (f.blocked === false || f.blocked === 'false') where.push(`NOT ${BLOCKED_SQL}`);
    for (const label of csv(f.label)) {
      where.push('EXISTS (SELECT 1 FROM json_each(t.labels) WHERE json_each.value = ?)');
      params.push(label);
    }
    if (f.milestone) {
      if (String(f.milestone).toLowerCase() === 'none') {
        where.push('t.milestone_id IS NULL');
      } else {
        const projectId = f.project ? this.projectRow(f.project).id : null;
        where.push('t.milestone_id = ?');
        params.push(this.milestoneRow(f.milestone, projectId).id);
      }
    }
    if (f.parent) {
      where.push('t.parent_id = ?');
      params.push(this.taskRow(f.parent).id);
    }
    if (f.epic) {
      if (String(f.epic).toLowerCase() === 'none') {
        where.push(`t.epic_id IS NULL AND ${NOT_EPIC_SQL}`);
      } else {
        where.push('t.epic_id = ?');
        params.push(this.epicRow(f.epic).id);
      }
    }
    if (f.sprint) {
      if (String(f.sprint).toLowerCase() === 'none') {
        where.push(`t.sprint_id IS NULL AND ${NOT_EPIC_SQL}`);
      } else {
        if (!f.project && String(f.sprint).toLowerCase() === 'active') {
          throw new ApiError(400, 'sprint=active needs a project');
        }
        where.push('t.sprint_id = ?');
        params.push(this.sprintRow(f.sprint, f.project ? this.projectRow(f.project).id : null).id);
      }
    }
    if (f.external_id) inList('t.external_id', csv(f.external_id));
    if (f.q) {
      where.push('(t.title LIKE ? OR t.description LIKE ? OR t.external_id = ?)');
      params.push(`%${f.q}%`, `%${f.q}%`, String(f.q).trim());
    }
    const limit = clampInt(f.limit, 1, 1000, 200);
    const missingOnly = f.missing_fields === true || f.missing_fields === 'true';
    const tasks = this.db
      .prepare(
        `${TASK_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY p.key, ${STATUS_ORDER_SQL}, ${BOARD_ORDER_SQL} ${missingOnly ? '' : `LIMIT ${limit}`}`,
      )
      .all(...params)
      .map((r) => this.formatTask(r));
    return missingOnly ? tasks.filter((t) => t.missing_fields).slice(0, limit) : tasks;
  }

  getBoard(key) {
    const project = this.projectRow(key);
    const tasks = this.q(`${TASK_SELECT} WHERE t.project_id = ? AND ${NOT_EPIC_SQL} ORDER BY ${BOARD_ORDER_SQL}`)
      .all(project.id)
      .map((r) => this.formatTask(r));
    const nextUp = tasks.find((t) => t.status === 'todo' && !t.assignee && !t.blocked && !t.waiting_on_director);
    return {
      project: this.formatProject(project),
      milestones: this.listMilestones(project.key),
      epics: this.listEpics(project.key),
      sprints: this.listSprints(project.key),
      next_up: nextUp?.key ?? null,
      ...(!nextUp && tasks.some((t) => t.status === 'todo') && { next_up_reasons: this.explainEmptyClaim(project.key, null) }),
      columns: STATUSES.map((status) => ({
        status,
        name: STATUS_NAMES[status],
        tasks: tasks.filter((t) => t.status === status),
      })),
    };
  }

  // What each direct dependency handed over: its summary (trimmed), files, commit, and the final
  // review verdict. Saves the next agent from reconstructing it from git log.
  upstreamFor(taskId) {
    const clip = (value) => (value && value.length > UPSTREAM_SUMMARY_CHARS ? `${value.slice(0, UPSTREAM_SUMMARY_CHARS).trimEnd()}…` : value);
    return this.q(`${TASK_SELECT} JOIN task_dependencies d ON d.depends_on_id = t.id WHERE d.task_id = ? ORDER BY p.key, t.number`)
      .all(taskId)
      .filter((dep) => dep.handoff)
      .map((dep) => {
        const h = JSON.parse(dep.handoff);
        const verdict = this.q(
          "SELECT actor, detail, created_at FROM activity WHERE task_id = ? AND action = 'reviewed' ORDER BY id DESC LIMIT 1",
        ).get(dep.id);
        // A verdict from an earlier round (before this handoff was submitted) isn't about this work.
        const current = verdict && (!h.submitted_at || verdict.created_at >= h.submitted_at);
        const v = current && JSON.parse(verdict.detail);
        return {
          key: taskKey(dep),
          title: dep.title,
          status: dep.status,
          summary: clip(h.summary),
          files: h.files,
          commit: h.commit,
          branch: h.branch,
          submitted_by: h.submitted_by,
          submitted_at: h.submitted_at,
          review: v ? { verdict: v.verdict, by: verdict.actor, at: verdict.created_at, feedback: clip(v.feedback) || null } : null,
        };
      });
  }

  async getTask(ref) {
    const row = this.taskRow(ref);
    // One reader per request, so a query both need runs git once.
    const git = this.repoFor(row.project_id);
    const insights = await this.repoInsights(row, git);
    const workspace = await this.workspaceFor(row, git);
    const upstream = this.upstreamFor(row.id);
    const epicInfo =
      row.type === 'epic'
        ? {
            progress: this.childProgress(row.id),
            children: this.q(`${TASK_SELECT} WHERE t.epic_id = ? ORDER BY ${STATUS_ORDER_SQL}, ${BOARD_ORDER_SQL}`)
              .all(row.id)
              .map((r) => this.formatTask(r)),
          }
        : {};
    const task = this.formatTask(row);
    const wording = this.glossaryFindings(row.project_id, task);
    return {
      ...task,
      ...epicInfo,
      ...(wording.length && { glossary_warnings: wording }),
      ...workspace,
      ...insights,
      ...(upstream.length && { upstream }),
      dependencies: this.q(DEPENDENCIES_SQL).all(row.id).map(plain),
      dependents: this.q(DEPENDENTS_SQL).all(row.id).map(plain),
      subtasks: this.q(SUBTASKS_SQL).all(row.id).map(plain),
      attachments: this.attachmentsFor(row.id),
      questions: this.questionsFor(row.id),
      reviews: this.reviewsFor(row.id),
      comments: this.commentsFor(row),
      activity: this.q(
        `SELECT a.*, p.key AS project_key FROM activity a JOIN projects p ON p.id = a.project_id
         WHERE a.task_id = ? ORDER BY a.id DESC LIMIT 100`,
      )
        .all(row.id)
        .map(formatActivity),
    };
  }

  async createTask(input, actor, options) {
    return (await this.createTasks([input], actor, options))[0];
  }

  // Fills in context baselines for tasks just saved with repo-path context entries lacking one.
  async recordNewBaselines(tasks) {
    for (const t of tasks) {
      const row = this.taskRow(t.id);
      if (row.context === '[]' || !this.settingsFor(row.project_id).repo_path) continue;
      const stored = JSON.parse(row.context_baseline);
      if (JSON.parse(row.context).some((ref) => contextPath(ref) && !stored[contextPath(ref)])) await this.recordBaselines(row.id);
    }
  }

  // Bulk create in one transaction. Within a batch, "parent" and "depends_on"
  // may reference earlier items by index as "#0", "#1", ...
  async createTasks(inputs, actor, { role = 'agent' } = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new ApiError(400, 'tasks must be a non-empty array');
    if (inputs.length > 200) throw new ApiError(400, 'at most 200 tasks per request');
    const created = this.tx(() => {
      const ids = [];
      const resolve = (ref) => {
        const m = String(ref).trim().match(/^#(\d+)$/);
        if (!m) return ref;
        const at = Number(m[1]);
        const id = ids[at];
        if (id === undefined) {
          throw new ApiError(400, at < ids.length ? `Batch reference ${ref} points to an item that failed` : `Batch reference ${ref} must point to an earlier task in the same request`);
        }
        return String(id);
      };
      // Every item is validated, so one error names all the items that fail (grouped by message).
      const failures = [];
      for (const [i, input] of inputs.entries()) {
        try {
          ids.push(this.insertTask(input ?? {}, actor, resolve, { role }));
        } catch (err) {
          if (!(err instanceof ApiError) || inputs.length === 1) throw err;
          ids.push(undefined);
          failures.push({ index: i, status: err.status, error: err.message, extra: err.extra });
        }
      }
      if (failures.length) {
        const groups = new Map();
        for (const f of failures) groups.set(f.error, [...(groups.get(f.error) ?? []), f.index]);
        const message = [...groups].map(([error, idx]) => `${idx.map((i) => `tasks[${i}]`).join(', ')}: ${error}`).join('\n');
        throw new ApiError(failures[0].status, message, {
          ...failures[0].extra,
          index: failures[0].index,
          errors: failures.map(({ index, status, error }) => ({ index, status, error })),
        });
      }
      return ids.map((id) => this.formatTask(this.taskRow(id)));
    });
    await this.recordNewBaselines(created);
    for (const t of created) this.emit('task.created', t.project, t.key);
    const out = [];
    for (const t of created) {
      const readiness = t.status === 'backlog' && t.missing_fields ? [readinessWarning(t.missing_fields)] : [];
      out.push(withWarnings(this.withGlossaryWarnings(t), [...readiness, ...(await this.planningWarnings(t.id))]));
    }
    return out;
  }

  insertTask(input, actor, resolve = (r) => r, { role = 'agent', epicGiven = false } = {}) {
    const title = text(input.title, 'title', { max: 500, required: true });
    const status = input.status === undefined ? 'backlog' : normStatus(input.status);
    assertAgentCreateStatus(status, role);
    const priority = input.priority === undefined ? 'medium' : oneOf(input.priority, PRIORITIES, 'priority');
    const type = input.type === undefined ? 'task' : oneOf(input.type, TYPES, 'type');
    const assignee = agentName(input.assignee) ?? null;
    const labels = normLabels(input.labels);
    let description = text(input.description, 'description', { max: 100000 }) ?? '';
    let criteria = normCriteria(input.criteria) ?? [];
    if (input.extract_criteria === true) {
      const extracted = extractChecklist(description);
      description = extracted.description;
      criteria = withExtracted(criteria, extracted.items, role);
    }
    const context = normContext(input.context) ?? [];
    const prerequisites = normPrerequisites(input.prerequisites) ?? [];
    if (role !== 'director') assertAgentNewChecklists(criteria, prerequisites);
    const scope = normScope(input.scope) ?? [];
    const externalId = normExternalId(input.external_id) ?? null;
    const needsReview = input.needs_review === true || input.needs_review === 'true';
    if (needsReview && role !== 'director') throw directorOnly('mark a task as needing review');

    const parent = input.parent ? this.taskRow(resolve(input.parent)) : null;
    const projectRef = input.project ?? parent?.project_key;
    if (!projectRef) throw new ApiError(400, 'project is required (e.g. "APP")');
    const project = this.projectRow(projectRef);
    const milestone = input.milestone ? this.milestoneRow(input.milestone, project.id) : null;
    const estimate = normEstimate(input.estimate) ?? null;
    const rules = this.settingsFor(project.id);
    if (type !== 'epic') checkEstimate(estimate, rules.allowed_estimates);
    if (role !== 'director') {
      const unlocking = labels.filter((l) => unlockLabels(rules).has(l));
      if (unlocking.length) throw directorOnly(`add the label "${unlocking[0]}", which unlocks a protected path`);
    }
    if (role !== 'director' && rules.required_fields.length) {
      const given = {
        priority: input.priority !== undefined,
        estimate: estimate !== null,
        epic: Boolean(input.epic) || Boolean(parent?.epic_id) || epicGiven,
        criteria: criteria.length > 0,
        labels: labels.length > 0,
      };
      const missing = rules.required_fields.filter((f) => !given[f] && (type !== 'epic' || f === 'priority'));
      // Capturing into backlog is fine without them (the response warns); being ready (todo and on) isn't.
      if (missing.length && (status !== 'backlog' || type === 'epic')) {
        throw new ApiError(
          400,
          `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required when creating tasks in ${project.key} (required: ${rules.required_fields.join(', ')}${
            rules.allowed_estimates.length ? `; estimate one of ${rules.allowed_estimates.join(', ')}` : ''
          })`,
          { field: missing[0], missing },
        );
      }
    }
    let epic = null;
    let sprint = null;
    if (type === 'epic') {
      if (input.epic || input.sprint) throw new ApiError(400, 'An epic cannot belong to another epic or to a sprint');
    } else {
      // Subtasks inherit their parent's epic unless told otherwise.
      const epicRef = input.epic !== undefined ? input.epic : parent?.epic_id ? String(parent.epic_id) : null;
      epic = epicRef ? this.epicRow(resolve(epicRef), project.id) : null;
      sprint = input.sprint ? this.sprintRow(input.sprint, project.id) : null;
    }

    if (externalId) this.assertExternalIdFree(project.id, externalId);
    const ts = now();
    const stamps = statusTimestamps({}, status, ts);
    this.q('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(project.id);
    const { lastInsertRowid } = this.q(
      `INSERT INTO tasks (project_id, number, title, description, status, priority, type, assignee, labels,
         parent_id, milestone_id, epic_id, sprint_id, estimate, criteria, context, context_baseline, prerequisites, scope,
         position, created_by, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.id,
      project.next_number,
      title,
      description,
      status,
      priority,
      type,
      assignee,
      JSON.stringify(labels),
      parent?.id ?? null,
      milestone?.id ?? null,
      epic?.id ?? null,
      sprint?.id ?? null,
      estimate,
      JSON.stringify(criteria),
      JSON.stringify(context),
      '{}', // filled in by recordBaselines after the insert
      JSON.stringify(prerequisites),
      JSON.stringify(scope),
      this.nextPosition(project.id, status),
      actor,
      ts,
      ts,
      stamps.started_at,
      stamps.completed_at,
    );
    const id = Number(lastInsertRowid);
    if (externalId) this.q('UPDATE tasks SET external_id = ? WHERE id = ?').run(externalId, id);
    if (needsReview) this.q('UPDATE tasks SET needs_review = 1 WHERE id = ?').run(id);
    if (input.depends_on !== undefined) this.setDependencies(id, csv(input.depends_on).map(resolve));
    this.log(project.id, id, `${project.key}-${project.next_number}`, actor, 'created', { title, status });
    return id;
  }

  async updateTask(ref, patch, actor, { role = 'agent' } = {}) {
    let missingBefore = [];
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      missingBefore = this.formatTask(row).missing_fields ?? [];
      return this.applyTaskPatch(row, patch, actor, { role });
    });
    if (patch.context !== undefined) await this.recordNewBaselines([task]);
    this.emit('task.updated', task.project, task.key);
    const touchedText = ['title', 'description', 'criteria', 'extract_criteria'].some((f) => patch[f] !== undefined);
    const cleared = (task.missing_fields ?? []).filter((f) => !missingBefore.includes(f));
    const planning = touchedText || ['context', 'scope', 'labels'].some((f) => patch[f] !== undefined) ? await this.planningWarnings(task.id) : [];
    return withWarnings(touchedText ? this.withGlossaryWarnings(task) : task, [...(cleared.length ? [readinessWarning(task.missing_fields, task.status)] : []), ...planning]);
  }

  // The required fields a task lacks (or an estimate that isn't allowed); epics are never held to them.
  missingFields(row) {
    return row.type === 'epic' ? [] : (this.formatTask(row).missing_fields ?? []);
  }

  // An agent can't put a task into To Do (or claim it out of backlog) while it lacks a field the project
  // requires: backlog may, but To Do and later mean ready.
  assertReady(row, role, doing = 'move to todo') {
    if (role === 'director' || row.status !== 'todo' || row.type === 'epic') return;
    const task = this.formatTask(row);
    if (!task.missing_fields?.length) return;
    const { required_fields: required, allowed_estimates: allowed } = this.settingsFor(row.project_id);
    throw new ApiError(
      400,
      `${task.key} needs ${task.missing_fields.join(', ')} before it can ${doing} (required in ${row.project_key}: ${required.join(', ')}${
        allowed.length ? `; estimate one of ${allowed.join(', ')}` : ''
      }). Set ${task.missing_fields.length > 1 ? 'them' : 'it'} with update_task first.`,
      { field: task.missing_fields[0], missing: task.missing_fields },
    );
  }

  // The body of updateTask, for callers already inside a transaction. Returns the formatted task.
  applyTaskPatch(row, patch, actor, { role = 'agent' } = {}) {
    const sets = {};
    const changes = {};
    const set = (field, value) => {
      if (value !== row[field]) {
        sets[field] = value;
        changes[field] = [row[field], value];
      }
    };

    if (patch.title !== undefined) set('title', text(patch.title, 'title', { max: 500, required: true }));
    if (patch.priority !== undefined) set('priority', oneOf(patch.priority, PRIORITIES, 'priority'));
    if (patch.type !== undefined) set('type', oneOf(patch.type, TYPES, 'type'));
    if (patch.assignee !== undefined) {
      const assignee = agentName(patch.assignee);
      if (role !== 'director' && assignee !== row.assignee) {
        // Only a task's holder hands it off or lets it go; unassigned tasks stay open for planning.
        assertHolder(row, actor);
        // A task parked by a blocking question stays with the agent that asked (or nobody) until the Director answers.
        if (row.waiting_question !== null && assignee) throw directorOnly(`assign ${taskKey(row)} while it is waiting on the Director`);
      }
      set('assignee', assignee);
    }
    let description = patch.description === undefined ? row.description : (text(patch.description, 'description', { max: 100000 }) ?? '');
    const before = readCriteria(row.criteria);
    let criteria = patch.criteria === undefined ? before : normCriteria(patch.criteria, before);
    if (patch.extract_criteria === true) {
      const extracted = extractChecklist(description);
      description = extracted.description;
      criteria = withExtracted(criteria, extracted.items, role);
    }
    if (role !== 'director') assertAgentCriteriaChange(taskKey(row), before, criteria);
    if (description !== row.description) {
      sets.description = description;
      changes.description = 'edited';
    }
    if (JSON.stringify(criteria) !== JSON.stringify(before)) {
      sets.criteria = JSON.stringify(criteria);
      changes.criteria = [criteriaSummary(before), criteriaSummary(criteria)];
    }
    if (patch.labels !== undefined) {
      const labels = normLabels(patch.labels);
      if (role !== 'director') {
        const had = new Set(JSON.parse(row.labels));
        const unlocking = labels.filter((l) => !had.has(l) && unlockLabels(this.settingsFor(row.project_id)).has(l));
        if (unlocking.length) throw directorOnly(`add the label "${unlocking[0]}", which unlocks a protected path`);
      }
      if (JSON.stringify(labels) !== row.labels) {
        sets.labels = JSON.stringify(labels);
        changes.labels = [JSON.parse(row.labels), labels];
      }
    }
    if (patch.parent !== undefined) {
      const parent = this.resolveParent(row.id, patch.parent);
      if ((parent?.id ?? null) !== row.parent_id) {
        sets.parent_id = parent?.id ?? null;
        changes.parent = [row.parent_key, parent ? taskKey(parent) : null];
      }
    }
    if (patch.milestone !== undefined) {
      const milestone = patch.milestone === null || patch.milestone === '' ? null : this.milestoneRow(patch.milestone, row.project_id);
      if ((milestone?.id ?? null) !== row.milestone_id) {
        sets.milestone_id = milestone?.id ?? null;
        changes.milestone = [row.milestone_name, milestone?.name ?? null];
      }
    }
    if (patch.estimate !== undefined) {
      const estimate = normEstimate(patch.estimate);
      checkEstimate(estimate, this.settingsFor(row.project_id).allowed_estimates, taskKey(row));
      set('estimate', estimate);
    }
    if (patch.prerequisites !== undefined) {
      const was = JSON.parse(row.prerequisites);
      const prerequisites = normPrerequisites(patch.prerequisites, was);
      if (role !== 'director') assertAgentPrerequisiteChange(taskKey(row), was, prerequisites);
      if (JSON.stringify(prerequisites) !== row.prerequisites) {
        sets.prerequisites = JSON.stringify(prerequisites);
        changes.prerequisites = [criteriaSummary(was), criteriaSummary(prerequisites)];
      }
    }
    if (patch.checkpoint !== undefined) {
      const note = makeCheckpoint(patch.checkpoint, actor);
      if (note !== row.checkpoint) {
        sets.checkpoint = note;
        changes.checkpoint = [row.checkpoint ? 'set' : null, note ? 'set' : null];
      }
    }
    if (patch.external_id !== undefined) {
      const externalId = normExternalId(patch.external_id);
      if (externalId && externalId !== row.external_id) this.assertExternalIdFree(row.project_id, externalId, row.id);
      set('external_id', externalId);
    }
    if (patch.scope !== undefined) {
      const scope = normScope(patch.scope);
      if (JSON.stringify(scope) !== row.scope) {
        sets.scope = JSON.stringify(scope);
        changes.scope = [JSON.parse(row.scope), scope];
      }
    }
    if (patch.needs_review !== undefined && patch.needs_review !== null) {
      const needsReview = patch.needs_review === true || patch.needs_review === 'true' ? 1 : 0;
      if (needsReview !== row.needs_review) {
        if (role !== 'director') throw directorOnly(`change whether ${taskKey(row)} needs review`);
        set('needs_review', needsReview);
      }
    }
    if (patch.context !== undefined) {
      const context = normContext(patch.context);
      if (JSON.stringify(context) !== row.context) {
        sets.context = JSON.stringify(context);
        sets.context_baseline = JSON.stringify(this.keptBaseline(context, JSON.parse(row.context_baseline)));
        changes.context = [JSON.parse(row.context), context];
      }
    }
    const type = sets.type ?? row.type;
    if (type === 'epic') {
      if (patch.epic || patch.sprint) throw new ApiError(400, 'An epic cannot belong to another epic or to a sprint');
      // Becoming an epic: leave any epic/sprint it was in.
      if (row.epic_id) {
        sets.epic_id = null;
        changes.epic = [row.epic_key, null];
      }
      if (row.sprint_id) {
        sets.sprint_id = null;
        changes.sprint = [row.sprint_name, null];
      }
    } else {
      if (row.type === 'epic') {
        const children = this.q('SELECT COUNT(*) AS n FROM tasks WHERE epic_id = ?').get(row.id).n;
        if (children) throw new ApiError(400, `${taskKey(row)} is an epic with ${children} tasks; move them to another epic first`);
      }
      if (patch.epic !== undefined) {
        const epic = patch.epic === null || patch.epic === '' ? null : this.epicRow(patch.epic, row.project_id);
        if ((epic?.id ?? null) !== row.epic_id) {
          sets.epic_id = epic?.id ?? null;
          changes.epic = [row.epic_key, epic ? taskKey(epic) : null];
        }
      }
      if (patch.sprint !== undefined) {
        const sprint = patch.sprint === null || patch.sprint === '' ? null : this.sprintRow(patch.sprint, row.project_id);
        if ((sprint?.id ?? null) !== row.sprint_id) {
          sets.sprint_id = sprint?.id ?? null;
          changes.sprint = [row.sprint_name, sprint?.name ?? null];
        }
      }
    }
    if (patch.depends_on !== undefined) {
      const before = this.q(DEPENDENCIES_SQL).all(row.id).map((d) => d.key);
      this.setDependencies(row.id, csv(patch.depends_on));
      const after = this.q(DEPENDENCIES_SQL).all(row.id).map((d) => d.key);
      if (before.join() !== after.join()) changes.depends_on = [before, after];
    }
    const ts = now();
    if (patch.status !== undefined) {
      const status = normStatus(patch.status);
      assertAgentStatusChange(row, status, actor, role);
      if (status !== row.status) {
        Object.assign(
          sets,
          { status, position: this.nextPosition(row.project_id, status), rework: reworkAfter(row, status) },
          statusTimestamps(row, status, ts),
        );
        changes.status = [row.status, status];
      }
    }

    if (Object.keys(changes).length === 0) return this.formatTask(row);
    // A task joining a column or a priority level goes to the bottom of that level.
    if (changes.priority && !changes.status) sets.position = this.nextPosition(row.project_id, row.status);
    sets.updated_at = ts;
    const cols = Object.keys(sets);
    this.db
      .prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => sets[c]), row.id);
    this.log(row.project_id, row.id, taskKey(row), actor, 'updated', { changes });
    const updated = this.taskRow(row.id);
    if (changes.status) this.assertReady(updated, role);
    return this.formatTask(updated);
  }

  // With an index, the task's priority is adjusted to fit its new neighbours
  // (dragging above an "urgent" card makes it urgent), since columns sort by priority.
  moveTask(ref, input, actor, { role = 'agent' } = {}) {
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      const status = input.status === undefined ? row.status : normStatus(input.status);
      assertAgentStatusChange(row, status, actor, role);
      if (status !== row.status) this.assertReady({ ...row, status }, role);
      const changes = {};
      let priority = row.priority;
      if (input.index !== undefined && input.index !== null) {
        const others = this.columnRows(row.project_id, status, row.id);
        const at = clampInt(input.index, 0, others.length, others.length);
        const above = others[at - 1];
        const below = others[at];
        if (above && priorityRank(priority) > priorityRank(above.priority)) priority = above.priority;
        else if (below && priorityRank(priority) < priorityRank(below.priority)) priority = below.priority;
      }
      if (priority !== row.priority) changes.priority = [row.priority, priority];
      if (status !== row.status) changes.status = [row.status, status];
      if (Object.keys(changes).length) {
        const ts = now();
        const stamps = statusTimestamps(row, status, ts);
        this.q(
          'UPDATE tasks SET status = ?, priority = ?, rework = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        ).run(status, priority, reworkAfter(row, status), stamps.started_at, stamps.completed_at, ts, row.id);
        this.log(row.project_id, row.id, taskKey(row), actor, 'updated', { changes });
      }
      this.placeInColumn(row.project_id, status, row.id, input.index);
      return this.formatTask(this.taskRow(row.id));
    });
    this.emit('task.moved', task.project, task.key);
    return task;
  }

  // Agents may delete their own task or an unassigned one; work in review or done is the Director's.
  deleteTask(ref, actor, { role = 'agent' } = {}) {
    const row = this.taskRow(ref);
    const key = taskKey(row);
    if (role !== 'director') {
      assertHolder(row, actor);
      if (row.status === 'review' || row.status === 'done') throw directorOnly(`delete a task in ${row.status}`);
    }
    this.tx(() => {
      this.q('DELETE FROM tasks WHERE id = ?').run(row.id);
      this.log(row.project_id, null, key, actor, 'deleted', { title: row.title });
    });
    this.emit('task.deleted', row.project_key, key);
    return { deleted: key };
  }

  // ----------------------------------------------------------- agent flow

  async claimTask(ref, agent, { force = false, role = 'agent' } = {}) {
    if (force && role !== 'director') throw directorOnly('force a claim past its checks');
    const name = requireAgent(agent);
    const task = this.tx(() => this.claimRow(this.taskRow(ref), name, force, role));
    this.emit('task.claimed', task.project, task.key);
    return this.briefing(task.key);
  }

  // What an agent needs to start work, in one response: the full task (criteria, context,
  // comments, review feedback, attachments) plus the project's standing instructions.
  async briefing(ref) {
    const { activity, ...task } = await this.getTask(ref);
    const decisions = this.decisionsFor(this.taskRow(task.key));
    const project = this.projectRow(task.project);
    const { checks, brief_sections: sections } = readSettings(project);
    const epicTitle = task.epic ? this.taskRow(task.epic).title : null;
    const matched = sections.filter((sec) => sectionMatches(sec, task, epicTitle));
    const brief = [project.agent_brief, ...matched.map((sec) => `## ${sectionTitle(sec)}\n\n${sec.body}`)].filter(Boolean).join('\n\n');
    // The resume note goes right after the title, so it's read before the description.
    const { id, key, project: projectKey, number, external_id: externalId, title, checkpoint, ...rest } = task;
    return {
      id,
      key,
      project: projectKey,
      number,
      external_id: externalId,
      title,
      checkpoint,
      ...rest,
      agent_brief: brief,
      ...(matched.length && { brief_sections: matched.map(sectionTitle) }),
      ...(checks.length && { checks }),
      ...(decisions.length && { decisions }),
    };
  }

  claimRow(row, agent, force, role = 'agent') {
    const key = taskKey(row);
    if (row.type === 'epic') throw new ApiError(409, `${key} is an epic; claim one of its tasks instead`);
    if (!force) {
      if (row.assignee && row.assignee !== agent) {
        throw new ApiError(409, `${key} is already claimed by ${row.assignee}`, { assignee: row.assignee });
      }
      if (row.status === 'done') throw new ApiError(409, `${key} is already done`);
      const open = this.q(DEPENDENCIES_SQL).all(row.id).filter((d) => d.status !== 'done');
      if (open.length) {
        const keys = open.map((d) => d.key);
        throw new ApiError(409, `${key} is blocked by ${keys.join(', ')}`, { blocked_by: keys });
      }
      const pending = JSON.parse(row.prerequisites).filter((p) => !p.done).map((p) => p.text);
      if (pending.length) {
        throw new ApiError(409, `${key} is waiting on the Director's prerequisites: ${pending.map((p) => `"${p}"`).join(', ')}`, {
          prerequisites: pending,
        });
      }
      if (row.waiting_question !== null && row.assignee !== agent) {
        throw new ApiError(409, `${key} is waiting on the Director: "${row.waiting_question}"`, { waiting_on_director: true });
      }
      // Claiming skips To Do, so it needs what To Do needs.
      if (row.status === 'backlog') this.assertReady({ ...row, status: 'todo' }, role, 'be claimed');
    }
    // Claiming something in review means "I'm reviewing it"; anything else starts work.
    const status = row.status === 'review' ? 'review' : 'in_progress';
    const ts = now();
    const stamps = statusTimestamps(row, status, ts);
    this.q(
      'UPDATE tasks SET assignee = ?, status = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?',
    ).run(agent, status, stamps.started_at, stamps.completed_at, ts, row.id);
    if (status !== row.status) this.placeInColumn(row.project_id, status, row.id);
    this.log(row.project_id, row.id, key, agent, 'claimed', {
      changes: { status: [row.status, status], assignee: [row.assignee, agent] },
    });
    return this.formatTask(this.taskRow(row.id));
  }

  // Tasks this agent holds in progress, parked or not, with the activity ids of the last answer to a
  // blocking question and of the agent's own last action on them (ids, unlike timestamps, never tie).
  heldRows(projectId, name) {
    return this.q(
      `SELECT t.id,
         (SELECT MAX(aa.id) FROM activity aa
           WHERE aa.task_id = t.id AND aa.action = 'answered' AND json_extract(aa.detail, '$.blocking') = 1) AS answered_seq,
         (SELECT MAX(ma.id) FROM activity ma WHERE ma.task_id = t.id AND ma.actor = ?) AS own_seq
       FROM tasks t WHERE t.project_id = ? AND t.status = 'in_progress' AND t.assignee = ? AND ${NOT_EPIC_SQL} ORDER BY t.id`,
    )
      .all(name, projectId, name)
      .map((r) => ({ ...this.taskRow(r.id), answered_seq: r.answered_seq, own_seq: r.own_seq }));
  }

  // Claims the first "To Do" task in board order (priority, then position) that is
  // unblocked and either unassigned or pre-assigned to this agent. A held task whose blocking question
  // was answered since the agent last acted on it comes back first (resumed: true); then work that
  // review sent back to it, since it still has the context. Other held tasks aren't handed out: a
  // parallel session under the same name may be working them (claimNextResponse lists them). Atomic.
  async claimNext(projectKey, agent, { labels, types, milestone, epic, sprint, new_only: newOnly } = {}) {
    const name = requireAgent(agent);
    const wantLabels = csv(labels);
    const wantTypes = csv(types).map((t) => oneOf(t, TYPES, 'type'));
    let resumed = false;
    const task = this.tx(() => {
      const project = this.projectRow(projectKey);
      const milestoneId = milestone ? this.milestoneRow(milestone, project.id).id : null;
      const epicId = epic ? this.epicRow(epic, project.id).id : null;
      const sprintId = sprint ? this.sprintRow(sprint, project.id).id : null;
      const candidates = this.q(
        `${TASK_SELECT}
         WHERE t.project_id = ? AND t.status = 'todo' AND (t.assignee IS NULL OR t.assignee = ?)
           AND ${NOT_EPIC_SQL} AND NOT ${BLOCKED_SQL} AND (NOT ${WAITING_SQL} OR t.assignee = ?)
         ORDER BY ${BOARD_ORDER_SQL}`,
      ).all(project.id, name, name);
      const wanted = (row) => {
        const rowLabels = JSON.parse(row.labels);
        if (milestoneId !== null && row.milestone_id !== milestoneId) return false;
        if (epicId !== null && row.epic_id !== epicId) return false;
        if (sprintId !== null && row.sprint_id !== sprintId) return false;
        if (wantTypes.length && !wantTypes.includes(row.type)) return false;
        if (wantLabels.length && !wantLabels.some((l) => rowLabels.includes(l))) return false;
        return true;
      };
      if (newOnly !== true && newOnly !== 'true') {
        // An answer the holder hasn't acted on yet, earliest first. Logging the resume counts as acting,
        // so a second session under the same name gets new work instead of the same task.
        const fresh = (row) => row.answered_seq !== null && (row.own_seq === null || row.answered_seq > row.own_seq);
        const [answered] = this.heldRows(project.id, name)
          .filter((row) => row.waiting_question === null && fresh(row) && wanted(row))
          .sort((a, b) => a.answered_seq - b.answered_seq);
        if (answered) {
          resumed = true;
          this.log(project.id, answered.id, taskKey(answered), name, 'resumed', {});
          return this.formatTask(this.taskRow(answered.id));
        }
      }
      const pick = candidates.find((row) => row.rework && row.assignee === name && wanted(row)) ?? candidates.find(wanted);
      return pick ? this.claimRow(pick, name, false) : null;
    });
    if (!task) return null;
    this.emit(resumed ? 'task.updated' : 'task.claimed', task.project, task.key);
    const briefing = await this.briefing(task.key);
    return resumed ? { ...briefing, resumed: true } : briefing;
  }

  // claim-next's response: {task} when something was claimed, otherwise {task: null, reasons} saying
  // why each of the top 5 To Do cards couldn't be handed to this agent. Either way, held lists the other
  // tasks the caller holds in progress, to pick back up on purpose with claim_task.
  async claimNextResponse(projectKey, agent, filters = {}) {
    const task = await this.claimNext(projectKey, agent, filters);
    const project = this.projectRow(projectKey);
    const name = agentName(agent);
    const held = (name ? this.heldRows(project.id, name) : [])
      .filter((row) => taskKey(row) !== task?.key)
      .map((row) => ({
        key: taskKey(row),
        title: row.title,
        last_activity_at: row.last_activity_at ?? row.updated_at,
        ...(row.waiting_question !== null && { waiting_on_director: true }),
      }))
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    const withHeld = held.length ? { held } : {};
    if (task) return { task, ...withHeld };
    const reasons = this.explainEmptyClaim(projectKey, agent, filters);
    const todo = this.q(`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.status = 'todo' AND ${NOT_EPIC_SQL}`).get(project.id).n;
    return {
      task: null,
      reasons,
      ...withHeld,
      ...(!todo && { hint: 'The To Do column is empty: nothing is ready. New work sits in backlog until the human moves it.' }),
    };
  }

  explainEmptyClaim(projectKey, agent, { labels, types, milestone, epic, sprint } = {}) {
    const name = agentName(agent);
    const project = this.projectRow(projectKey);
    const wantLabels = csv(labels);
    const wantTypes = csv(types).map((t) => oneOf(t, TYPES, 'type'));
    const milestoneRow = milestone ? this.milestoneRow(milestone, project.id) : null;
    const epicRow = epic ? this.epicRow(epic, project.id) : null;
    const sprintRow = sprint ? this.sprintRow(sprint, project.id) : null;
    // Why a task falls outside the caller's filters.
    const filteredOut = (row) => {
      const why = [];
      const rowLabels = JSON.parse(row.labels);
      if (milestoneRow && row.milestone_id !== milestoneRow.id) why.push(`not in milestone ${milestoneRow.name}`);
      if (epicRow && row.epic_id !== epicRow.id) why.push(`not in epic ${taskKey(epicRow)}`);
      if (sprintRow && row.sprint_id !== sprintRow.id) why.push(`not in sprint ${sprintRow.name}`);
      if (wantTypes.length && !wantTypes.includes(row.type)) why.push(`type ${row.type}, not ${wantTypes.join('/')}`);
      if (wantLabels.length && !wantLabels.some((l) => rowLabels.includes(l))) why.push(`no label ${wantLabels.join('/')}`);
      return why;
    };
    // The caller's own parked tasks that match its filters come first: they're its work, waiting on the human.
    const parked = (name ? this.heldRows(project.id, name) : [])
      .filter((row) => row.waiting_question !== null && !filteredOut(row).length)
      .map((row) => {
        const asked = this.q('SELECT asked_at FROM questions WHERE task_id = ? AND blocking = 1 AND answered_at IS NULL ORDER BY id LIMIT 1').get(row.id);
        const first = row.waiting_question.split('\n')[0].slice(0, 120);
        return { key: taskKey(row), title: row.title, why: `yours, waiting on the Director: "${first}" (asked ${asked.asked_at.slice(0, 16).replace('T', ' ')} UTC)` };
      });
    const todo = this.q(`${TASK_SELECT} WHERE t.project_id = ? AND t.status = 'todo' AND ${NOT_EPIC_SQL} ORDER BY ${BOARD_ORDER_SQL} LIMIT 5`)
      .all(project.id)
      .map((row) => {
        const why = [];
        if (row.assignee && row.assignee !== name) why.push(`assigned to ${row.assignee}`);
        for (const d of this.q(DEPENDENCIES_SQL).all(row.id).filter((d) => d.status !== 'done')) why.push(`blocked by ${d.key} (${d.status})`);
        for (const p of JSON.parse(row.prerequisites).filter((p) => !p.done)) why.push(`prerequisite: ${p.text}`);
        if (row.waiting_question !== null && !(row.assignee && row.assignee === name)) why.push(`waiting on Director: "${row.waiting_question.split('\n')[0].slice(0, 120)}"`);
        why.push(...filteredOut(row));
        return { key: taskKey(row), title: row.title, why: why.join('; ') || 'available' };
      });
    return [...parked, ...todo];
  }

  // force releases another agent's claim (say, one it abandoned); anyone may.
  releaseTask(ref, agent, { status, force = false, checkpoint, role = 'agent' } = {}) {
    const name = agentName(agent);
    const note = checkpoint === undefined ? undefined : makeCheckpoint(checkpoint, name ?? 'anonymous');
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      const key = taskKey(row);
      if (row.assignee && row.assignee !== name && !force && role !== 'director') {
        throw new ApiError(409, `${key} is claimed by ${row.assignee}, not ${name ?? 'you'}. Only its holder releases it; if ${row.assignee} abandoned it, pass force: true.`, {
          assignee: row.assignee,
        });
      }
      let next = status ? normStatus(status) : row.status === 'in_progress' ? 'todo' : row.status;
      // A plain release of a task that isn't ready (say, a field was cleared) returns it to backlog instead.
      if (!status && next === 'todo' && role !== 'director' && this.missingFields(row).length) next = 'backlog';
      assertAgentStatusChange({ ...row, assignee: name }, next, name, role);
      if (next !== row.status) this.assertReady({ ...row, status: next }, role);
      const ts = now();
      const stamps = statusTimestamps(row, next, ts);
      this.q(
        // No checkpoint keeps the note; an empty one ("") clears it.
        `UPDATE tasks SET assignee = NULL, status = ?, started_at = ?, completed_at = ?, updated_at = ?${note === undefined ? '' : ', checkpoint = ?'} WHERE id = ?`,
      ).run(next, stamps.started_at, stamps.completed_at, ts, ...(note === undefined ? [] : [note]), row.id);
      if (next !== row.status) this.placeInColumn(row.project_id, next, row.id);
      this.log(row.project_id, row.id, key, name ?? 'anonymous', 'released', {
        changes: { status: [row.status, next], assignee: [row.assignee, null] },
        ...(note && { checkpoint: JSON.parse(note).body.slice(0, 300) }),
      });
      const released = this.formatTask(this.taskRow(row.id));
      return !status && next === 'backlog' && row.status === 'in_progress'
        ? withWarnings(released, [`Released to backlog, not todo: ${readinessWarning(released.missing_fields)}`])
        : released;
    });
    this.emit('task.released', task.project, task.key);
    return task;
  }

  // ------------------------------------------------------ criteria & review

  // Tick (or untick) acceptance criteria by 0-based index or exact text. An item may be
  // {item, evidence} to record how it was verified (a test name, command output, file:line);
  // a top-level "evidence" applies to items without their own. Director (owner: human) items
  // can only be ticked by the human.
  checkCriteria(ref, { items, done = true, evidence } = {}, actor, { role = 'agent' } = {}) {
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      const key = taskKey(row);
      assertHolder(row, actor, role);
      const criteria = readCriteria(row.criteria);
      if (!criteria.length) throw new ApiError(400, `${key} has no acceptance criteria`);
      const refs = items === undefined || items === null ? [] : Array.isArray(items) ? items : [items];
      if (!refs.length) throw new ApiError(400, 'items is required: criterion indexes (0-based) or exact texts');
      const shared = text(evidence, 'evidence', { max: 2000 }) || undefined;
      const value = done !== false && done !== 'false';
      const picks = new Map();
      for (const r of refs) {
        const entry = r !== null && typeof r === 'object' ? r : { item: r };
        const s = String(entry.item ?? entry.index ?? entry.text ?? '').trim();
        const i = /^\d+$/.test(s) ? Number(s) : criteria.findIndex((c) => c.text === s);
        if (i < 0 || i >= criteria.length) {
          throw new ApiError(400, `No criterion ${JSON.stringify(r)} on ${key}; it has ${criteria.length} (indexes 0-${criteria.length - 1})`);
        }
        if (criteria[i].owner === 'human' && role !== 'director') throw humanItemError(key, criteria[i]);
        picks.set(i, text(entry.evidence, 'evidence', { max: 2000 }) || shared);
      }
      const changed = [];
      for (const [i, proof] of picks) {
        const c = criteria[i];
        const nextEvidence = value ? (proof ?? c.evidence) : proof;
        if (c.done === value && c.evidence === nextEvidence) continue;
        c.done = value;
        if (nextEvidence) c.evidence = nextEvidence;
        else delete c.evidence;
        changed.push(i);
      }
      if (!changed.length) return this.formatTask(row);
      this.q('UPDATE tasks SET criteria = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(criteria), now(), row.id);
      this.log(row.project_id, row.id, key, actor, 'criteria_checked', {
        done: value,
        items: changed.map((i) => criteria[i].text),
        ...(changed.some((i) => criteria[i].evidence) && { evidence: changed.map((i) => criteria[i].evidence ?? null) }),
        progress: criteriaSummary(criteria),
      });
      return this.formatTask(this.taskRow(row.id));
    });
    this.emit('task.updated', task.project, task.key);
    return task;
  }

  // Moves the description's "- [ ]" checklist into criteria (for tasks written before criteria existed).
  extractCriteria(ref, actor, { role = 'agent' } = {}) {
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      const key = taskKey(row);
      const { items, description } = extractChecklist(row.description);
      if (!items.length) throw new ApiError(400, `${key}'s description has no "- [ ]" checklist lines to convert`);
      const before = readCriteria(row.criteria);
      const criteria = withExtracted(before, items, role);
      this.q('UPDATE tasks SET criteria = ?, description = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(criteria), description, now(), row.id);
      this.log(row.project_id, row.id, key, actor, 'updated', {
        changes: { description: 'edited', criteria: [criteriaSummary(before), criteriaSummary(criteria)] },
      });
      return { ...this.formatTask(this.taskRow(row.id)), extracted: items.length };
    });
    this.emit('task.updated', task.project, task.key);
    return task;
  }

  // The Director ticks (or unticks) prerequisites by 0-based index or exact text.
  checkPrerequisites(ref, { items, done = true } = {}, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw new ApiError(403, 'Only the Director ticks prerequisites (from the board)');
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      const key = taskKey(row);
      const list = JSON.parse(row.prerequisites);
      const refs = items === undefined || items === null ? [] : Array.isArray(items) ? items : [items];
      if (!refs.length) throw new ApiError(400, 'items is required: prerequisite indexes (0-based) or exact texts');
      const value = done !== false && done !== 'false';
      const indexes = refs.map((r) => {
        const s = String(r).trim();
        const i = /^\d+$/.test(s) ? Number(s) : list.findIndex((p) => p.text === s);
        if (i < 0 || i >= list.length) throw new ApiError(400, `No prerequisite ${JSON.stringify(r)} on ${key}; it has ${list.length}`);
        return i;
      });
      const changed = [...new Set(indexes)].filter((i) => list[i].done !== value);
      if (!changed.length) return this.formatTask(row);
      for (const i of changed) list[i].done = value;
      this.q('UPDATE tasks SET prerequisites = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(list), now(), row.id);
      this.log(row.project_id, row.id, key, actor, 'prerequisites_checked', {
        done: value,
        items: changed.map((i) => list[i].text),
        progress: criteriaSummary(list),
      });
      return this.formatTask(this.taskRow(row.id));
    });
    this.emit('task.updated', task.project, task.key);
    return task;
  }

  reviewRound(taskId) {
    return this.q("SELECT COUNT(*) AS n FROM activity WHERE task_id = ? AND action = 'submitted'").get(taskId).n;
  }

  // An agent hands finished work to the human: what changed, where, and how to check it.
  async submitForReview(ref, input, actor, { role = 'agent' } = {}) {
    const submittable = (row) => {
      const key = taskKey(row);
      if (row.type === 'epic') throw new ApiError(400, `${key} is an epic; submit its tasks instead`);
      if (row.status === 'done') throw new ApiError(409, `${key} is already done`);
      if (role !== 'director' && !row.assignee) {
        throw new ApiError(409, `${key} isn't claimed. Claim it first (claim_task ${key}), then submit.`);
      }
      assertHolder(row, actor, role);
      return key;
    };
    const before = this.taskRow(ref);
    submittable(before);
    const handoff = normHandoff(input, actor);
    const results = normCheckResults(input.checks);
    if (results.length) handoff.checks = results;
    const repoMedia = this.readRepoMedia(before, handoff.media);
    // Git runs before the transaction (it's asynchronous); the task is re-checked inside it.
    const repoWarnings = await this.validateHandoff(before, handoff);
    const task = this.tx(() => {
      const row = this.taskRow(before.id);
      const key = submittable(row);
      // Files attached by repo path become attachments; the handoff keeps their URLs in place.
      for (const file of repoMedia) {
        const { url } = this.insertAttachment(row, file, actor);
        handoff.media = handoff.media.map((m) => (m === file.entry ? url : m));
      }
      const { checks } = this.settingsFor(row.project_id);
      const wording = this.glossaryFindings(row.project_id, { handoff }).map(glossaryWarning);
      const warnings = [...repoWarnings, ...checkWarnings(checks, results, handoff.files), ...wording];
      if (warnings.length) handoff.warnings = warnings;
      const stamps = statusTimestamps(row, 'review', handoff.submitted_at);
      this.q(
        // The resume note is about unfinished work; once it's submitted, it would only mislead a rework briefing.
        `UPDATE tasks SET status = 'review', handoff = ?, rework = 0, checkpoint = NULL, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(handoff), stamps.started_at, stamps.completed_at, handoff.submitted_at, row.id);
      if (row.status !== 'review') this.placeInColumn(row.project_id, 'review', row.id);
      this.log(row.project_id, row.id, key, actor, 'submitted', {
        round: this.reviewRound(row.id) + 1,
        summary: handoff.summary.slice(0, 300),
        ...(row.status !== 'review' && { changes: { status: [row.status, 'review'] } }),
      });
      return this.formatTask(this.taskRow(row.id));
    });
    this.emit('task.moved', task.project, task.key);
    const unchecked = task.criteria.filter((c) => !c.done && c.owner !== 'human').map((c) => c.text);
    const forDirector = task.criteria.filter((c) => !c.done && c.owner === 'human').map((c) => c.text);
    return {
      ...task,
      ...(unchecked.length && { unchecked_criteria: unchecked }),
      ...(forDirector.length && { awaiting_director: forDirector }),
      ...((task.handoff.warnings || task.handoff.violations) && {
        warnings: [...(task.handoff.warnings ?? []), ...(task.handoff.violations ?? []).map((v) => v.message)],
      }),
    };
  }

  // Checks a handoff against the repo and the path rules, filling in what git can tell. Adds
  // files (from the diff) when the agent left them out, diff_base, and violations (protected
  // paths touched without the unlocking label, files outside the task's scope). Returns warnings.
  async validateHandoff(row, handoff) {
    const settings = this.settingsFor(row.project_id);
    const git = settings.repo_path ? new GitReader(settings.repo_path) : null;
    const warnings = [];
    // Path rules run over every file the work touched: the listed files plus the diff, so an
    // agent can't pass them by leaving a file out of its list.
    let unlistedChanges = [];
    if (git) {
      // A handoff pointing at work the repo doesn't have can't be reviewed: it never reaches the Director.
      const stays = `${taskKey(row)} stays ${row.status === 'in_progress' ? 'in progress' : `in ${row.status}`}.`;
      let head = null;
      if (handoff.commit) {
        head = await git.resolve(handoff.commit);
        if (!head) throw new ApiError(409, `Commit ${handoff.commit} doesn't exist in the project repo. Commit your work, or fix the SHA. ${stays}`, { commit: handoff.commit });
      }
      if (handoff.branch) {
        if (await git.hasBranch(handoff.branch)) head ??= await git.resolve(handoff.branch);
        else if (!head) {
          throw new ApiError(409, `Branch "${handoff.branch}" doesn't exist in the project repo. Push or create it where repo_path points, or pass the commit. ${stays}`, {
            branch: handoff.branch,
          });
        } else warnings.push(`Branch "${handoff.branch}" doesn't exist in the project repo.`);
      }
      if (head) {
        let baseRef = await git.baseRef(settings.base_branch);
        let base = await git.mergeBase(baseRef, head);
        // Already merged into the base: fall back to the commit's own changes.
        if (base === head && (await git.resolve(`${head}^`))) {
          baseRef = `${head.slice(0, 10)}^`;
          base = await git.resolve(`${head}^`);
        }
        const diff = base ? await git.changedFiles(base, head) : null;
        if (diff) {
          handoff.diff_base = { ref: baseRef, sha: base };
          if (!handoff.files.length) {
            handoff.files = diff;
            handoff.files_derived = true;
          } else {
            const listed = new Set(handoff.files);
            const changed = new Set(diff);
            const unlisted = diff.filter((f) => !listed.has(f));
            const untouched = handoff.files.filter((f) => !changed.has(f));
            if (unlisted.length) warnings.push(`Changed since ${baseRef} but missing from files: ${fileList(unlisted)}.`);
            if (untouched.length) warnings.push(`Listed in files but not changed since ${baseRef}: ${fileList(untouched)}.`);
            unlistedChanges = unlisted;
          }
        }
      }
    }
    const touched = [...handoff.files, ...unlistedChanges];
    const labels = JSON.parse(row.labels);
    const violations = [];
    for (const rule of settings.protected_paths) {
      const hits = touched.filter((f) => matchesGlob(f, rule.glob));
      if (!hits.length || (rule.unlock_label && labels.includes(rule.unlock_label))) continue;
      violations.push({
        kind: 'protected_path',
        rule: rule.glob,
        files: hits,
        message: `Protected path ${rule.glob} touched: ${fileList(hits)}.${
          rule.unlock_label
            ? ` Only tasks labeled "${rule.unlock_label}" may change it. Revert it, or ask_director for the "${rule.unlock_label}" label (only the Director can add it).`
            : ' No task may change it. Revert it.'
        }`,
      });
    }
    const scope = JSON.parse(row.scope);
    const outside = scope.length ? touched.filter((f) => !matchesAny(f, scope)) : [];
    if (outside.length) {
      violations.push({ kind: 'out_of_scope', rule: scope.join(', '), files: outside, message: `Outside the task's scope (${scope.join(', ')}): ${fileList(outside)}. Revert it, or widen the scope with update_task and say why.` });
    }
    if (violations.length) handoff.violations = violations;
    return warnings;
  }

  // The human's verdict on a task in review. "accept" moves it to done. "changes" sends it
  // back to To Do, still assigned to the agent that submitted it and flagged as rework, at
  // the top of its priority level; the feedback is posted as a comment the agent will read.
  reviewTask(ref, input = {}, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw new ApiError(403, VERDICT_DIRECTOR_ONLY);
    const v = String(input.verdict ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const verdict = oneOf(VERDICT_ALIASES[v] ?? v, REVIEW_VERDICTS, 'verdict');
    const feedback = text(input.feedback, 'feedback', { max: 50000, required: verdict === 'changes' }) || '';
    const task = this.tx(() => {
      const row = this.taskRow(ref);
      const key = taskKey(row);
      if (row.status !== 'review') throw new ApiError(409, `${key} is not in review (it's ${row.status})`);
      const ts = now();
      const round = Math.max(1, this.reviewRound(row.id));
      const status = verdict === 'accept' ? 'done' : 'todo';
      const stamps = statusTimestamps(row, status, ts);
      const changes = { status: [row.status, status] };
      if (verdict === 'accept') {
        this.q('UPDATE tasks SET status = ?, rework = 0, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
          status,
          stamps.started_at,
          stamps.completed_at,
          ts,
          row.id,
        );
        this.placeInColumn(row.project_id, status, row.id);
      } else {
        const assignee = (row.handoff && JSON.parse(row.handoff).submitted_by) || row.assignee;
        if (assignee !== row.assignee) changes.assignee = [row.assignee, assignee];
        this.q(
          'UPDATE tasks SET status = ?, assignee = ?, rework = 1, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        ).run(status, assignee, stamps.started_at, stamps.completed_at, ts, row.id);
        const higher = this.columnRows(row.project_id, status, row.id).filter((o) => priorityRank(o.priority) > priorityRank(row.priority));
        this.placeInColumn(row.project_id, status, row.id, higher.length);
      }
      if (feedback) {
        const heading = verdict === 'accept' ? 'Accepted' : 'Changes requested';
        this.insertComment(row, `**${heading}** (review round ${round})\n\n${feedback}`, actor, ts);
      }
      this.log(row.project_id, row.id, key, actor, 'reviewed', {
        verdict: verdict === 'accept' ? 'accepted' : 'changes_requested',
        round,
        feedback: feedback.slice(0, 5000),
        changes,
      });
      return this.formatTask(this.taskRow(row.id));
    });
    this.emit('task.moved', task.project, task.key);
    return task;
  }

  // Submissions and verdicts, oldest first.
  reviewsFor(taskId) {
    return this.q(
      "SELECT actor, action, detail, created_at FROM activity WHERE task_id = ? AND action IN ('submitted', 'reviewed') ORDER BY id",
    )
      .all(taskId)
      .map((r) => {
        const d = JSON.parse(r.detail);
        return r.action === 'submitted'
          ? { event: 'submitted', round: d.round, by: r.actor, summary: d.summary, at: r.created_at }
          : { event: d.verdict, round: d.round, by: r.actor, feedback: d.feedback, at: r.created_at };
      });
  }

  // Everything waiting for the human, with what's needed to judge it.
  getReviewQueue(projectKey) {
    const project = this.projectRow(projectKey);
    return this.q(`${TASK_SELECT} WHERE t.project_id = ? AND t.status = 'review' AND ${NOT_EPIC_SQL} ORDER BY ${BOARD_ORDER_SQL}`)
      .all(project.id)
      .map((r) => ({ ...this.formatTask(r), attachments: this.attachmentsFor(r.id), reviews: this.reviewsFor(r.id) }));
  }

  // --------------------------------------------------------------- inbox

  // Everything waiting on the human, oldest first: open questions, reviews (with the Director's own
  // unticked criteria), prerequisites blocking agent work, and director-assigned gates now unblocked.
  // `me` adds the board user's own name to the names that count as the Director.
  getInbox(projectKey, { me } = {}) {
    const project = this.projectRow(projectKey);
    const directors = new Set([...DIRECTOR_NAMES, ...(me ? [String(me).trim().toLowerCase()] : [])]);
    const items = [];
    for (const q of this.listQuestions(project.key, { status: 'open' })) {
      items.push({ kind: 'question', since: q.asked_at, task: q.task, title: q.task_title, question: q });
    }
    const rows = this.q(`${TASK_SELECT} WHERE t.project_id = ? AND ${NOT_EPIC_SQL} AND t.status <> 'done' ORDER BY t.id`).all(project.id);
    for (const row of rows) {
      const t = this.formatTask(row);
      if (t.status === 'review') {
        items.push({
          kind: 'review',
          since: t.handoff?.submitted_at ?? t.updated_at,
          task: t.key,
          title: t.title,
          submitted_by: t.handoff?.submitted_by ?? t.assignee,
          criteria: t.criteria,
          director_items_open: t.criteria.filter((c) => c.owner === 'human' && !c.done).length,
          warnings: (t.handoff?.warnings?.length ?? 0) + (t.handoff?.violations?.length ?? 0),
        });
      }
      if (t.pending_prerequisites.length) {
        items.push({
          kind: 'prerequisite',
          // Older items have no added_at; the task's creation is the best guess for those.
          since: t.prerequisites.filter((p) => !p.done).map((p) => p.added_at ?? t.created_at).sort()[0],
          task: t.key,
          title: t.title,
          status: t.status,
          prerequisites: t.prerequisites.map((p, index) => ({ ...p, index })).filter((p) => !p.done),
        });
      }
      if (t.stale_claim) {
        items.push({ kind: 'stale', since: t.stale_claim.since, task: t.key, title: t.title, assignee: t.assignee, idle: t.stale_claim.idle });
      }
      if (['todo', 'in_progress'].includes(t.status) && t.assignee && directors.has(t.assignee.toLowerCase()) && !t.blocked) {
        const deps = this.q(DEPENDENCIES_SQL).all(row.id).map((d) => this.taskRow(d.id).completed_at).filter(Boolean);
        items.push({ kind: 'gate', since: deps.sort().at(-1) ?? t.created_at, task: t.key, title: t.title, status: t.status, assignee: t.assignee });
      }
    }
    items.sort((a, b) => a.since.localeCompare(b.since));
    return { project: project.key, count: items.length, items };
  }

  // ------------------------------------------------------------ attachments

  attachmentsFor(taskId) {
    return this.q('SELECT id, filename, mime, size, created_by, created_at FROM attachments WHERE task_id = ? ORDER BY id')
      .all(taskId)
      .map((a) => ({ ...a, url: `/api/attachments/${a.id}` }));
  }

  addAttachment(ref, file, actor) {
    const checked = checkAttachment(file);
    const row = this.taskRow(ref);
    const attachment = this.tx(() => this.insertAttachment(row, checked, actor));
    this.emit('task.updated', row.project_key, taskKey(row));
    return { ...attachment, task: taskKey(row) };
  }

  // For callers inside a transaction; the file was checked with checkAttachment.
  insertAttachment(row, { name, type, data }, actor) {
    const ts = now();
    const { lastInsertRowid } = this.q(
      'INSERT INTO attachments (task_id, filename, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, name, type, data.length, data, actor, ts);
    this.q('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, row.id);
    this.log(row.project_id, row.id, taskKey(row), actor, 'attached', { filename: name, mime: type, size: data.length });
    return this.attachmentsFor(row.id).find((a) => a.id === Number(lastInsertRowid));
  }

  // Reads the handoff's "repo:<path>" media from the project's checkout (read-only), confined to it:
  // no absolute paths, no "..", and no symlink that resolves outside. Checked like an upload.
  readRepoMedia(row, media) {
    const wanted = media.filter((m) => /^repo:/i.test(m));
    if (!wanted.length) return [];
    const { repo_path: repoPath } = this.settingsFor(row.project_id);
    if (!repoPath) {
      throw new ApiError(400, `repo: media needs the project's repo_path, and ${row.project_key} has none. Upload with POST /api/tasks/${taskKey(row)}/attachments instead.`);
    }
    let root;
    try {
      root = fs.realpathSync(repoPath);
    } catch {
      throw new ApiError(400, `The project's repo_path isn't readable here: ${repoPath}`);
    }
    return wanted.map((entry) => {
      const rel = entry.slice(5).trim();
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        throw new ApiError(400, `${entry}: use a path inside the repo, relative to its top (no leading "/", no "..")`);
      }
      let real;
      try {
        real = fs.realpathSync(path.join(root, rel));
      } catch {
        throw new ApiError(400, `${entry}: no such file in the repo (${repoPath})`);
      }
      if (!real.startsWith(root + path.sep)) throw new ApiError(400, `${entry}: resolves outside the repo (a symlink?)`);
      const stat = fs.statSync(real);
      if (!stat.isFile()) throw new ApiError(400, `${entry}: not a file`);
      const type = MIME_BY_EXT[path.extname(real).slice(1).toLowerCase()] ?? '';
      if (stat.size > MAX_ATTACHMENT_BYTES) checkAttachment({ filename: rel, mime: type, data: { length: stat.size } });
      const checked = checkAttachment({ filename: path.basename(rel), mime: type, data: fs.readFileSync(real) }, entry);
      return { entry, ...checked };
    });
  }

  attachmentRow(id) {
    const s = String(id ?? '').trim();
    const row = /^\d+$/.test(s) ? this.q('SELECT * FROM attachments WHERE id = ?').get(Number(s)) : undefined;
    if (!row) throw new ApiError(404, `Attachment not found: ${s || '(empty)'}`);
    return row;
  }

  getAttachment(id) {
    const row = this.attachmentRow(id);
    return { ...row, task: taskKey(this.taskRow(row.task_id)) };
  }

  // Same rule as deleting the task: an attachment on work in review or done may be evidence a handoff cites.
  deleteAttachment(id, actor, { role = 'agent' } = {}) {
    const attachment = this.attachmentRow(id);
    const row = this.taskRow(attachment.task_id);
    if (role !== 'director') {
      assertHolder(row, actor);
      if (row.status === 'review' || row.status === 'done') throw directorOnly(`delete an attachment on a task in ${row.status}`);
    }
    this.tx(() => {
      this.q('DELETE FROM attachments WHERE id = ?').run(attachment.id);
      this.log(row.project_id, row.id, taskKey(row), actor, 'attachment_deleted', { filename: attachment.filename });
    });
    this.emit('task.updated', row.project_key, taskKey(row));
    return { deleted: attachment.id, task: taskKey(row) };
  }

  // ------------------------------------------------- questions & decisions

  formatQuestion(r) {
    return {
      id: r.id,
      task: r.task_key,
      status: r.answered_at ? 'answered' : 'open',
      question: r.question,
      options: JSON.parse(r.options),
      recommendation: r.recommendation,
      blocking: r.blocking === 1,
      asked_by: r.asked_by,
      asked_at: r.asked_at,
      answer: r.answer,
      answered_by: r.answered_by,
      answered_at: r.answered_at,
      decision: r.decision_number ? decisionId(r.decision_number) : null,
    };
  }

  questionRows(where, ...params) {
    return this.q(
      `SELECT q.*, p.key || '-' || t.number AS task_key, t.title AS task_title, d.number AS decision_number
       FROM questions q JOIN tasks t ON t.id = q.task_id JOIN projects p ON p.id = t.project_id
       LEFT JOIN decisions d ON d.id = q.decision_id
       WHERE ${where} ORDER BY q.id`,
    ).all(...params);
  }

  questionsFor(taskId) {
    return this.questionRows('q.task_id = ?', taskId).map((r) => this.formatQuestion(r));
  }

  listQuestions(projectKey, { status } = {}) {
    const project = this.projectRow(projectKey);
    const want = status ? oneOf(status, ['open', 'answered'], 'status') : null;
    const where = want === 'open' ? ' AND q.answered_at IS NULL' : want === 'answered' ? ' AND q.answered_at IS NOT NULL' : '';
    return this.questionRows(`t.project_id = ?${where}`, project.id).map((r) => ({ ...this.formatQuestion(r), task_title: r.task_title }));
  }

  // An agent asks the human. A blocking question parks the task: nobody but its holder can claim it
  // until the Director answers.
  askDirector(ref, input = {}, actor) {
    const question = text(input.question, 'question', { max: 5000, required: true });
    const options = lines(input.options);
    if (options.length > 12) throw new ApiError(400, 'at most 12 options');
    if (options.some((o) => o.length > 500)) throw new ApiError(400, 'options must be at most 500 characters each');
    const recommendation = text(input.recommendation, 'recommendation', { max: 5000 }) || null;
    const blocking = input.blocking !== false && input.blocking !== 'false';
    const row = this.taskRow(ref);
    const key = taskKey(row);
    if (row.type === 'epic') throw new ApiError(409, `${key} is an epic; ask on one of its tasks`);
    if (row.status === 'done') throw new ApiError(409, `${key} is done; ask on an open task (or create one)`);
    assertHolder(row, actor);
    const created = this.tx(() => {
      const ts = now();
      const { lastInsertRowid } = this.q(
        'INSERT INTO questions (task_id, question, options, recommendation, blocking, asked_by, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, question, JSON.stringify(options), recommendation, blocking ? 1 : 0, actor, ts);
      this.q('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, row.id);
      this.log(row.project_id, row.id, taskKey(row), actor, 'asked', { question: question.slice(0, 300), blocking });
      const asked = this.formatQuestion(this.questionRows('q.id = ?', Number(lastInsertRowid))[0]);
      if (!blocking) return asked;
      // What happens to the task now, so the asker doesn't have to look it up.
      const note =
        row.assignee === actor
          ? "You keep the claim; claim_next_task returns it to you once it's answered. Do other work meanwhile."
          : 'Nobody can claim it until the Director answers.';
      return { ...asked, parked: { task: key, status: row.status, note } };
    });
    this.emit('task.updated', row.project_key, taskKey(row));
    return created;
  }

  questionRow(id) {
    const s = String(id ?? '').trim();
    const row = /^\d+$/.test(s) ? this.questionRows('q.id = ?', Number(s))[0] : undefined;
    if (!row) throw new ApiError(404, `Question not found: ${s || '(empty)'}`);
    return row;
  }

  // The Director's answer: an option (index or text) and/or free text. It's posted as a comment the
  // agent reads in its next briefing, and can be recorded as a project Decision.
  answerQuestion(id, input = {}, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw new ApiError(403, 'Only the Director answers questions (from the board)');
    const q = this.questionRow(id);
    if (q.answered_at) throw new ApiError(409, `Question ${q.id} was already answered by ${q.answered_by}`);
    const options = JSON.parse(q.options);
    let picked = null;
    if (input.option !== undefined && input.option !== null && input.option !== '') {
      const o = String(input.option).trim();
      // A number is an index; a string is the option text (or an index, if no option reads like that).
      picked = typeof input.option === 'number' ? options[input.option] : options.find((x) => x === o);
      if (picked === undefined && typeof input.option === 'string' && /^\d+$/.test(o)) picked = options[Number(o)];
      if (picked === undefined) throw new ApiError(400, `No option ${JSON.stringify(input.option)}; options: ${options.join(' | ') || 'none'}`);
    }
    const note = text(input.answer, 'answer', { max: 20000 }) || '';
    if (!picked && !note) throw new ApiError(400, 'Pick an option or write an answer');
    const answer = picked && note ? `${picked}\n\n${note}` : picked || note;
    const row = this.taskRow(q.task_id);
    const result = this.tx(() => {
      const ts = now();
      let decision = null;
      if (input.record_decision === true || input.record_decision === 'true') {
        const d = input.decision ?? {};
        decision = this.insertDecision(
          row.project_id,
          {
            title: d.title || q.question.split('\n')[0].replace(/[*_`]/g, ''),
            decision: d.decision || answer,
            rationale: d.rationale,
            // No tags (or an empty list from a form) means the task's labels and epic, so it reaches briefings.
            tags: d.tags?.length ? d.tags : [...JSON.parse(row.labels), ...(row.epic_key ? [row.epic_key] : [])],
            source_task_id: row.id,
          },
          actor,
          ts,
        );
      }
      this.q('UPDATE questions SET answer = ?, answered_by = ?, answered_at = ?, decision_id = ? WHERE id = ?').run(
        answer,
        actor,
        ts,
        decision?.id ?? null,
        q.id,
      );
      const quoted = q.question.split('\n').map((l) => `> ${l}`).join('\n');
      this.insertComment(
        row,
        `**Director answered** (question ${q.id})\n\n${quoted}\n\n${answer}${decision ? `\n\nRecorded as decision **${decisionId(decision.number)}**.` : ''}`,
        actor,
        ts,
      );
      this.log(row.project_id, row.id, taskKey(row), actor, 'answered', {
        question: q.question.slice(0, 300),
        answer: answer.slice(0, 300),
        ...(decision && { decision: decisionId(decision.number) }),
        ...(q.blocking && { blocking: true }),
      });
      return this.formatQuestion(this.questionRow(q.id));
    });
    this.emit('task.updated', row.project_key, taskKey(row));
    return result;
  }

  formatDecision(r) {
    return {
      id: decisionId(r.number),
      number: r.number,
      project: r.project_key,
      title: r.title,
      decision: r.decision,
      rationale: r.rationale,
      date: r.created_at.slice(0, 10),
      source_task: r.source_key,
      tags: JSON.parse(r.tags),
      created_by: r.created_by,
      created_at: r.created_at,
    };
  }

  decisionRows(where, ...params) {
    return this.q(
      `SELECT d.*, p.key AS project_key, CASE WHEN t.id IS NULL THEN NULL ELSE p.key || '-' || t.number END AS source_key
       FROM decisions d JOIN projects p ON p.id = d.project_id LEFT JOIN tasks t ON t.id = d.source_task_id
       WHERE ${where} ORDER BY d.number DESC`,
    ).all(...params);
  }

  insertDecision(projectId, input, actor, ts = now()) {
    const title = text(input.title, 'title', { max: 300, required: true }).split('\n')[0].slice(0, 300);
    const decision = text(input.decision, 'decision', { max: 20000, required: true });
    const rationale = text(input.rationale, 'rationale', { max: 20000 }) ?? '';
    const tags = normLabels(input.tags);
    const number = this.q('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM decisions WHERE project_id = ?').get(projectId).n;
    const { lastInsertRowid } = this.q(
      `INSERT INTO decisions (project_id, number, title, decision, rationale, tags, source_task_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, number, title, decision, rationale, JSON.stringify(tags), input.source_task_id ?? null, actor, ts);
    const sourceKey = input.source_task_id ? taskKey(this.taskRow(input.source_task_id)) : null;
    this.log(projectId, input.source_task_id ?? null, sourceKey, actor, 'decision_recorded', { id: decisionId(number), title });
    return { id: Number(lastInsertRowid), number };
  }

  createDecision(projectKey, input = {}, actor, { role = 'agent' } = {}) {
    if (role !== 'director') throw new ApiError(403, 'Only the Director records decisions (from the board, or by answering a question)');
    const project = this.projectRow(projectKey);
    const source = input.source_task ? this.taskRow(input.source_task) : null;
    if (source && source.project_id !== project.id) throw new ApiError(400, `${taskKey(source)} is in another project`);
    const d = this.tx(() => this.insertDecision(project.id, { ...input, source_task_id: source?.id ?? null }, actor));
    this.emit('decision.created', project.key);
    return this.getDecision(project.key, d.number);
  }

  listDecisions(projectKey, { tag, q } = {}) {
    const project = this.projectRow(projectKey);
    const tags = csv(tag).map((t) => t.toLowerCase());
    const needle = String(q ?? '').trim().toLowerCase();
    return this.decisionRows('d.project_id = ?', project.id)
      .map((r) => this.formatDecision(r))
      .filter((d) => !tags.length || d.tags.some((t) => tags.includes(t.toLowerCase())))
      .filter((d) => !needle || `${d.title}\n${d.decision}\n${d.rationale}`.toLowerCase().includes(needle));
  }

  // "D-7", "D-007" or 7.
  getDecision(projectKey, ref) {
    const project = this.projectRow(projectKey);
    const m = String(ref ?? '').trim().match(/^(?:D-?)?(\d+)$/i);
    const row = m ? this.decisionRows('d.project_id = ? AND d.number = ?', project.id, Number(m[1]))[0] : undefined;
    if (!row) throw new ApiError(404, `Decision not found in ${project.key}: ${ref}. List them with list_decisions.`);
    return this.formatDecision(row);
  }

  // The 10 most recent decisions tagged with one of the task's labels or its epic (key or title).
  decisionsFor(row) {
    const wanted = new Set([...JSON.parse(row.labels), row.epic_key].filter(Boolean).map((t) => t.toLowerCase()));
    if (row.epic_id) wanted.add(this.q('SELECT title FROM tasks WHERE id = ?').get(row.epic_id).title.toLowerCase());
    if (!wanted.size) return [];
    return this.decisionRows('d.project_id = ?', row.project_id)
      .map((r) => this.formatDecision(r))
      .filter((d) => d.tags.some((t) => wanted.has(t.toLowerCase())))
      .slice(0, 10);
  }

  // -------------------------------------------------------- import / export

  assertExternalIdFree(projectId, externalId, exceptId = null) {
    const clash = this.q(`${TASK_SELECT} WHERE t.project_id = ? AND t.external_id = ? AND t.id <> ?`).get(projectId, externalId, exceptId ?? -1);
    if (clash) throw new ApiError(409, `external_id ${externalId} is already ${taskKey(clash)}`, { task: taskKey(clash) });
  }

  // Upserts tasks (and epics, type "epic") on external_id: existing ones get the fields given,
  // new ones are created. epic, parent and depends_on may name other items by external_id.
  // All or nothing. Returns what was created, updated and left unchanged.
  async importTasks(projectKey, items, actor, { role = 'agent' } = {}) {
    if (!Array.isArray(items) || !items.length) throw new ApiError(400, 'tasks must be a non-empty array');
    if (items.length > 500) throw new ApiError(400, 'at most 500 tasks per import');
    const result = this.tx(() => {
      const project = this.projectRow(projectKey);
      const seen = new Set();
      const plan = items.map((raw, i) => {
        const item = obj(raw ?? {}, `tasks[${i}]`);
        const externalId = normExternalId(item.external_id);
        if (!externalId) throw new ApiError(400, `tasks[${i}]: external_id is required to import`);
        if (seen.has(externalId)) throw new ApiError(400, `tasks[${i}]: external_id ${externalId} appears twice`);
        seen.add(externalId);
        return { i, item, externalId };
      });
      // Epics first so tasks can join them; links are set once every item exists.
      plan.sort((a, b) => (b.item.type === 'epic') - (a.item.type === 'epic') || a.i - b.i);
      const out = { created: [], updated: [], unchanged: [] };
      const ids = new Map();
      const LINKS = ['epic', 'parent', 'depends_on'];
      for (const { i, item, externalId } of plan) {
        const { external_id: _, project: __, tasks: ___, ...fields } = item;
        const base = Object.fromEntries(Object.entries(fields).filter(([k]) => !LINKS.includes(k)));
        try {
          const existing = this.q('SELECT id, updated_at FROM tasks WHERE project_id = ? AND external_id = ?').get(project.id, externalId);
          if (existing) {
            if (base.type !== undefined && (base.type === 'epic') !== (this.taskRow(existing.id).type === 'epic')) {
              throw new ApiError(400, 'cannot turn a task into an epic (or back) by import');
            }
            const { type, ...patch } = base;
            const after = this.applyTaskPatch(this.taskRow(existing.id), type === 'epic' ? patch : base, actor, { role });
            ids.set(externalId, existing.id);
            (after.updated_at !== existing.updated_at ? out.updated : out.unchanged).push({ key: after.key, external_id: externalId });
          } else {
            const status = base.status ?? (base.type === 'epic' ? 'todo' : undefined);
            const id = this.insertTask({ ...base, status, project: project.key, external_id: externalId }, actor, undefined, {
              role,
              epicGiven: item.epic !== undefined && item.epic !== null && item.epic !== '',
            });
            ids.set(externalId, id);
            out.created.push({ key: taskKey(this.taskRow(id)), external_id: externalId });
          }
        } catch (err) {
          if (err instanceof ApiError) err.message = `tasks[${i}] (${externalId}): ${err.message}`;
          throw err;
        }
      }
      // A reference is a task key, an external_id from this import or the project, or (epics) a title.
      const ref = (r) => {
        const v = String(r).trim();
        if (ids.has(v)) return String(ids.get(v));
        const byExternal = this.q('SELECT id FROM tasks WHERE project_id = ? AND external_id = ?').get(project.id, v);
        return byExternal ? String(byExternal.id) : v;
      };
      for (const { i, item, externalId } of plan) {
        const links = {};
        if (item.epic !== undefined) links.epic = item.epic === null || item.epic === '' ? null : ref(item.epic);
        if (item.parent !== undefined) links.parent = item.parent === null || item.parent === '' ? null : ref(item.parent);
        if (item.depends_on !== undefined) links.depends_on = csv(item.depends_on).map(ref);
        if (!Object.keys(links).length) continue;
        try {
          const id = ids.get(externalId);
          const before = this.q('SELECT updated_at FROM tasks WHERE id = ?').get(id).updated_at;
          const after = this.applyTaskPatch(this.taskRow(id), links, actor, { role });
          const entry = { key: after.key, external_id: externalId };
          if (after.updated_at !== before && out.unchanged.some((u) => u.external_id === externalId)) {
            out.unchanged = out.unchanged.filter((u) => u.external_id !== externalId);
            out.updated.push(entry);
          }
        } catch (err) {
          if (err instanceof ApiError) err.message = `tasks[${i}] (${externalId}): ${err.message}`;
          throw err;
        }
      }
      this.log(project.id, null, null, actor, 'imported', { created: out.created.length, updated: out.updated.length, unchanged: out.unchanged.length });
      return { project: project.key, ...out };
    });
    await this.recordNewBaselines([...result.created, ...result.updated].map((e) => this.taskRow(e.key)));
    this.emit('project.updated', result.project);
    return result;
  }

  // A read-only Markdown snapshot of the project for a repo to commit: epics, then their tasks with
  // status, priority, estimate, dependencies, criteria and description. Ordered by key and free of
  // timestamps, so a re-export only changes when the board does.
  exportMarkdown(projectKey) {
    const project = this.projectRow(projectKey);
    const tasks = this.q(`${TASK_SELECT} WHERE t.project_id = ? ORDER BY t.number`).all(project.id).map((r) => this.formatTask(r));
    const epics = tasks.filter((t) => t.type === 'epic');
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const name = (key) => {
      const t = byKey.get(key);
      return t?.external_id ? `${key} (${t.external_id})` : key;
    };
    const counts = STATUSES.map((st) => `${tasks.filter((t) => t.type !== 'epic' && t.status === st).length} ${STATUS_NAMES[st].toLowerCase()}`);
    const out = [
      `# ${project.name} (${project.key})`,
      '',
      `> Generated from the AI Kanban board. Read-only snapshot: change the board, not this file.`,
      '',
      `${tasks.filter((t) => t.type !== 'epic').length} tasks: ${counts.join(', ')}.`,
    ];
    const taskBlock = (t) => {
      const lines = [
        '',
        `### ${t.key}${t.external_id ? ` · ${t.external_id}` : ''} · ${t.title}`,
        '',
        `- **Status:** ${STATUS_NAMES[t.status]} · **Priority:** ${t.priority} · **Type:** ${t.type}${t.estimate !== null ? ` · **Estimate:** ${t.estimate}` : ''}${
          t.assignee ? ` · **Assignee:** ${t.assignee}` : ''
        }`,
      ];
      if (t.parent) lines.push(`- **Parent:** ${name(t.parent)}`);
      if (t.depends_on.length) lines.push(`- **Depends on:** ${t.depends_on.map(name).join(', ')}`);
      if (t.labels.length) lines.push(`- **Labels:** ${t.labels.join(', ')}`);
      if (t.milestone) lines.push(`- **Milestone:** ${t.milestone}`);
      if (t.sprint) lines.push(`- **Sprint:** ${t.sprint}`);
      if (t.prerequisites.length) lines.push(`- **Prerequisites:** ${t.prerequisites.map((p) => `[${p.done ? 'x' : ' '}] ${p.text}`).join('; ')}`);
      if (t.context.length) lines.push(`- **Context:** ${t.context.join(', ')}`);
      if (t.criteria.length) {
        lines.push('', '**Criteria**', '');
        for (const c of t.criteria) lines.push(`- [${c.done ? 'x' : ' '}] ${c.owner === 'human' ? '(Director) ' : ''}${c.text}`);
      }
      if (t.description.trim()) lines.push('', '**Description**', '', t.description.trim().replace(/^(#{1,3}) /gm, '#### '));
      return lines;
    };
    // Subtasks follow their parent, wherever the parent is listed; a task is placed by its top-level ancestor.
    const subtasksOf = new Map();
    for (const t of tasks) if (t.parent && byKey.has(t.parent)) subtasksOf.set(t.parent, [...(subtasksOf.get(t.parent) ?? []), t]);
    const withSubtasks = (t, seen = new Set()) => {
      if (seen.has(t.key)) return [];
      seen.add(t.key);
      return [...taskBlock(t), ...(subtasksOf.get(t.key) ?? []).flatMap((c) => withSubtasks(c, seen))];
    };
    const topLevel = (t) => t.type !== 'epic' && !(t.parent && byKey.has(t.parent));
    for (const epic of epics) {
      const children = tasks.filter((t) => t.epic === epic.key);
      out.push('', `## ${epic.title} (${epic.key}${epic.external_id ? ` · ${epic.external_id}` : ''})`, '');
      out.push(`${STATUS_NAMES[epic.status]} · ${children.filter((c) => c.status === 'done').length}/${children.length} done`);
      if (epic.description.trim()) out.push('', epic.description.trim().replace(/^(#{1,3}) /gm, '#### '));
      for (const t of children.filter(topLevel)) out.push(...withSubtasks(t));
    }
    const loose = tasks.filter((t) => topLevel(t) && !t.epic);
    if (loose.length) {
      out.push('', epics.length ? '## Not in an epic' : '## Tasks');
      for (const t of loose) out.push(...withSubtasks(t));
    }
    return `${out.join('\n')}\n`;
  }

  // --------------------------------------------------------------- comments

  commentsFor(row) {
    return this.q('SELECT id, author, body, created_at FROM comments WHERE task_id = ? ORDER BY id')
      .all(row.id)
      .map((c) => ({ ...c, task: taskKey(row) }));
  }

  listComments(ref) {
    return this.commentsFor(this.taskRow(ref));
  }

  addComment(ref, input, actor) {
    const body = text(input.body, 'body', { max: 50000, required: true });
    const row = this.taskRow(ref);
    const asCheckpoint = input.checkpoint === true || input.checkpoint === 'true';
    const comment = this.tx(() => {
      const created = this.insertComment(row, body, actor, now());
      if (asCheckpoint) {
        this.q('UPDATE tasks SET checkpoint = ?, updated_at = ? WHERE id = ?').run(makeCheckpoint(body.slice(0, 20000), actor), created.created_at, row.id);
        this.log(row.project_id, row.id, taskKey(row), actor, 'checkpoint_set', { excerpt: body.slice(0, 160) });
      }
      return asCheckpoint ? { ...created, checkpoint: true } : created;
    });
    this.emit('comment.created', row.project_key, comment.task);
    return comment;
  }

  insertComment(row, body, actor, ts) {
    const { lastInsertRowid } = this.q('INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)').run(
      row.id,
      actor,
      body,
      ts,
    );
    this.q('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, row.id);
    this.log(row.project_id, row.id, taskKey(row), actor, 'commented', { excerpt: body.slice(0, 160) });
    return { id: Number(lastInsertRowid), task: taskKey(row), author: actor, body, created_at: ts };
  }

  // --------------------------------------------------------------- activity

  listActivity(f = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (f.project) {
      where.push('a.project_id = ?');
      params.push(this.projectRow(f.project).id);
    }
    if (f.task) {
      where.push('a.task_key = ?');
      params.push(String(f.task).trim().toUpperCase());
    }
    if (f.actor) {
      where.push('a.actor = ?');
      params.push(f.actor);
    }
    if (f.after) {
      where.push('a.id > ?');
      params.push(clampInt(f.after, 0, Number.MAX_SAFE_INTEGER, 0));
    }
    const limit = clampInt(f.limit, 1, 500, 50);
    return this.db
      .prepare(
        `SELECT a.*, p.key AS project_key FROM activity a JOIN projects p ON p.id = a.project_id
         WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${limit}`,
      )
      .all(...params)
      .map(formatActivity);
  }

  // ------------------------------------------------------------- milestones

  // A milestone is referenced by numeric id or by name (case-insensitive, within the project).
  milestoneRow(ref, projectId = null) {
    const s = String(ref ?? '').trim();
    let row;
    if (/^\d+$/.test(s)) {
      row = this.q('SELECT * FROM milestones WHERE id = ?').get(Number(s));
      if (row && projectId !== null && row.project_id !== projectId) row = undefined;
    } else if (projectId !== null) {
      row = this.q('SELECT * FROM milestones WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, s);
    } else {
      const matches = this.q('SELECT * FROM milestones WHERE name = ? COLLATE NOCASE').all(s);
      if (matches.length > 1) throw new ApiError(400, `Milestone name "${s}" exists in several projects; pass the project too`);
      row = matches[0];
    }
    if (!row) throw new ApiError(404, `Milestone not found: ${s || '(empty)'}. Create it first (create_milestone) or list them (list_milestones).`);
    return row;
  }

  formatMilestone(row) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const c of this.q('SELECT status, COUNT(*) AS n FROM tasks WHERE milestone_id = ? GROUP BY status').all(row.id)) {
      counts[c.status] = c.n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      id: row.id,
      project: this.q('SELECT key FROM projects WHERE id = ?').get(row.project_id).key,
      name: row.name,
      description: row.description,
      due_date: row.due_date,
      status: row.status,
      task_counts: counts,
      total,
      done: counts.done,
      progress: total ? Math.round((counts.done / total) * 100) : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  milestoneInput(input, existing = {}) {
    const out = {};
    if (input.name !== undefined || !existing.name) out.name = text(input.name, 'name', { max: 120, required: true });
    if (input.description !== undefined) out.description = text(input.description, 'description', { max: 20000 }) ?? '';
    if (input.due_date !== undefined) {
      const due = input.due_date === null || input.due_date === '' ? null : String(input.due_date).trim();
      if (due !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)))) {
        throw new ApiError(400, 'due_date must be YYYY-MM-DD (or null)');
      }
      out.due_date = due;
    }
    if (input.status !== undefined) out.status = oneOf(input.status, MILESTONE_STATUSES, 'milestone status');
    return out;
  }

  listMilestones(projectKey, { status } = {}) {
    const project = this.projectRow(projectKey);
    const statuses = csv(status).map((s) => oneOf(s, MILESTONE_STATUSES, 'milestone status'));
    return this.q(
      // Open first, then by due date (undated last), then creation order.
      `SELECT * FROM milestones WHERE project_id = ?
       ORDER BY status = 'closed', due_date IS NULL, due_date, id`,
    )
      .all(project.id)
      .filter((m) => !statuses.length || statuses.includes(m.status))
      .map((m) => this.formatMilestone(m));
  }

  getMilestone(ref, projectKey) {
    const row = this.milestoneRow(ref, projectKey ? this.projectRow(projectKey).id : null);
    const tasks = this.q(`${TASK_SELECT} WHERE t.milestone_id = ? ORDER BY ${STATUS_ORDER_SQL}, ${BOARD_ORDER_SQL}`)
      .all(row.id)
      .map((r) => this.formatTask(r));
    return { ...this.formatMilestone(row), tasks };
  }

  createMilestone(projectKey, input, actor) {
    const milestone = this.tx(() => {
      const project = this.projectRow(projectKey);
      const data = { description: '', due_date: null, status: 'open', ...this.milestoneInput(input) };
      if (this.q('SELECT 1 FROM milestones WHERE project_id = ? AND name = ? COLLATE NOCASE').get(project.id, data.name)) {
        throw new ApiError(409, `Milestone "${data.name}" already exists in ${project.key}`);
      }
      const ts = now();
      const { lastInsertRowid } = this.q(
        'INSERT INTO milestones (project_id, name, description, due_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(project.id, data.name, data.description, data.due_date, data.status, ts, ts);
      const id = Number(lastInsertRowid);
      for (const ref of csv(input.tasks)) this.attachToMilestone(this.taskRow(ref), { id, name: data.name }, project.id, actor);
      this.log(project.id, null, null, actor, 'milestone_created', { name: data.name, due_date: data.due_date });
      return this.formatMilestone(this.milestoneRow(id));
    });
    this.emit('milestone.created', milestone.project);
    return milestone;
  }

  updateMilestone(ref, patch, actor) {
    const milestone = this.tx(() => {
      const row = this.milestoneRow(ref, patch.project ? this.projectRow(patch.project).id : null);
      const data = this.milestoneInput(patch, row);
      const changes = {};
      for (const [field, value] of Object.entries(data)) {
        if (field === 'description' ? value !== row.description : value !== row[field]) {
          changes[field] = field === 'description' ? 'edited' : [row[field], value];
        }
      }
      if (data.name && data.name.toLowerCase() !== row.name.toLowerCase()) {
        const clash = this.q('SELECT 1 FROM milestones WHERE project_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(
          row.project_id,
          data.name,
          row.id,
        );
        if (clash) throw new ApiError(409, `Milestone "${data.name}" already exists`);
      }
      const merged = { ...row, ...data };
      this.q('UPDATE milestones SET name = ?, description = ?, due_date = ?, status = ?, updated_at = ? WHERE id = ?').run(
        merged.name,
        merged.description,
        merged.due_date,
        merged.status,
        now(),
        row.id,
      );
      for (const taskRef of csv(patch.add_tasks)) this.attachToMilestone(this.taskRow(taskRef), merged, row.project_id, actor);
      if (Object.keys(changes).length) {
        this.log(row.project_id, null, null, actor, 'milestone_updated', { name: merged.name, changes });
      }
      return this.formatMilestone(this.milestoneRow(row.id));
    });
    this.emit('milestone.updated', milestone.project);
    return milestone;
  }

  deleteMilestone(ref, actor) {
    const row = this.milestoneRow(ref);
    const project = this.q('SELECT key FROM projects WHERE id = ?').get(row.project_id).key;
    this.tx(() => {
      this.q('DELETE FROM milestones WHERE id = ?').run(row.id);
      this.log(row.project_id, null, null, actor, 'milestone_deleted', { name: row.name });
    });
    this.emit('milestone.deleted', project);
    return { deleted: row.name, tasks_detached: true };
  }

  attachToMilestone(taskRow, milestone, projectId, actor) {
    if (taskRow.project_id !== projectId) {
      throw new ApiError(400, `${taskKey(taskRow)} belongs to another project than this milestone`);
    }
    if (taskRow.milestone_id === milestone.id) return;
    this.q('UPDATE tasks SET milestone_id = ?, updated_at = ? WHERE id = ?').run(milestone.id, now(), taskRow.id);
    this.log(projectId, taskRow.id, taskKey(taskRow), actor, 'updated', {
      changes: { milestone: [taskRow.milestone_name, milestone.name] },
    });
  }

  // ------------------------------------------------------------------ epics

  // An epic is referenced by key/id, or by title within a project.
  epicRow(ref, projectId = null) {
    const s = String(ref ?? '').trim();
    let row;
    if (/^\d+$/.test(s) || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s)) {
      row = this.taskRow(s);
    } else if (projectId !== null) {
      row = this.q(`${TASK_SELECT} WHERE t.project_id = ? AND t.type = 'epic' AND t.title = ? COLLATE NOCASE`).get(projectId, s);
      if (!row) throw new ApiError(404, `Epic not found: ${s}. List them with list_epics or create one with create_epic.`);
    } else {
      throw new ApiError(400, `Reference epics by key (e.g. "AS-21"), or pass the project to look up "${s}" by title`);
    }
    if (row.type !== 'epic') throw new ApiError(400, `${taskKey(row)} is not an epic (it's a ${row.type})`);
    if (projectId !== null && row.project_id !== projectId) throw new ApiError(400, `Epic ${taskKey(row)} belongs to another project`);
    return row;
  }

  childProgress(epicId) {
    return this.progressFor('epic_id', epicId);
  }

  progressFor(column, id) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let pointsTotal = 0;
    let pointsDone = 0;
    for (const c of this.q(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(estimate), 0) AS pts FROM tasks WHERE ${column} = ? GROUP BY status`,
    ).all(id)) {
      counts[c.status] = c.n;
      pointsTotal += c.pts;
      if (c.status === 'done') pointsDone += c.pts;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      task_counts: counts,
      total,
      done: counts.done,
      percent: total ? Math.round((counts.done / total) * 100) : 0,
      points_total: pointsTotal,
      points_done: pointsDone,
    };
  }

  listEpics(projectKey) {
    const project = this.projectRow(projectKey);
    return this.q(`${TASK_SELECT} WHERE t.project_id = ? AND t.type = 'epic' ORDER BY t.status = 'done', ${BOARD_ORDER_SQL}`)
      .all(project.id)
      .map((r) => ({ ...this.formatTask(r), progress: this.childProgress(r.id) }));
  }

  createEpic(projectKey, input, actor, { role = 'agent' } = {}) {
    const epic = this.tx(() => {
      const id = this.insertTask(
        { ...input, project: projectKey, type: 'epic', status: input.status ?? 'todo', epic: undefined, sprint: undefined },
        actor,
        undefined,
        { role },
      );
      const row = this.taskRow(id);
      for (const ref of csv(input.tasks)) this.attachToEpic(this.taskRow(ref), row, actor);
      return { ...this.formatTask(this.taskRow(id)), progress: this.childProgress(id) };
    });
    this.emit('task.created', epic.project, epic.key);
    return epic;
  }

  attachToEpic(task, epic, actor) {
    if (task.type === 'epic') throw new ApiError(400, `${taskKey(task)} is an epic; epics can't be nested`);
    if (task.project_id !== epic.project_id) throw new ApiError(400, `${taskKey(task)} is in another project`);
    if (task.epic_id === epic.id) return;
    this.q('UPDATE tasks SET epic_id = ?, updated_at = ? WHERE id = ?').run(epic.id, now(), task.id);
    this.log(task.project_id, task.id, taskKey(task), actor, 'updated', { changes: { epic: [task.epic_key, taskKey(epic)] } });
  }

  // ---------------------------------------------------------------- sprints

  // A sprint is referenced by id, by name (within a project), or as "active".
  sprintRow(ref, projectId = null) {
    const s = String(ref ?? '').trim();
    let row;
    if (/^\d+$/.test(s)) {
      row = this.q('SELECT * FROM sprints WHERE id = ?').get(Number(s));
      if (row && projectId !== null && row.project_id !== projectId) row = undefined;
    } else if (projectId !== null && s.toLowerCase() === 'active') {
      row = this.q("SELECT * FROM sprints WHERE project_id = ? AND status = 'active'").get(projectId);
      if (!row) throw new ApiError(404, 'There is no active sprint');
    } else if (projectId !== null) {
      row = this.q('SELECT * FROM sprints WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, s);
    } else {
      const matches = this.q('SELECT * FROM sprints WHERE name = ? COLLATE NOCASE').all(s);
      if (matches.length > 1) throw new ApiError(400, `Sprint name "${s}" exists in several projects; pass the project too`);
      row = matches[0];
    }
    if (!row) throw new ApiError(404, `Sprint not found: ${s || '(empty)'}. List them with list_sprints or create one with create_sprint.`);
    return row;
  }

  formatSprint(row) {
    return {
      id: row.id,
      project: this.q('SELECT key FROM projects WHERE id = ?').get(row.project_id).key,
      name: row.name,
      goal: row.goal,
      status: row.status,
      start_date: row.start_date,
      end_date: row.end_date,
      position: row.position,
      ...this.progressFor('sprint_id', row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
    };
  }

  listSprints(projectKey, { status } = {}) {
    const project = this.projectRow(projectKey);
    const statuses = csv(status).map((s) => oneOf(s, SPRINT_STATUSES, 'sprint status'));
    // Active first, then upcoming in planned order, then finished ones.
    return this.q(
      `SELECT * FROM sprints WHERE project_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, position, id`,
    )
      .all(project.id)
      .filter((row) => !statuses.length || statuses.includes(row.status))
      .map((row) => this.formatSprint(row));
  }

  sprintTasks(sprintId) {
    return this.q(`${TASK_SELECT} WHERE t.sprint_id = ? ORDER BY t.status = 'done', ${BOARD_ORDER_SQL}`)
      .all(sprintId)
      .map((r) => this.formatTask(r));
  }

  getSprint(ref, projectKey) {
    const row = this.sprintRow(ref, projectKey ? this.projectRow(projectKey).id : null);
    return { ...this.formatSprint(row), tasks: this.sprintTasks(row.id) };
  }

  // The whole plan at a glance: every sprint with its tasks, plus unscheduled work.
  getPlan(projectKey) {
    const project = this.projectRow(projectKey);
    return {
      project: this.formatProject(project),
      sprints: this.listSprints(project.key).map((s) => ({ ...s, tasks: this.sprintTasks(s.id) })),
      unscheduled: this.q(
        `${TASK_SELECT} WHERE t.project_id = ? AND t.sprint_id IS NULL AND ${NOT_EPIC_SQL} AND t.status <> 'done'
         ORDER BY ${BOARD_ORDER_SQL}`,
      )
        .all(project.id)
        .map((r) => this.formatTask(r)),
      epics: this.listEpics(project.key),
      decisions: this.listDecisions(project.key),
    };
  }

  sprintInput(input, existing = {}) {
    const out = {};
    if (input.name !== undefined) out.name = text(input.name, 'name', { max: 120, required: true });
    if (input.goal !== undefined) out.goal = text(input.goal, 'goal', { max: 20000 }) ?? '';
    const start = isoDate(input.start_date, 'start_date');
    const end = isoDate(input.end_date, 'end_date');
    if (start !== undefined) out.start_date = start;
    if (end !== undefined) out.end_date = end;
    const s = out.start_date === undefined ? existing.start_date : out.start_date;
    const e = out.end_date === undefined ? existing.end_date : out.end_date;
    if (s && e && e < s) throw new ApiError(400, 'end_date must be on or after start_date');
    return out;
  }

  createSprint(projectKey, input, actor) {
    const sprint = this.tx(() => {
      const project = this.projectRow(projectKey);
      const data = { goal: '', start_date: null, end_date: null, ...this.sprintInput(input) };
      if (!data.name) {
        const count = this.q('SELECT COUNT(*) AS n FROM sprints WHERE project_id = ?').get(project.id).n;
        let n = count + 1;
        while (this.q('SELECT 1 FROM sprints WHERE project_id = ? AND name = ? COLLATE NOCASE').get(project.id, `Sprint ${n}`)) n++;
        data.name = `Sprint ${n}`;
      }
      if (this.q('SELECT 1 FROM sprints WHERE project_id = ? AND name = ? COLLATE NOCASE').get(project.id, data.name)) {
        throw new ApiError(409, `Sprint "${data.name}" already exists in ${project.key}`);
      }
      const position = this.q('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM sprints WHERE project_id = ?').get(project.id).pos;
      const ts = now();
      const { lastInsertRowid } = this.q(
        `INSERT INTO sprints (project_id, name, goal, start_date, end_date, status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)`,
      ).run(project.id, data.name, data.goal, data.start_date, data.end_date, position, ts, ts);
      const row = this.sprintRow(Number(lastInsertRowid));
      for (const ref of csv(input.tasks)) this.attachToSprint(this.taskRow(ref), row, actor);
      this.log(project.id, null, null, actor, 'sprint_created', { name: data.name });
      if (input.status && input.status !== 'planned') this.setSprintStatus(row, input.status, input, actor);
      return this.formatSprint(this.sprintRow(row.id));
    });
    this.emit('sprint.created', sprint.project);
    return sprint;
  }

  updateSprint(ref, patch, actor) {
    const result = this.tx(() => {
      const row = this.sprintRow(ref, patch.project ? this.projectRow(patch.project).id : null);
      const data = this.sprintInput(patch, row);
      const changes = {};
      for (const [field, value] of Object.entries(data)) {
        if (value !== row[field]) changes[field] = field === 'goal' ? 'edited' : [row[field], value];
      }
      if (data.name && data.name.toLowerCase() !== row.name.toLowerCase()) {
        if (this.q('SELECT 1 FROM sprints WHERE project_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(row.project_id, data.name, row.id)) {
          throw new ApiError(409, `Sprint "${data.name}" already exists`);
        }
      }
      if (Object.keys(changes).length) {
        const merged = { ...row, ...data };
        this.q('UPDATE sprints SET name = ?, goal = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?').run(
          merged.name,
          merged.goal,
          merged.start_date,
          merged.end_date,
          now(),
          row.id,
        );
        this.log(row.project_id, null, null, actor, 'sprint_updated', { name: merged.name, changes });
      }
      const current = this.sprintRow(row.id);
      for (const taskRef of csv(patch.add_tasks)) this.attachToSprint(this.taskRow(taskRef), current, actor);
      for (const taskRef of csv(patch.remove_tasks)) {
        const task = this.taskRow(taskRef);
        if (task.sprint_id !== row.id) continue;
        this.q('UPDATE tasks SET sprint_id = NULL, updated_at = ? WHERE id = ?').run(now(), task.id);
        this.log(task.project_id, task.id, taskKey(task), actor, 'updated', { changes: { sprint: [row.name, null] } });
      }
      const transition = patch.status !== undefined ? this.setSprintStatus(current, patch.status, patch, actor) : {};
      return { ...this.formatSprint(this.sprintRow(row.id)), ...transition };
    });
    this.emit('sprint.updated', result.project);
    return result;
  }

  // planned -> active -> completed. Completing carries unfinished tasks over to
  // `carry_over_to` (a sprint, or null for unscheduled); by default the next planned sprint.
  setSprintStatus(row, value, { carry_over_to: carryOver } = {}, actor) {
    const status = oneOf(value, SPRINT_STATUSES, 'sprint status');
    if (status === row.status) return {};
    const ts = now();
    const result = {};
    if (status === 'active') {
      const active = this.q("SELECT name FROM sprints WHERE project_id = ? AND status = 'active' AND id <> ?").get(row.project_id, row.id);
      if (active) throw new ApiError(409, `"${active.name}" is already active; complete it first`);
      this.q("UPDATE sprints SET status = 'active', start_date = COALESCE(start_date, ?), completed_at = NULL, updated_at = ? WHERE id = ?").run(
        today(),
        ts,
        row.id,
      );
      this.log(row.project_id, null, null, actor, 'sprint_started', { name: row.name });
    } else if (status === 'completed') {
      let target = null;
      if (carryOver === undefined) {
        target =
          this.q("SELECT * FROM sprints WHERE project_id = ? AND status = 'planned' AND id <> ? ORDER BY position, id").get(
            row.project_id,
            row.id,
          ) ?? null;
      } else if (carryOver !== null && carryOver !== '' && String(carryOver).toLowerCase() !== 'none') {
        target = this.sprintRow(carryOver, row.project_id);
        if (target.id === row.id) throw new ApiError(400, 'carry_over_to must be a different sprint');
      }
      const open = this.q(`${TASK_SELECT} WHERE t.sprint_id = ? AND t.status <> 'done'`).all(row.id);
      for (const task of open) {
        this.q('UPDATE tasks SET sprint_id = ?, updated_at = ? WHERE id = ?').run(target?.id ?? null, ts, task.id);
      }
      this.q("UPDATE sprints SET status = 'completed', end_date = COALESCE(end_date, ?), completed_at = ?, updated_at = ? WHERE id = ?").run(
        today(),
        ts,
        ts,
        row.id,
      );
      result.carried_over = open.map(taskKey);
      result.carried_to = target?.name ?? null;
      this.log(row.project_id, null, null, actor, 'sprint_completed', { name: row.name, ...result });
    } else {
      this.q("UPDATE sprints SET status = 'planned', completed_at = NULL, updated_at = ? WHERE id = ?").run(ts, row.id);
      this.log(row.project_id, null, null, actor, 'sprint_updated', { name: row.name, changes: { status: [row.status, 'planned'] } });
    }
    return result;
  }

  deleteSprint(ref, actor) {
    const row = this.sprintRow(ref);
    const project = this.q('SELECT key FROM projects WHERE id = ?').get(row.project_id).key;
    this.tx(() => {
      this.q('DELETE FROM sprints WHERE id = ?').run(row.id);
      this.log(row.project_id, null, null, actor, 'sprint_deleted', { name: row.name });
    });
    this.emit('sprint.deleted', project);
    return { deleted: row.name, tasks_unscheduled: true };
  }

  attachToSprint(task, sprint, actor) {
    if (task.type === 'epic') throw new ApiError(400, `${taskKey(task)} is an epic; put its tasks in sprints instead`);
    if (task.project_id !== sprint.project_id) throw new ApiError(400, `${taskKey(task)} is in another project`);
    if (task.sprint_id === sprint.id) return;
    this.q('UPDATE tasks SET sprint_id = ?, updated_at = ? WHERE id = ?').run(sprint.id, now(), task.id);
    this.log(task.project_id, task.id, taskKey(task), actor, 'updated', { changes: { sprint: [task.sprint_name, sprint.name] } });
  }

  // ---------------------------------------------------------------- private

  nextPosition(projectId, status) {
    return this.q('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE project_id = ? AND status = ?').get(
      projectId,
      status,
    ).pos;
  }

  // Renumbers the column so the task sits at `index` (end of column when omitted).
  columnRows(projectId, status, excludeId) {
    return this.q(
      `SELECT t.id, t.priority FROM tasks t
       WHERE t.project_id = ? AND t.status = ? AND t.id <> ? AND ${NOT_EPIC_SQL} ORDER BY ${BOARD_ORDER_SQL}`,
    ).all(projectId, status, excludeId);
  }

  placeInColumn(projectId, status, taskId, index) {
    const ids = this.columnRows(projectId, status, taskId).map((r) => r.id);
    const at = index === undefined || index === null ? ids.length : clampInt(index, 0, ids.length, ids.length);
    ids.splice(at, 0, taskId);
    const update = this.q('UPDATE tasks SET position = ? WHERE id = ?');
    ids.forEach((id, pos) => update.run(pos, id));
  }

  setDependencies(taskId, refs) {
    const ids = [...new Set(refs.map((r) => this.taskRow(r).id))];
    for (const depId of ids) {
      if (depId === taskId) throw new ApiError(400, 'A task cannot depend on itself');
      if (this.dependsOn(depId, taskId)) throw new ApiError(400, 'That dependency would create a cycle');
    }
    this.q('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
    const insert = this.q('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)');
    for (const depId of ids) insert.run(taskId, depId);
  }

  // True when `fromId` depends on `targetId`, directly or transitively.
  dependsOn(fromId, targetId) {
    const seen = new Set();
    const stack = [fromId];
    while (stack.length) {
      const id = stack.pop();
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const r of this.q('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?').all(id)) {
        stack.push(r.depends_on_id);
      }
    }
    return false;
  }

  resolveParent(taskId, ref) {
    if (ref === null || ref === '') return null;
    const parent = this.taskRow(ref);
    for (let id = parent.id; id !== null; ) {
      if (id === taskId) throw new ApiError(400, 'A task cannot be its own ancestor');
      id = this.q('SELECT parent_id FROM tasks WHERE id = ?').get(id)?.parent_id ?? null;
    }
    return parent;
  }
}
