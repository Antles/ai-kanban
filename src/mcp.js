// Minimal stateless MCP server over Streamable HTTP (JSON responses only).
// Every tool maps 1:1 onto a Kanban service method, same as the REST API.
import { STATUSES, PRIORITIES, TYPES, MILESTONE_STATUSES, SPRINT_STATUSES, ApiError } from './service.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// A tool returning { [CONTENT]: [...] } supplies raw MCP content blocks (e.g. an image) instead of JSON text.
const CONTENT = Symbol('mcp content');
// Larger images are too big to inline for the model; the tool points at the URL instead.
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const str = (description) => ({ type: 'string', description });
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });
const task = str('Task key, e.g. "APP-12"');
const project = str('Project key, e.g. "APP"');
const agent = str('Act as this agent (default: this connection\'s X-Agent). Subagents pass the name they claimed with.');

const taskFields = {
  title: str('Short, imperative summary'),
  description: str('Markdown: the goal and background. Put the checklist in "criteria" and files to read in "context".'),
  status: {
    type: 'string',
    enum: STATUSES,
    description:
      'Agents change status only through its door: in_progress by claiming (409), review by submit_for_review (409), done by the holder (see move_task). Never on a task another agent holds (403). New tasks start in backlog or todo.',
  },
  priority: {
    type: 'string',
    enum: [...PRIORITIES].reverse(),
    description: 'How much it matters. Columns sort highest first and claim_next_task hands out work in that order.',
  },
  type: { type: 'string', enum: TYPES.filter((t) => t !== 'epic'), description: 'Use create_epic for epics' },
  assignee: { type: ['string', 'null'], description: 'Agent or person name; null to unassign. Only on your own or unassigned tasks (403 otherwise).' },
  labels: strList('Free-form labels, e.g. ["gameplay", "ui"]. A protected_paths unlock label (e.g. golden-change) is Director-only; ask_director for it.'),
  parent: { type: ['string', 'null'], description: 'Parent task key (for subtasks)' },
  milestone: { type: ['string', 'null'], description: 'Milestone name or id in the same project; null to detach' },
  epic: { type: ['string', 'null'], description: 'Epic key (e.g. "AS-21") or exact epic title; null to detach' },
  sprint: { type: ['string', 'null'], description: 'Sprint name or id, or "active"; null to unschedule' },
  estimate: { type: ['integer', 'null'], minimum: 0, description: 'Size in story points (1, 2, 3, 5, 8, 13). Split anything above 8.' },
  depends_on: strList('Keys of tasks that must be done before this one can start'),
  criteria: {
    type: 'array',
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { text: { type: 'string' }, done: { type: 'boolean' }, owner: { type: 'string', enum: ['agent', 'human'] } },
          required: ['text'],
        },
      ],
    },
    description:
      'Acceptance criteria: concrete, checkable statements of done ("Second jump resets on landing"). Replaces the list; ticks, owners and evidence are kept for unchanged items. ' +
      'Prefix "[director] " (or pass owner: "human") for items only the human can verify, e.g. "[director] Text readable on your phone"; you can add those but never tick or remove them.',
  },
  context: strList('What to read before starting: repo paths, docs or URLs (e.g. "docs/checkout.md", "src/checkout/")'),
  scope: strList(
    'Globs of the files this task may change ("src/checkout/**", "docs/checkout.md"). On submit, changed files outside it are flagged to the reviewer. Widen via update_task.',
  ),
  external_id: { type: ['string', 'null'], description: 'An ID from outside the board, e.g. "T07" from docs/backlog.md; unique per project' },
  prerequisites: strList(
    'Things the human must do before an agent can start ("Install the .NET 8 SDK", "Add the API key to .env"). Unticked ones block the task like depends_on. You can add them; only the human ticks them.',
  ),
};

// The batch and update tools share create_task's field docs; repeating them cost every agent ~10 KB.
const seeCreateTask = Object.fromEntries(
  Object.entries(taskFields).map(([k, v]) => [
    k,
    v.description ? { type: v.type, ...(v.enum && { enum: v.enum }), ...(v.type === 'array' && { items: {} }), description: 'See create_task.' } : v,
  ]),
);

const extractFlag = {
  type: 'boolean',
  description: 'Move the description\'s "- [ ]" checklist lines into criteria (and out of the description)',
};

// Optional project rules (see the guide). Passing null resets one to its default.
const projectSettings = {
  checks: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        command: { type: 'string', description: 'e.g. "npm test"' },
        required: { type: 'boolean' },
        required_when_paths: { type: 'array', items: { type: 'string' }, description: 'Required only when a changed file matches one' },
      },
      required: ['name', 'command'],
    },
    description: 'Checks agents must run and report in submit_for_review. The server never runs them.',
  },
  required_fields: {
    type: ['array', 'null'],
    items: { type: 'string', enum: ['priority', 'estimate', 'epic', 'criteria', 'labels'] },
    description: 'Fields a task needs before it can be in todo (backlog captures may lack them; creating in or moving to todo without them is a 400)',
  },
  allowed_estimates: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Story points tasks may use, e.g. [1, 2, 3, 5, 8]' },
  stale_claim_hours: {
    type: ['number', 'null'],
    description: 'Flag in_progress tasks with no activity for this many hours (default 24; 0 turns it off). The claim is kept.',
  },
  repo_path: {
    type: ['string', 'null'],
    description:
      'Absolute path of the project\'s git checkout, read-only. Must be a git repo, inside the folder the server can see (KANBAN_REPOS in Docker). Enables the repo-aware checks.',
  },
  base_branch: { type: ['string', 'null'], description: 'Branch work merges into (default: main, then master)' },
  protected_paths: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'e.g. "tests/golden/**"' },
        unlock_label: { type: 'string', description: 'e.g. "golden-change"' },
      },
      required: ['glob'],
    },
    description: 'Files agents must not change unless the task has the unlocking label. Touching one is flagged on submit.',
  },
  reference_patterns: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: {
        regex: { type: 'string', description: 'e.g. "C-[A-Z]+-\\d+"' },
        source: { type: 'string', description: 'The defining doc, e.g. "docs/auth.md"' },
      },
      required: ['regex', 'source'],
    },
    description: 'Rule IDs cited in tasks and their source docs (needs repo_path). Briefings point each ID at its line and flag dangling ones.',
  },
  glossary: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'e.g. "Hero"' },
        avoid: { type: 'array', items: { type: 'string' }, description: 'e.g. ["unit"]' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Fine despite an avoided word, e.g. ["unit test"]' },
      },
      required: ['term', 'avoid'],
    },
    description: 'The project\'s vocabulary. Avoided words in task text and handoffs come back as warnings (never errors).',
  },
  brief_sections: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        match: {
          type: 'object',
          properties: { labels: { type: 'array', items: { type: 'string' } }, epic: { type: 'string' }, type: { type: 'array', items: { type: 'string' } } },
          description: 'Every condition given must hold (any of the labels)',
        },
        body: { type: 'string', description: 'Markdown' },
      },
      required: ['match', 'body'],
    },
    description: 'Standing rules for some tasks only, appended to agent_brief in the briefings of tasks that match.',
  },
};

const verbose = { type: 'boolean', description: 'Return the full task, not the compact result' };

// Write tools answer with what changed and what needs attention, not an echo of the task (verbose: true
// returns the full task). Each message appears once.
const TRACKED = [
  'title', 'description', 'status', 'priority', 'type', 'assignee', 'labels', 'parent', 'milestone', 'epic', 'sprint',
  'estimate', 'criteria', 'context', 'scope', 'external_id', 'prerequisites', 'depends_on', 'checkpoint', 'handoff', 'needs_review',
];
function compact(task, before = null, { submit = false } = {}) {
  const warnings = submit ? task.handoff?.warnings : task.warnings;
  const violations = submit ? task.handoff?.violations?.map((v) => v.message) : undefined;
  const done = task.criteria?.filter((c) => c.done).length;
  return {
    key: task.key,
    status: task.status,
    ...(before ? { changed: TRACKED.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(task[f])) } : { title: task.title }),
    ...(task.criteria?.length && { criteria: `${done}/${task.criteria.length} done` }),
    ...(warnings?.length && { warnings }),
    ...(violations?.length && { violations }),
    ...(task.unchecked_criteria && { unchecked_criteria: task.unchecked_criteria }),
    ...(task.awaiting_director && { awaiting_director: task.awaiting_director }),
    ...(task.missing_fields && { missing_fields: task.missing_fields }),
    ...(task.stale_context && { stale_context: task.stale_context.map((c) => c.path) }),
  };
}
// What list_tasks returns by default: enough to choose from, with the details one get_task away.
function summary(k, t) {
  const files = t.attachment_count ? k.attachmentsFor(t.id).map(({ id, filename, mime }) => ({ id, filename, mime })) : [];
  return {
    key: t.key,
    title: t.title,
    status: t.status,
    type: t.type,
    priority: t.priority,
    ...(t.labels.length && { labels: t.labels }),
    ...(t.epic && { epic: t.epic }),
    ...(t.sprint && { sprint: t.sprint }),
    ...(t.estimate !== null && { estimate: t.estimate }),
    ...(t.assignee && { assignee: t.assignee }),
    ...(t.blocked && { blocked: true }),
    ...(t.waiting_on_director && { waiting_on_director: true }),
    ...(t.missing_fields && { missing_fields: t.missing_fields }),
    ...(files.length && { attachments: files }),
  };
}

// The task as stored before a write, to say what the write changed.
const snapshot = (k, ref) => {
  try {
    return k.formatTask(k.taskRow(ref));
  } catch {
    return null;
  }
};
// Runs a write on one task and answers compactly unless verbose.
const write = (fn, opts) => async (k, a, actor) => {
  const before = snapshot(k, a.task);
  const after = await fn(k, a, actor);
  return a.verbose ? after : compact(after, before, opts);
};

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const TASK_KEYS = Object.keys(taskFields);

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List projects (boards) with task counts per status. Settings are in get_board\'s project and in briefings.',
    inputSchema: schema({}),
    run: (k) => k.listProjects().map(({ key, name, description, task_counts }) => ({ key, name, description, task_counts })),
  },
  {
    name: 'create_project',
    description: 'Create a new project (board). The key prefixes every task key.',
    inputSchema: schema(
      {
        key: str('2-10 chars, e.g. "APP"'),
        name: str('Display name'),
        description: str('Optional'),
        agent_brief: str('Markdown conventions every agent gets when it claims a task'),
        ...projectSettings,
      },
      ['key'],
    ),
    run: (k, a, actor) => k.createProject(a, actor),
  },
  {
    name: 'import_tasks',
    description:
      'Sync tasks from a repo\'s backlog doc by external_id: existing tasks get the fields you pass, new ones are created (type "epic" makes epics). ' +
      'epic, parent and depends_on may name items by external_id. All or nothing; returns created, updated, unchanged. Omit status to keep agents\' progress.',
    inputSchema: schema(
      {
        project,
        tasks: {
          type: 'array',
          items: schema({ external_id: str('Required: the stable outside ID'), ...seeCreateTask, type: { type: 'string', enum: TYPES } }, ['external_id']),
          minItems: 1,
        },
      },
      ['project', 'tasks'],
    ),
    run: (k, a, actor) => k.importTasks(a.project, a.tasks, actor, { role: 'agent' }),
  },
  {
    name: 'export_markdown',
    description:
      'A read-only Markdown snapshot of the project (epics, then tasks with status, priority, estimate, dependencies, criteria, description) for a repo to commit instead of a hand-kept backlog.',
    inputSchema: schema({ project }, ['project']),
    run: (k, a) => ({ [CONTENT]: [{ type: 'text', text: k.exportMarkdown(a.project) }] }),
  },
  {
    name: 'get_board',
    description: 'Get a project board: every task grouped into columns (backlog, todo, in_progress, review, done).',
    inputSchema: schema({ project }, ['project']),
    run: (k, a) => k.getBoard(a.project),
  },
  {
    name: 'list_tasks',
    description:
      'Search tasks. Filters combine with AND; list filters take comma-separated values (label: all must match). ' +
      'Returns summaries: key, title, status, type, priority, and when set labels, epic, sprint, estimate, assignee, blocked, waiting_on_director, missing_fields, attachments [{id, filename, mime}].',
    inputSchema: schema({
      project,
      status: str(STATUSES.join(', ')),
      assignee: { type: 'string' },
      label: { type: 'string' },
      type: { type: 'string' },
      priority: { type: 'string' },
      milestone: str('Name or id, or "none"'),
      epic: str('Key or title, or "none"'),
      sprint: str('Name or id, "active", or "none"'),
      q: str('Text in title or description, or an exact external_id'),
      external_id: { type: 'string' },
      unassigned: { type: 'boolean' },
      blocked: { type: 'boolean', description: 'true: only blocked; false: only unblocked' },
      missing_fields: { type: 'boolean', description: 'Only tasks lacking a required field or an allowed estimate' },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      full: { type: 'boolean', description: 'Whole tasks, not summaries' },
    }),
    run: (k, a) => (a.full ? k.listTasks(a) : k.listTasks(a).map((t) => summary(k, t))),
  },
  {
    name: 'get_task',
    description:
      'Full task details: description, criteria, questions, dependencies, subtasks, comments, history. upstream is what each direct dependency handed over (summary, files, commit, review): build on it. ' +
      'With repo_path, repo {path, base_branch, head} says where to work; protected_paths lists files you may not change unless unlocked.',
    inputSchema: schema({ task, activity: { type: 'boolean', description: 'Include the activity log' } }, ['task']),
    run: async (k, a) => {
      const { activity, ...detail } = await k.getTask(a.task);
      return a.activity ? { ...detail, activity } : detail;
    },
  },
  {
    name: 'create_task',
    description:
      'Create a task (defaults: backlog, medium, task; status "todo" makes it ready for agents). A project\'s required_fields and allowed_estimates (see get_board\'s project) gate todo: ' +
      'a backlog task may lack them (missing_fields plus a warning; don\'t invent placeholders), creating in todo without them is a 400. ' +
      'With repo_path, warnings also flag a rule ID its source doc lacks, a context path missing on the base branch, and a scope reaching a protected path.',
    inputSchema: schema({ project, ...taskFields, extract_criteria: extractFlag, verbose }, ['project', 'title']),
    run: async (k, a, actor) => {
      const task = await k.createTask(a, actor);
      return a.verbose ? task : compact(task);
    },
  },
  {
    name: 'create_tasks',
    description:
      'Create many tasks atomically. Inside the batch, parent/depends_on may reference earlier items by index as "#0", "#1", ... ' +
      'Every item is checked: if any are invalid nothing is created and one error names them all, grouped by message ("tasks[1], tasks[2]: ...").',
    inputSchema: schema(
      {
        tasks: {
          type: 'array',
          items: schema({ project: str('Project key, e.g. "APP". Required unless parent is given.'), ...seeCreateTask, extract_criteria: { type: 'boolean' } }, ['title']),
          minItems: 1,
        },
        verbose,
      },
      ['tasks'],
    ),
    run: async (k, a, actor) => {
      const tasks = await k.createTasks(a.tasks, actor);
      return a.verbose ? tasks : tasks.map((t) => compact(t));
    },
  },
  {
    name: 'update_task',
    description:
      'Update task fields; only those you pass change (depends_on replaces the list). extract_criteria: true moves a "- [ ]" description checklist into criteria. ' +
      'Director only (403): Director criteria and their evidence, unlock labels, needs_review, and assigning a task waiting on the Director to anyone but its holder.',
    inputSchema: schema({ task, agent, ...seeCreateTask, extract_criteria: extractFlag, verbose }, ['task']),
    run: write((k, a, actor) => k.updateTask(a.task, pick(a, [...TASK_KEYS, 'extract_criteria']), a.agent ?? actor, { role: 'agent' })),
  },
  {
    name: 'move_task',
    description:
      'Move a task to a column, optionally at a position (0 = top); a position among other priorities adjusts its priority (to reprioritize, prefer update_task). ' +
      'For agents each status has one door: in_progress means claim_task, review means submit_for_review (409 here), done is yours once your criteria are ticked (409), unless the Director must check it (403 says why). ' +
      'Backlog <-> todo is open; another agent\'s task can\'t change column (403).',
    inputSchema: schema({ task, agent, status: taskFields.status, index: { type: 'integer', minimum: 0 } }, ['task', 'status']),
    run: (k, a, actor) => k.moveTask(a.task, a, a.agent ?? actor),
  },
  {
    name: 'claim_task',
    description:
      'Claim a specific task: assigns it to you and moves it to in_progress. Fails (409) if claimed by someone else, done, blocked by unfinished dependencies or unticked prerequisites (the human\'s setup steps, named in the error), or waiting on the Director. A backlog task lacking required_fields is a 400. Returns the full briefing (see claim_next_task).',
    inputSchema: schema({ task, agent, force: { type: 'boolean', description: 'Director only (agents get 403). Ask the Director instead of forcing.' } }, ['task']),
    run: (k, a, actor) => k.claimTask(a.task, a.agent ?? actor, { force: a.force === true }),
  },
  {
    name: 'claim_next_task',
    description:
      'Claim the most important available task, atomically. Order: a task you hold whose question was answered since you last acted (resumed: true; not with new_only), then your rework, ' +
      'then the top unblocked To Do card (priority, then board order) that isn\'t waiting on the Director and is unassigned or pre-assigned to you. ' +
      'Nothing available: {task: null, reasons: [{key, title, why}]}, your parked tasks first, then why each of the top 5 To Do cards isn\'t yours; report that to the human instead of guessing. ' +
      'held: your other in_progress tasks; claim_task one to resume it. ' +
      'The task is a full briefing: description, criteria, context, comments (review feedback), questions and answers, attachments, upstream (what its dependencies handed over), ' +
      'repo {path, base_branch, head}, protected_paths (don\'t touch unless unlocked), stale_context, missing_context and dangling_references (these need the project\'s repo_path), decisions and agent_brief. Read all of it before starting.',
    inputSchema: schema(
      {
        project,
        agent,
        milestone: str('Only tasks in this milestone (name or id)'),
        epic: str('Only tasks in this epic (key or title)'),
        sprint: str('Only tasks in this sprint (name, id, or "active")'),
        labels: strList('Only tasks with any of these labels'),
        types: strList('Only these types'),
        new_only: { type: 'boolean', description: 'Don\'t resume an answered task; claim new work' },
      },
      ['project'],
    ),
    run: (k, a, actor) => k.claimNextResponse(a.project, a.agent ?? actor, a),
  },
  {
    name: 'release_task',
    description:
      'Give a task back: unassigns you. An in_progress task returns to todo unless you pass a status (backlog or todo; review and done have their own doors), ' +
      'or to backlog (with a warning) if it lacks a required field. Only the holder may release a task. ' +
      'Stopping partway? Pass checkpoint: a resume note (what\'s done, what\'s next, the branch) that the next agent sees first in its briefing.',
    inputSchema: schema(
      {
        task,
        agent,
        status: taskFields.status,
        checkpoint: str('Markdown resume note: what is done, what is next, branch/commit. Replaces any earlier one; "" clears it. Submitting also clears it.'),
        force: { type: 'boolean', description: 'Free an abandoned claim' },
        verbose,
      },
      ['task'],
    ),
    run: write((k, a, actor) => k.releaseTask(a.task, a.agent ?? actor, { status: a.status, checkpoint: a.checkpoint, force: a.force })),
  },
  {
    name: 'recheck_context',
    description:
      'After re-reading the context docs flagged in stale_context (changed since the task was written), clear the warning. If a change contradicts the task, ask_director instead. Holder only.',
    inputSchema: schema({ task, agent, verbose }, ['task']),
    run: write((k, a, actor) => k.recheckContext(a.task, a.agent ?? actor)),
  },
  {
    name: 'check_criteria',
    description:
      'Tick off acceptance criteria as you meet them (or untick with done: false), with evidence of how you verified each: ' +
      'a test name, a command and its output, or file:line. Director items (owner: human) can only be ticked by the human (403). ' +
      'Only the task\'s holder may tick: another agent\'s task gets 403 naming the holder.',
    inputSchema: schema(
      {
        task,
        agent,
        items: {
          type: 'array',
          items: {
            oneOf: [
              { type: ['integer', 'string'] },
              {
                type: 'object',
                properties: {
                  item: { type: ['integer', 'string'], description: '0-based index or exact text' },
                  evidence: { type: 'string', description: 'How you verified it' },
                },
                required: ['item'],
              },
            ],
          },
          description: '0-based indexes or exact criterion texts, or {item, evidence} objects',
        },
        evidence: str('Evidence for every listed item that has none of its own'),
        done: { type: 'boolean', description: 'Default true' },
        verbose,
      },
      ['task', 'items'],
    ),
    run: write((k, a, actor) => k.checkCriteria(a.task, a, a.agent ?? actor, { role: 'agent' })),
  },
  {
    name: 'submit_for_review',
    description:
      'Moves it to review for the Director, with a handoff. Only when move_task to done is refused or a criterion can\'t be met. Tick criteria with check_criteria (with evidence) first. ' +
      'The result lists unchecked_criteria (yours), awaiting_director (the human\'s) and warnings: a required check missing or failed, files that don\'t match the diff, a protected path touched, a file outside the scope; each says what to do. ' +
      'Only the holder may submit (409 unclaimed, 403 another agent\'s). With repo_path, a commit the repo lacks (or, with no commit, a missing branch) is a 409 and nothing is saved.',
    inputSchema: schema(
      {
        task,
        agent,
        summary: str('Markdown: what you changed and why, and anything the reviewer should know (trade-offs, follow-ups)'),
        branch: str('Git branch with the work'),
        commit: str('Commit SHA. With repo_path it must exist in that repo (409 otherwise); working in a clone the board can\'t see, leave it out.'),
        files: strList('Files you changed. With repo_path and a commit/branch, leave it out to take it from the git diff; if you list them, the diff is compared.'),
        verify: str('Markdown: exact steps to see it working (page to open, command to run, what to look for)'),
        media: strList(
          'Screenshots, clips or logs. "repo:<path>" attaches a file from the project repo (needs repo_path; path relative to its top; images, video, .txt/.log/.json up to 20 MB). ' +
            'Or attachment URLs from POST /api/tasks/:key/attachments?filename=NAME (raw file body, its Content-Type, X-Agent header), or http(s) URLs. Other local paths are stored as text and can\'t be opened.',
        ),
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The check name from your briefing\'s "checks"' },
              passed: { type: 'boolean' },
              output_tail: { type: 'string', description: 'The last lines of its output (kept to 4,000 characters)' },
            },
            required: ['name', 'passed'],
          },
          description: 'Results of the project checks listed in your briefing. Run them yourself; missing or failed required ones come back as warnings.',
        },
        verbose,
      },
      ['task', 'summary'],
    ),
    run: write((k, a, actor) => k.submitForReview(a.task, a, a.agent ?? actor), { submit: true }),
  },
  {
    name: 'ask_director',
    description:
      'Ask the human (the Director) when docs disagree, a rule is ambiguous, or a choice is theirs. Give options and a recommendation so they can answer in one click. ' +
      'A blocking question (the default) parks the task: nobody else can claim it, you keep the claim (the response\'s parked says so), and once it\'s answered claim_next_task hands it back with the answer in questions and comments. ' +
      'Don\'t guess; do other work meanwhile. Only on a task you hold or an unassigned one (409 on done tasks and epics, 403 on another agent\'s). Also how to propose a change to project settings.',
    inputSchema: schema(
      {
        task,
        agent,
        question: str('Markdown: what you need decided, with the conflicting sources (file:line) and what depends on it'),
        options: strList('The choices, e.g. ["Keep sessions for 30 days (security.md)", "Use 7 days (product.md)"]'),
        recommendation: str('Which option you recommend and why'),
        blocking: { type: 'boolean', description: 'Default true: the task waits for the answer. false for an FYI you can proceed without' },
      },
      ['task', 'question'],
    ),
    run: (k, a, actor) => k.askDirector(a.task, a, a.agent ?? actor),
  },
  {
    name: 'list_decisions',
    description:
      'The Director\'s recorded rulings (D-001, ...), newest first. Check them before asking a question that may be settled; briefings include the ones tagged with the task\'s labels or epic.',
    inputSchema: schema({ project, tag: str('Only decisions with this tag (comma-separate several)'), q: str('Text search') }, ['project']),
    run: (k, a) => k.listDecisions(a.project, a),
  },
  {
    name: 'get_decision',
    description: 'One Decision by id ("D-007", or 7): the ruling, its rationale, date, tags and the task it came from.',
    inputSchema: schema({ project, id: { type: ['string', 'integer'], description: 'e.g. "D-007"' } }, ['project', 'id']),
    run: (k, a) => k.getDecision(a.project, a.id),
  },
  {
    name: 'get_review_queue',
    description: 'Tasks waiting in review, each with its handoff, criteria, attachments and review history.',
    inputSchema: schema({ project }, ['project']),
    run: (k, a) => k.getReviewQueue(a.project),
  },
  {
    name: 'get_attachment',
    description:
      'View an attachment (a screenshot, a clip, a log) by id. Images come back as images you can see; get ids from a task\'s "attachments".',
    inputSchema: schema({ id: { type: ['integer', 'string'], description: 'Attachment id' } }, ['id']),
    run: (k, a) => attachmentContent(k.getAttachment(a.id)),
  },
  {
    name: 'list_epics',
    description: 'List a project\'s epics (large bodies of work that group tasks) with progress.',
    inputSchema: schema({ project }, ['project']),
    run: (k, a) => k.listEpics(a.project),
  },
  {
    name: 'create_epic',
    description:
      'Create an epic: a large feature or theme grouping tasks. Epics are never worked directly; add tasks with their "epic" field or the tasks list here.',
    inputSchema: schema(
      {
        project,
        title: str('Short name of the theme, e.g. "Checkout"'),
        description: str('Markdown: the outcome and scope of the epic'),
        priority: taskFields.priority,
        labels: taskFields.labels,
        tasks: strList('Existing task keys to put in this epic'),
        verbose,
      },
      ['project', 'title'],
    ),
    run: async (k, a, actor) => {
      const epic = await k.createEpic(a.project, a, actor, { role: 'agent' });
      return a.verbose ? epic : { key: epic.key, status: epic.status, title: epic.title, ...(epic.warnings?.length && { warnings: epic.warnings }) };
    },
  },
  {
    name: 'get_plan',
    description:
      'The sprint plan: every sprint (active, planned, completed) with its goal, dates, progress, points and tasks, plus unscheduled open tasks and the epics.',
    inputSchema: schema({ project }, ['project']),
    run: (k, a) => k.getPlan(a.project),
  },
  {
    name: 'list_sprints',
    description: 'List sprints with progress and story points (active first, then planned in order, then completed).',
    inputSchema: schema({ project, status: { type: 'string', enum: SPRINT_STATUSES } }, ['project']),
    run: (k, a) => k.listSprints(a.project, a),
  },
  {
    name: 'create_sprint',
    description:
      'Create a sprint: a batch of tasks to build and review together, with a goal saying why they belong together. Created "planned", in sequence; name defaults to "Sprint N".',
    inputSchema: schema(
      {
        project,
        name: str('Optional; defaults to "Sprint N"'),
        goal: str('Markdown: what this sprint delivers and why these tasks are grouped'),
        start_date: str('YYYY-MM-DD'),
        end_date: str('YYYY-MM-DD'),
        tasks: strList('Task keys to schedule into it'),
      },
      ['project'],
    ),
    run: (k, a, actor) => k.createSprint(a.project, a, actor),
  },
  {
    name: 'update_sprint',
    description:
      'Edit a sprint, add/remove tasks, or change status: "active" starts it (only one at a time), "completed" finishes it and moves unfinished tasks to carry_over_to (default: the next planned sprint).',
    inputSchema: schema(
      {
        sprint: str('Sprint name or id, or "active"'),
        project,
        name: str('New name'),
        goal: str('Markdown'),
        start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        end_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        status: { type: 'string', enum: SPRINT_STATUSES },
        carry_over_to: { type: ['string', 'null'], description: 'When completing: sprint for unfinished tasks, or null to unschedule them' },
        add_tasks: strList('Task keys to add'),
        remove_tasks: strList('Task keys to remove (they become unscheduled)'),
      },
      ['sprint'],
    ),
    run: (k, a, actor) => k.updateSprint(a.sprint, a, actor),
  },
  {
    name: 'list_milestones',
    description: 'List a project\'s milestones with progress (open first, then by due date).',
    inputSchema: schema({ project, status: { type: 'string', enum: MILESTONE_STATUSES } }, ['project']),
    run: (k, a) => k.listMilestones(a.project, a),
  },
  {
    name: 'get_milestone',
    description: 'Get a milestone with its progress and all its tasks.',
    inputSchema: schema({ milestone: str('Milestone name or id'), project }, ['milestone']),
    run: (k, a) => k.getMilestone(a.milestone, a.project),
  },
  {
    name: 'create_milestone',
    description:
      'Create a milestone (a goal or release that groups tasks), optionally attaching existing tasks. Attach new tasks later with the "milestone" field of create_task/update_task.',
    inputSchema: schema(
      {
        project,
        name: str('Unique within the project, e.g. "Vertical slice"'),
        description: str('Markdown: the goal and what "done" means for this milestone'),
        due_date: str('YYYY-MM-DD'),
        tasks: strList('Existing task keys to attach'),
      },
      ['project', 'name'],
    ),
    run: (k, a, actor) => k.createMilestone(a.project, a, actor),
  },
  {
    name: 'update_milestone',
    description: 'Rename, re-describe, reschedule, close/reopen a milestone, or attach more tasks (add_tasks).',
    inputSchema: schema(
      {
        milestone: str('Milestone name or id'),
        project,
        name: str('New name'),
        description: str('Markdown'),
        due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear' },
        status: { type: 'string', enum: MILESTONE_STATUSES },
        add_tasks: strList('Task keys to attach'),
      },
      ['milestone'],
    ),
    run: (k, a, actor) => k.updateMilestone(a.milestone, a, actor),
  },
  {
    name: 'add_comment',
    description:
      'Add a Markdown comment to a task: progress notes, findings, or a summary of what changed (questions for the human go through ask_director). ' +
      'checkpoint: true also saves it as the task\'s resume note, shown first in the next briefing.',
    inputSchema: schema(
      { task, agent, body: str('Markdown comment'), checkpoint: { type: 'boolean', description: 'Also make this the resume note (replaces the previous one)' } },
      ['task', 'body'],
    ),
    run: (k, a, actor) => k.addComment(a.task, a, a.agent ?? actor),
  },
  {
    name: 'list_activity',
    description: 'Recent activity (newest first). Use "after" with the last seen id to poll for changes.',
    inputSchema: schema({
      project,
      task,
      actor: str('Only actions by this actor'),
      after: { type: 'integer', description: 'Only entries with id greater than this' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    }),
    run: (k, a) => k.listActivity(a),
  },
];

function attachmentContent(file) {
  const meta = { id: file.id, task: file.task, filename: file.filename, mime: file.mime, size: file.size, url: `/api/attachments/${file.id}` };
  if (file.mime.startsWith('image/') && file.size <= MAX_INLINE_IMAGE_BYTES) {
    return {
      [CONTENT]: [
        { type: 'text', text: JSON.stringify(meta) },
        { type: 'image', data: Buffer.from(file.data).toString('base64'), mimeType: file.mime },
      ],
    };
  }
  if (file.mime.startsWith('text/') || file.mime === 'application/json') {
    return { [CONTENT]: [{ type: 'text', text: `${JSON.stringify(meta)}\n\n${Buffer.from(file.data).toString('utf8')}` }] };
  }
  return { ...meta, note: 'Not viewable inline; download it from url (prefix the board base URL).' };
}

// Claude Code shows about 2,000 characters of these; a test holds them to that. Rules that change what an agent does
// come first; the catalogue lives in the tool descriptions and the guide.
const INSTRUCTIONS = `AI Kanban: a task board shared by AI agents and their human, the Director.
Loop: claim_next_task (an answered task you hold comes back first; held lists the rest) -> read the whole briefing: agent_brief, checkpoint, description, criteria, context files, comments (review feedback), upstream -> work, with add_comment on progress -> check_criteria with evidence (test, command output, file:line) -> run the briefing's checks -> add_comment a wrap-up, then move_task to done. Needs the Director (needs_review, Director criteria, an unmeetable criterion)? submit_for_review (summary, commit, files, verify steps, checks). Rework (sent back by review) comes first: address every point.
Each status has one door: in_progress by claiming, review by submit_for_review, done by your move_task. Only a task's holder ticks, submits or moves it; subagents on this connection pass agent: "<name>".
You run sprints: start the next planned one if none is active; complete it when done.
Director only (403; propose changes with ask_director): review verdicts, "human" criteria, prerequisites, project settings, unlock labels, needs_review, forced claims.
Stay inside the task's scope and never touch protected_paths unless the briefing says unlocked: true.
stale_context lists context docs changed since the task was written: read those commits, then recheck_context. dangling_references (a rule ID its doc lacks) or missing_context that no dependency creates: ask_director.
When docs disagree or a choice is the Director's, ask_director with options and a recommendation. A blocking question parks the task, but you keep the claim: do other work, and claim_next_task hands it back once answered. Follow recorded decisions (list_decisions).
Can't finish? add_comment why, then release_task with a checkpoint (what's done, what's next, branch). Follow-up work: create_task (lands in backlog).
Warnings (glossary, required fields, planning) never block: fix them and move on.
Details: GET /api/guide (HTTP, planning).`;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg, kanban, actor) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid JSON-RPC request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ai-kanban', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const result = await tool.run(kanban, msg.params.arguments ?? {}, actor);
        return reply({ content: result?.[CONTENT] ?? [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        return reply({ content: [{ type: 'text', text: `Error (${err.status}): ${err.message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// Returns [httpStatus, body|null].
export async function handleMcp(body, kanban, actor) {
  if (Array.isArray(body)) {
    const responses = [];
    for (const m of body) responses.push(await handleMessage(m, kanban, actor));
    const replies = responses.filter(Boolean);
    return replies.length ? [200, replies] : [202, null];
  }
  const response = await handleMessage(body, kanban, actor);
  return response ? [200, response] : [202, null];
}
