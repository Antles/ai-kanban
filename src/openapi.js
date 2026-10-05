import {
  STATUSES,
  PRIORITIES,
  TYPES,
  MILESTONE_STATUSES,
  SPRINT_STATUSES,
  REVIEW_VERDICTS,
  ATTACHMENT_TYPES,
  CRITERION_OWNERS,
  REQUIRABLE_FIELDS,
} from './service.js';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const errors = {
  400: json(ref('Error'), 'Invalid input'),
  404: json(ref('Error'), 'Not found'),
  409: json(ref('Error'), 'Conflict (already claimed, blocked, or exists)'),
};
const pathParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
const queryParam = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', schema, description });
const taskRef = pathParam('ref', 'Task key like GAME-12, or numeric id');
// Acting as a named agent: subagents that share one X-Agent header pass the name they claimed with.
const actingAgent = { agent: { type: 'string', description: 'Act as this agent; defaults to the X-Agent header' } };
const holderOnly = { 403: json(ref('Error'), 'Another agent holds the task (the message names it)') };
const projectKey = pathParam('key', 'Project key like GAME');

const taskInputProps = {
  title: { type: 'string', maxLength: 500 },
  description: { type: 'string', description: 'Markdown' },
  status: {
    type: 'string',
    enum: STATUSES,
    description:
      'Agents change status only through its door: in_progress by claiming (409), review by submit (409), done by its holder once the criteria are ticked (403 when needs_review or Director criteria are open). ' +
      'Never on a task another agent holds (403). Backlog and todo are open; agents create (or import) tasks only there.',
  },
  priority: { type: 'string', enum: [...PRIORITIES].reverse(), description: 'Columns sort by priority, highest first' },
  type: { type: 'string', enum: TYPES },
  assignee: {
    type: 'string',
    nullable: true,
    description: "null to unassign. Agents may change it only on their own or unassigned tasks (403 naming the holder otherwise).",
  },
  labels: { type: 'array', items: { type: 'string' } },
  parent: { type: 'string', nullable: true, description: 'Parent task key' },
  milestone: { type: 'string', nullable: true, description: 'Milestone name or id (same project); null to detach' },
  epic: { type: 'string', nullable: true, description: 'Epic key or exact title (same project); null to detach' },
  sprint: { type: 'string', nullable: true, description: 'Sprint name, id or "active"; null to unschedule' },
  estimate: { type: 'integer', nullable: true, minimum: 0, description: 'Story points' },
  depends_on: { type: 'array', items: { type: 'string' }, description: 'Task keys that must be done first' },
  criteria: {
    type: 'array',
    items: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/Criterion' }] },
    description:
      'Acceptance criteria. Replaces the list; plain strings keep the tick, owner and evidence of an unchanged item. ' +
      'Prefix a string with "[director] " (or pass owner "human") for an item only the human can tick',
  },
  extract_criteria: { type: 'boolean', description: 'Move the description\'s "- [ ]" checklist lines into criteria' },
  context: { type: 'array', items: { type: 'string' }, description: 'Repo paths, docs or URLs to read before starting' },
  scope: { type: 'array', items: { type: 'string' }, description: 'Globs of the files the task may change; others are flagged on submit' },
  external_id: { type: 'string', nullable: true, description: 'An ID from outside the board (e.g. "T07"), unique per project' },
  checkpoint: { type: 'string', nullable: true, description: 'Resume note (Markdown); null clears it' },
  needs_review: { type: 'boolean', description: 'Director only: the Director wants to review this task, so its holder must submit it rather than move it to done' },
  prerequisites: {
    type: 'array',
    items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } } }] },
    description: 'What the human must do before an agent starts. Unticked ones block the task. Agents may add, but not tick or remove them',
  },
};
// Optional per-project rules; a project without them behaves as before. null resets one.
const projectSettingsProps = {
  checks: {
    type: 'array',
    items: {
      type: 'object',
      required: ['name', 'command'],
      properties: {
        name: { type: 'string' },
        command: { type: 'string', description: 'What the agent runs; the server never runs it' },
        required: { type: 'boolean', default: false, description: 'Always required in a handoff' },
        required_when_paths: { type: 'array', items: { type: 'string' }, description: 'Required when a handoff file matches one of these globs' },
      },
    },
    description: 'Checks agents run before submitting and report in submit checks',
  },
  required_fields: {
    type: 'array',
    items: { type: 'string', enum: REQUIRABLE_FIELDS },
    description: 'Fields a task needs before it is ready: agents get a 400 naming them when creating in todo or moving to todo; backlog tasks may lack them (missing_fields plus a warning). The board UI is exempt',
  },
  allowed_estimates: { type: 'array', items: { type: 'integer' }, description: 'Allowed story points on create and update, e.g. [1, 2, 3, 5, 8]' },
  stale_claim_hours: { type: 'number', default: 24, description: 'Flag in_progress tasks idle this long (0 = off); the claim is kept' },
  repo_path: { type: 'string', nullable: true, description: 'Absolute path of the top of the git checkout (read-only). 400 unless it is the top of a git repo inside the folder the server can see (KANBAN_REPOS in Docker)' },
  base_branch: { type: 'string', nullable: true, description: 'Branch work merges into; default main, then master' },
  protected_paths: {
    type: 'array',
    items: {
      type: 'object',
      required: ['glob'],
      properties: { glob: { type: 'string' }, unlock_label: { type: 'string', description: 'Tasks with this label may change it' } },
    },
    description: 'Files agents must not change; flagged as violations on submit',
  },
  reference_patterns: {
    type: 'array',
    items: {
      type: 'object',
      required: ['regex', 'source'],
      properties: { regex: { type: 'string' }, source: { type: 'string', description: 'Repo path of the defining doc' } },
    },
    description: 'Rule IDs in task text and the doc that defines them (needs repo_path)',
  },
  glossary: {
    type: 'array',
    items: {
      type: 'object',
      required: ['term', 'avoid'],
      properties: { term: { type: 'string' }, avoid: { type: 'array', items: { type: 'string' } }, allow: { type: 'array', items: { type: 'string' } } },
    },
    description: 'Avoided words in task text and handoffs produce warnings (whole word, case-insensitive, never blocking)',
  },
  brief_sections: {
    type: 'array',
    items: {
      type: 'object',
      required: ['match', 'body'],
      properties: {
        title: { type: 'string' },
        match: {
          type: 'object',
          properties: { labels: { type: 'array', items: { type: 'string' } }, epic: { type: 'string' }, type: { type: 'array', items: { type: 'string', enum: TYPES } } },
          description: 'Every condition given must hold; labels match any',
        },
        body: { type: 'string', description: 'Markdown' },
      },
    },
    description: 'Appended to agent_brief in briefings of matching tasks (briefings also list brief_sections: the matched titles)',
  },
};

const handoffProps = {
  summary: { type: 'string', description: 'Markdown: what changed and why' },
  branch: { type: 'string' },
  commit: { type: 'string' },
  files: { type: 'array', items: { type: 'string' } },
  verify: { type: 'string', description: 'Markdown: steps to see it working' },
  media: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Attachment URLs, other URLs, or "repo:<path>": a file in the project repo (needs repo_path), stored as an attachment and replaced by its URL. ' +
      'Paths must stay inside the repo (400); the upload types and 20 MB limit apply (415, 413). Other local paths are stored as text.',
  },
  checks: {
    type: 'array',
    items: {
      type: 'object',
      required: ['name', 'passed'],
      properties: { name: { type: 'string' }, passed: { type: 'boolean' }, output_tail: { type: 'string', description: 'Kept to its last 4,000 characters' } },
    },
    description: 'Results of the project checks. Missing or failed required ones come back as warnings',
  },
};

export function buildOpenApi(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'AI Kanban API',
      version: '1.0.0',
      description:
        'Task board for AI agents. Identify yourself with the X-Agent header on every request. ' +
        `Read ${baseUrl}/api/guide for the recommended agent workflow.`,
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Only needed when the server sets API_KEY' } },
      parameters: {
        agent: { name: 'X-Agent', in: 'header', schema: { type: 'string' }, description: 'Your agent name (recorded as the actor)' },
        role: {
          name: 'X-Role',
          in: 'header',
          schema: { type: 'string', enum: ['director'] },
          description: 'Sent by the board UI for the human. Agents must not send it. When the server has a Director key, it has no effect without that key.',
        },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        Criterion: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            done: { type: 'boolean' },
            owner: { type: 'string', enum: CRITERION_OWNERS, description: '"human" items are the Director\'s to verify; agents get 403 ticking them' },
            evidence: { type: 'string', description: 'How it was verified: a test name, command output or file:line' },
          },
        },
        Project: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            key: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            agent_brief: { type: 'string' },
            ...projectSettingsProps,
            task_counts: { type: 'object', additionalProperties: { type: 'integer' } },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        Task: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            key: { type: 'string', example: 'GAME-12' },
            project: { type: 'string' },
            number: { type: 'integer' },
            ...taskInputProps,
            blocked: { type: 'boolean', description: 'True while any depends_on task is not done or any prerequisite is unticked' },
            blocked_by: { type: 'array', items: { type: 'string' }, description: 'Unfinished dependencies' },
            pending_prerequisites: { type: 'array', items: { type: 'string' }, description: 'Unticked prerequisites' },
            missing_fields: { type: 'array', items: { type: 'string' }, description: 'Only present when the task lacks fields its project requires; "estimate" also when its estimate is outside allowed_estimates' },
            last_activity_at: { type: 'string', format: 'date-time', description: 'Latest activity on the task' },
            stale_claim: {
              type: 'object',
              properties: { idle: { type: 'string', example: '2 days' }, since: { type: 'string', format: 'date-time' } },
              description: 'Only when in_progress with no activity for the project\'s stale_claim_hours',
            },
            criteria: { type: 'array', items: ref('Criterion') },
            handoff: {
              type: 'object',
              nullable: true,
              properties: {
                ...handoffProps,
                submitted_by: { type: 'string' },
                submitted_at: { type: 'string', format: 'date-time' },
                files_derived: { type: 'boolean', description: 'files came from the git diff' },
                diff_base: { type: 'object', properties: { ref: { type: 'string' }, sha: { type: 'string' } } },
                warnings: { type: 'array', items: { type: 'string' } },
                violations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { kind: { type: 'string', enum: ['protected_path', 'out_of_scope'] }, rule: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } },
                  },
                },
              },
            },
            rework: { type: 'boolean', description: 'Review sent it back; claim-next gives it to its agent first' },
            needs_review: { type: 'boolean', description: 'The Director wants to review it: its holder submits it instead of moving it to done' },
            checkpoint: {
              type: 'object',
              nullable: true,
              properties: { body: { type: 'string' }, by: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
              description: 'Resume note from a session that stopped partway (briefings put it before the description)',
            },
            waiting_on_director: { type: 'boolean', description: 'An unanswered blocking question; only its holder can claim it' },
            open_questions: { type: 'integer' },
            attachment_count: { type: 'integer' },
            position: { type: 'integer', description: 'Order within its column (0 = top)' },
            comment_count: { type: 'integer' },
            created_by: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            started_at: { type: 'string', format: 'date-time', nullable: true },
            completed_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        RelatedTask: {
          type: 'object',
          properties: { id: { type: 'integer' }, key: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, assignee: { type: 'string', nullable: true } },
        },
        TaskDetail: {
          allOf: [
            ref('Task'),
            {
              type: 'object',
              properties: {
                dependencies: { type: 'array', items: ref('RelatedTask') },
                dependents: { type: 'array', items: ref('RelatedTask'), description: 'Tasks waiting on this one' },
                subtasks: { type: 'array', items: ref('RelatedTask') },
                comments: { type: 'array', items: ref('Comment') },
                attachments: { type: 'array', items: ref('Attachment') },
                questions: { type: 'array', items: ref('Question'), description: 'Questions for the Director and their answers' },
                glossary_warnings: {
                  type: 'array',
                  description: 'Avoided glossary words in the title, description, criteria or handoff',
                  items: { type: 'object', properties: { term: { type: 'string' }, word: { type: 'string' }, field: { type: 'string' } } },
                },
                missing_context: {
                  type: 'array',
                  items: { type: 'string' },
                  description: "With repo_path: context paths that don't exist on the base branch",
                },
                repo: {
                  type: 'object',
                  description: 'With repo_path: where to work',
                  properties: { path: { type: 'string' }, base_branch: { type: 'string' }, head: { type: 'string', nullable: true, description: 'Head of the base branch (10-char SHA)' } },
                },
                protected_paths: {
                  type: 'array',
                  description: "The project's protected files; unlocked when this task has the unlock label",
                  items: { type: 'object', properties: { glob: { type: 'string' }, unlock_label: { type: 'string' }, unlocked: { type: 'boolean' } } },
                },
                stale_context: {
                  type: 'array',
                  description: 'With repo_path: context files changed since the task recorded its baseline (or since it was created)',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      since: { type: 'string', description: 'Baseline commit, or the creation time' },
                      commits_since: {
                        type: 'array',
                        items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' }, date: { type: 'string' } } },
                      },
                    },
                  },
                },
                references: {
                  type: 'array',
                  description: 'Rule IDs found in the task and where their source doc defines them',
                  items: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, line: { type: 'integer' }, excerpt: { type: 'string' } } },
                },
                dangling_references: {
                  type: 'array',
                  description: 'Rule IDs the source doc no longer contains',
                  items: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, source_missing: { type: 'boolean' } } },
                },
                upstream: {
                  type: 'array',
                  description: 'Only when a direct dependency has a handoff: what each one handed over',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string' },
                      title: { type: 'string' },
                      status: { type: 'string' },
                      summary: { type: 'string', description: 'Trimmed to about 1,500 characters' },
                      files: { type: 'array', items: { type: 'string' } },
                      commit: { type: 'string', nullable: true },
                      branch: { type: 'string', nullable: true },
                      review: {
                        type: 'object',
                        nullable: true,
                        properties: { verdict: { type: 'string' }, by: { type: 'string' }, at: { type: 'string' }, feedback: { type: 'string', nullable: true } },
                      },
                    },
                  },
                },
                decisions: { type: 'array', items: ref('Decision'), description: 'Briefings only: up to 10 decisions tagged with the task\'s labels or epic' },
                checks: { type: 'array', items: { type: 'object' }, description: 'Briefings only: the project checks to run and report' },
                reviews: { type: 'array', items: { type: 'object' }, description: 'Submissions and verdicts, oldest first' },
                activity: { type: 'array', items: ref('Activity') },
              },
            },
          ],
        },
        TaskCreate: {
          type: 'object',
          required: ['project', 'title'],
          properties: { project: { type: 'string' }, ...taskInputProps },
        },
        TaskPatch: { type: 'object', properties: { ...taskInputProps, ...actingAgent } },
        Question: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            task: { type: 'string' },
            status: { type: 'string', enum: ['open', 'answered'] },
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            recommendation: { type: 'string', nullable: true },
            blocking: { type: 'boolean', description: 'While open, only the task\'s holder can claim it' },
            asked_by: { type: 'string' },
            asked_at: { type: 'string', format: 'date-time' },
            answer: { type: 'string', nullable: true },
            answered_by: { type: 'string', nullable: true },
            answered_at: { type: 'string', format: 'date-time', nullable: true },
            decision: { type: 'string', nullable: true, example: 'D-003', description: 'Decision recorded from the answer' },
          },
        },
        Decision: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'D-003' },
            number: { type: 'integer' },
            project: { type: 'string' },
            title: { type: 'string' },
            decision: { type: 'string' },
            rationale: { type: 'string' },
            date: { type: 'string', format: 'date' },
            source_task: { type: 'string', nullable: true },
            tags: { type: 'array', items: { type: 'string' }, description: 'Briefings of tasks with a matching label or epic include it' },
            created_by: { type: 'string' },
          },
        },
        Attachment: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            filename: { type: 'string' },
            mime: { type: 'string', enum: ATTACHMENT_TYPES },
            size: { type: 'integer' },
            url: { type: 'string', example: '/api/attachments/7' },
            created_by: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Comment: {
          type: 'object',
          properties: { id: { type: 'integer' }, task: { type: 'string' }, author: { type: 'string' }, body: { type: 'string' }, created_at: { type: 'string' } },
        },
        Activity: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            project: { type: 'string' },
            task: { type: 'string', nullable: true },
            actor: { type: 'string' },
            action: { type: 'string', example: 'submitted', description: 'created, updated, claimed, released, commented, submitted, reviewed, criteria_checked, attached, ...' },
            detail: { type: 'object' },
            created_at: { type: 'string' },
          },
        },
        Milestone: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            project: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            due_date: { type: 'string', format: 'date', nullable: true },
            status: { type: 'string', enum: MILESTONE_STATUSES },
            task_counts: { type: 'object', additionalProperties: { type: 'integer' } },
            total: { type: 'integer' },
            done: { type: 'integer' },
            progress: { type: 'integer', description: 'Percent of tasks done' },
          },
        },
        Progress: {
          type: 'object',
          properties: {
            task_counts: { type: 'object', additionalProperties: { type: 'integer' } },
            total: { type: 'integer' },
            done: { type: 'integer' },
            percent: { type: 'integer' },
            points_total: { type: 'integer' },
            points_done: { type: 'integer' },
          },
        },
        Epic: { allOf: [ref('Task'), { type: 'object', properties: { progress: ref('Progress') } }] },
        Sprint: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            project: { type: 'string' },
            name: { type: 'string' },
            goal: { type: 'string' },
            status: { type: 'string', enum: SPRINT_STATUSES },
            start_date: { type: 'string', format: 'date', nullable: true },
            end_date: { type: 'string', format: 'date', nullable: true },
            position: { type: 'integer' },
            task_counts: { type: 'object', additionalProperties: { type: 'integer' } },
            total: { type: 'integer' },
            done: { type: 'integer' },
            percent: { type: 'integer' },
            points_total: { type: 'integer' },
            points_done: { type: 'integer' },
          },
        },
        SprintInput: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            goal: { type: 'string' },
            start_date: { type: 'string', format: 'date', nullable: true },
            end_date: { type: 'string', format: 'date', nullable: true },
          },
        },
        MilestoneInput: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            due_date: { type: 'string', format: 'date', nullable: true },
            status: { type: 'string', enum: MILESTONE_STATUSES },
          },
        },
        Board: {
          type: 'object',
          properties: {
            project: ref('Project'),
            milestones: { type: 'array', items: ref('Milestone') },
            epics: { type: 'array', items: ref('Epic') },
            sprints: { type: 'array', items: ref('Sprint') },
            next_up: { type: 'string', nullable: true, description: 'Key of the task claim-next would hand an unassigned agent' },
            next_up_reasons: { type: 'array', items: { type: 'object' }, description: 'When To Do has cards but none is claimable: why, for the top 5' },
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: { status: { type: 'string' }, name: { type: 'string' }, tasks: { type: 'array', items: ref('Task') } },
              },
            },
          },
        },
      },
    },
    security: [{}, { bearer: [] }],
    paths: {
      '/api/guide': { get: { summary: 'Agent guide (Markdown)', responses: { 200: { description: 'Markdown' } } } },
      '/api/auth': {
        get: {
          summary: 'How the server sees this request: role (agent or director) and whether the Director role needs a key',
          responses: { 200: { description: '{role, director_key_required, director_key_accepted?}' } },
        },
      },
      '/api/meta': { get: { summary: 'Allowed statuses, priorities and types', responses: { 200: json({ type: 'object' }) } } },
      '/api/projects': {
        get: { summary: 'List projects', responses: { 200: json({ type: 'array', items: ref('Project') }) } },
        post: {
          summary: 'Create project',
          requestBody: body({
            type: 'object',
            required: ['key'],
            properties: {
              key: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{1,9}$' },
              name: { type: 'string' },
              description: { type: 'string' },
              agent_brief: { type: 'string', description: 'Markdown instructions included in every claim' },
              ...projectSettingsProps,
            },
          }),
          responses: { 201: json(ref('Project'), 'Created'), ...errors },
        },
      },
      '/api/projects/{key}': {
        parameters: [projectKey],
        get: { summary: 'Get project', responses: { 200: json(ref('Project')), ...errors } },
        patch: {
          summary: 'Update project (Director only; agents get 403 and may propose changes with ask_director)',
          requestBody: body({
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' }, agent_brief: { type: 'string' }, ...projectSettingsProps },
          }),
          responses: { 200: json(ref('Project')), ...errors },
        },
        delete: { summary: 'Delete project and all its tasks (Director only)', responses: { 200: json({ type: 'object' }), ...errors } },
      },
      '/api/projects/{key}/import': {
        parameters: [projectKey],
        post: {
          summary: 'Upsert tasks (and epics) on external_id',
          description:
            'Existing tasks get the fields given; new ones are created. epic, parent and depends_on may name items by external_id. ' +
            'All or nothing. Omit status to keep agents\' progress.',
          requestBody: body({
            type: 'object',
            required: ['tasks'],
            properties: {
              tasks: { type: 'array', items: { allOf: [ref('TaskPatch'), { type: 'object', required: ['external_id'], properties: { external_id: { type: 'string' } } }] } },
            },
          }),
          responses: {
            200: json({
              type: 'object',
              properties: {
                created: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, external_id: { type: 'string' } } } },
                updated: { type: 'array', items: { type: 'object' } },
                unchanged: { type: 'array', items: { type: 'object' } },
              },
            }),
            ...errors,
          },
        },
      },
      '/api/projects/{key}/export.md': {
        parameters: [projectKey],
        get: {
          summary: 'Read-only Markdown snapshot: epics and tasks with status, criteria and dependencies (no timestamps)',
          responses: { 200: { description: 'text/markdown' }, ...errors },
        },
      },
      '/api/projects/{key}/glossary/import': {
        parameters: [projectKey],
        post: {
          summary: 'Set the glossary from CONTEXT.md-style Markdown ("**Term**:" + "_Avoid_:" lines) (Director only)',
          requestBody: body({
            type: 'object',
            properties: {
              markdown: { type: 'string', description: 'The file content' },
              path: { type: 'string', description: 'Or a file in the project repo' },
              mode: { type: 'string', enum: ['replace', 'merge'], default: 'replace' },
            },
          }),
          responses: { 200: json(ref('Project')), ...errors },
        },
      },
      '/api/projects/{key}/repo': {
        parameters: [projectKey],
        get: {
          summary: 'Check the project repo (or ?path= before saving it): ok, toplevel, head, base branch',
          parameters: [queryParam('path', 'A candidate repo_path to check instead of the saved one (Director only)')],
          responses: { 200: json({ type: 'object' }), ...errors },
        },
      },
      '/api/projects/{key}/repo/file': {
        parameters: [projectKey],
        get: {
          summary: 'A file from the project repo at the base branch (read-only, text/plain)',
          parameters: [queryParam('path', 'Repo path, e.g. docs/combat.md')],
          responses: { 200: { description: 'The file' }, ...errors },
        },
      },
      '/api/tasks/{ref}/context/recheck': {
        parameters: [taskRef],
        post: {
          summary: 'Mark the context docs re-checked: resets their baseline to the latest commit (clears stale_context)',
          description: 'Holder only: 403 on a task another agent holds.',
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: actingAgent } } } },
          responses: { 200: json(ref('TaskDetail')), ...errors, ...holderOnly },
        },
      },
      '/api/projects/{key}/board': {
        parameters: [projectKey],
        get: { summary: 'Board: all tasks grouped by status column', responses: { 200: json(ref('Board')), ...errors } },
      },
      '/api/projects/{key}/claim-next': {
        parameters: [projectKey],
        post: {
          summary: 'Atomically claim the next available task',
          description:
            'Hands back first a task you hold whose blocking question was answered since you last acted on it (resumed: true; new_only skips this). ' +
            'Your other in_progress tasks are not handed out; they are listed in held [{key, title, last_activity_at, waiting_on_director?}], with or without a task. ' +
            'Then your rework (tasks review sent back to you), then the top To Do task in board order (highest priority first, then position) ' +
            'that is unblocked, not waiting on the Director, and unassigned or pre-assigned to you. Assigns it to you and moves it to in_progress. ' +
            'The task is a full briefing (TaskDetail without activity, plus agent_brief and matching decisions). Returns {"task": null, "reasons": [...]} when nothing is available.',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({
            type: 'object',
            properties: {
              agent: { type: 'string', description: 'Defaults to X-Agent header' },
              milestone: { type: 'string', description: 'Only tasks in this milestone (name or id)' },
              epic: { type: 'string', description: 'Only tasks in this epic (key or title)' },
              sprint: { type: 'string', description: 'Only tasks in this sprint (name, id or "active")' },
              labels: { type: 'array', items: { type: 'string' }, description: 'Only tasks having any of these labels' },
              types: { type: 'array', items: { type: 'string', enum: TYPES } },
              new_only: { type: 'boolean', description: 'Don\'t resume an answered task you hold; claim new work' },
            },
          }),
          responses: {
            200: json({
              type: 'object',
              properties: {
                task: { ...ref('TaskDetail'), nullable: true },
                reasons: {
                  type: 'array',
                  description: 'Only when task is null: your tasks parked on the Director first ("yours, waiting on the Director: ..."), then why each of the top 5 To Do cards could not be claimed',
                  items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, why: { type: 'string', example: 'blocked by AS-1 (review)' } } },
                },
                held: {
                  type: 'array',
                  description: 'Your other in_progress tasks, newest activity first; omitted when you hold none. They are not handed out: claim_task one to pick it back up.',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string' },
                      title: { type: 'string' },
                      last_activity_at: { type: 'string', format: 'date-time' },
                      waiting_on_director: { type: 'boolean', description: 'Only on parked tasks' },
                    },
                  },
                },
                hint: { type: 'string', description: 'Only when the To Do column is empty' },
              },
            }),
            ...errors,
          },
        },
      },
      '/api/projects/{key}/plan': {
        parameters: [projectKey],
        get: {
          summary: 'Sprint plan: sprints with tasks, unscheduled open tasks, epics',
          responses: {
            200: json({
              type: 'object',
              properties: {
                sprints: { type: 'array', items: { allOf: [ref('Sprint'), { type: 'object', properties: { tasks: { type: 'array', items: ref('Task') } } }] } },
                unscheduled: { type: 'array', items: ref('Task') },
                epics: { type: 'array', items: ref('Epic') },
              },
            }),
            ...errors,
          },
        },
      },
      '/api/projects/{key}/epics': {
        parameters: [projectKey],
        get: { summary: 'List epics with progress', responses: { 200: json({ type: 'array', items: ref('Epic') }), ...errors } },
        post: {
          summary: 'Create epic',
          requestBody: body({
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: [...PRIORITIES].reverse() },
              tasks: { type: 'array', items: { type: 'string' }, description: 'Task keys to put in the epic' },
            },
          }),
          responses: { 201: json(ref('Epic'), 'Created'), ...errors },
        },
      },
      '/api/projects/{key}/sprints': {
        parameters: [projectKey],
        get: {
          summary: 'List sprints (active, planned in order, completed)',
          parameters: [queryParam('status', 'planned, active or completed')],
          responses: { 200: json({ type: 'array', items: ref('Sprint') }), ...errors },
        },
        post: {
          summary: 'Create sprint (planned; name defaults to "Sprint N")',
          requestBody: body({ allOf: [ref('SprintInput'), { type: 'object', properties: { tasks: { type: 'array', items: { type: 'string' } } } }] }),
          responses: { 201: json(ref('Sprint'), 'Created'), ...errors },
        },
      },
      '/api/sprints/{id}': {
        parameters: [pathParam('id', 'Sprint id')],
        get: {
          summary: 'Sprint with its tasks',
          responses: { 200: json({ allOf: [ref('Sprint'), { type: 'object', properties: { tasks: { type: 'array', items: ref('Task') } } }] }), ...errors },
        },
        patch: {
          summary: 'Update sprint, add/remove tasks, start or complete it',
          description:
            'status "active" starts it (409 if another sprint is active). status "completed" moves unfinished tasks to carry_over_to (a sprint, or null for unscheduled; default: next planned sprint) and returns carried_over / carried_to.',
          requestBody: body({
            allOf: [
              ref('SprintInput'),
              {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: SPRINT_STATUSES },
                  carry_over_to: { type: 'string', nullable: true },
                  add_tasks: { type: 'array', items: { type: 'string' } },
                  remove_tasks: { type: 'array', items: { type: 'string' } },
                },
              },
            ],
          }),
          responses: { 200: json(ref('Sprint')), ...errors },
        },
        delete: { summary: 'Delete sprint (its tasks become unscheduled)', responses: { 200: json({ type: 'object' }), ...errors } },
      },
      '/api/projects/{key}/milestones': {
        parameters: [projectKey],
        get: {
          summary: 'List milestones with progress',
          parameters: [queryParam('status', 'open or closed')],
          responses: { 200: json({ type: 'array', items: ref('Milestone') }), ...errors },
        },
        post: {
          summary: 'Create milestone',
          requestBody: body({
            allOf: [ref('MilestoneInput'), { type: 'object', required: ['name'], properties: { tasks: { type: 'array', items: { type: 'string' } } } }],
          }),
          responses: { 201: json(ref('Milestone'), 'Created'), ...errors },
        },
      },
      '/api/milestones/{id}': {
        parameters: [pathParam('id', 'Milestone id')],
        get: {
          summary: 'Milestone with its tasks',
          responses: { 200: json({ allOf: [ref('Milestone'), { type: 'object', properties: { tasks: { type: 'array', items: ref('Task') } } }] }), ...errors },
        },
        patch: {
          summary: 'Update milestone / attach tasks',
          requestBody: body({ allOf: [ref('MilestoneInput'), { type: 'object', properties: { add_tasks: { type: 'array', items: { type: 'string' } } } }] }),
          responses: { 200: json(ref('Milestone')), ...errors },
        },
        delete: { summary: 'Delete milestone (tasks are detached, not deleted)', responses: { 200: json({ type: 'object' }), ...errors } },
      },
      '/api/tasks': {
        get: {
          summary: 'List / search tasks',
          parameters: [
            queryParam('project', 'Project key'),
            queryParam('status', 'Comma-separated statuses'),
            queryParam('assignee', 'Comma-separated names'),
            queryParam('label', 'Comma-separated labels (must have all)'),
            queryParam('type', 'Comma-separated types'),
            queryParam('priority', 'Comma-separated priorities'),
            queryParam('q', 'Text search in title/description, or an exact external_id'),
            queryParam('external_id', 'Comma-separated external ids'),
            queryParam('parent', 'Parent task key'),
            queryParam('milestone', 'Milestone name or id, or "none"'),
            queryParam('epic', 'Epic key or title, or "none"'),
            queryParam('sprint', 'Sprint name or id, "active", or "none"'),
            queryParam('unassigned', 'Only unassigned', { type: 'boolean' }),
            queryParam('blocked', 'true = only blocked, false = only unblocked', { type: 'boolean' }),
            queryParam('missing_fields', 'Only tasks lacking a field the project requires, or with a disallowed estimate', { type: 'boolean' }),
            queryParam('limit', 'Max results (default 200)', { type: 'integer' }),
          ],
          responses: { 200: json({ type: 'array', items: ref('Task') }), ...errors },
        },
        post: {
          summary: 'Create task',
          description:
            'The response may carry warnings: glossary wording, required fields a backlog task still lacks, and with repo_path a cited rule ID missing from its source, ' +
            'a context path missing on the base branch, or a scope reaching a protected path. They never block.',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body(ref('TaskCreate')),
          responses: { 201: json(ref('Task'), 'Created'), ...errors },
        },
      },
      '/api/tasks/bulk': {
        post: {
          summary: 'Create many tasks atomically',
          description:
            'Within the batch, parent/depends_on can reference earlier items as "#0", "#1", ... Every item is validated; if any fail, nothing is created and one error names ' +
            'them all, grouped by message ("tasks[1], tasks[3]: ..."), with errors: [{index, status, error}].',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({ type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', items: ref('TaskCreate') } } }),
          responses: { 201: json({ type: 'array', items: ref('Task') }, 'Created'), ...errors },
        },
      },
      '/api/tasks/{ref}': {
        parameters: [taskRef],
        get: { summary: 'Task details incl. comments, dependencies, history', responses: { 200: json(ref('TaskDetail')), ...errors } },
        patch: {
          summary: 'Update task fields (only those provided)',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body(ref('TaskPatch')),
          responses: { 200: json(ref('Task')), ...errors },
        },
        delete: {
          summary: "Delete task. For agents: 403 on another agent's task, and on a task in review or done (Director only)",
          parameters: [{ $ref: '#/components/parameters/agent' }],
          responses: { 200: json({ type: 'object' }), ...errors },
        },
      },
      '/api/tasks/{ref}/move': {
        parameters: [taskRef],
        post: {
          summary: 'Move to a status column and/or position (priority adjusts to fit its new neighbours)',
          description:
            'For agents each status has one door: in_progress through claim (409 here), review through submit (409), done through the ' +
            'holder\'s move once every agent criterion is ticked (409 if not). Done is 403 when the Director must check it: the task is in review ' +
            'with a handoff that flagged a problem (a failed check, a protected path or out-of-scope file: "Only the Director can accept or send back work"), marked needs_review, or has open Director criteria. A status change on a task another agent holds is 403. Backlog <-> todo is open. ' +
            'The Director (the board) may move anything.',
          parameters: [{ $ref: '#/components/parameters/agent' }, { $ref: '#/components/parameters/role' }],
          requestBody: body({
            type: 'object',
            properties: { status: { type: 'string', enum: STATUSES }, index: { type: 'integer', description: '0 = top; omit for bottom' }, ...actingAgent },
          }),
          responses: { 200: json(ref('Task')), ...errors, 403: json(ref('Error'), 'Done or a verdict is the Director\'s, or another agent holds the task') },
        },
      },
      '/api/tasks/{ref}/claim': {
        parameters: [taskRef],
        post: {
          summary: 'Claim a task (assign to you, move to in_progress)',
          description:
            '409 if claimed by someone else, already done, blocked (by dependencies: blocked_by; or by unticked prerequisites: prerequisites), or waiting on the Director. 400 for agents claiming a backlog task that lacks the project\'s required_fields. force: true overrides these checks and is Director only (403 for agents).',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({ type: 'object', properties: { agent: { type: 'string' }, force: { type: 'boolean' } } }),
          responses: { 200: json(ref('Task')), ...errors },
        },
      },
      '/api/tasks/{ref}/release': {
        parameters: [taskRef],
        post: {
          summary: 'Unassign yourself (in_progress returns to todo unless status given)',
          description:
            'Holder only: 409 when another agent holds it, unless force: true (to free an abandoned claim). status follows the move rules: in_progress and review are 409, done follows the same rules as a move, todo is 400 while a required field is missing. ' +
            'Without a status, an in_progress task that lacks a required field goes to backlog (with a warning) instead of todo.',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({
            type: 'object',
            properties: {
              agent: { type: 'string' },
              status: { type: 'string', enum: STATUSES },
              force: { type: 'boolean', description: 'Release another agent\'s claim (one it abandoned)' },
              checkpoint: { type: 'string', description: 'Resume note (what is done, what is next, branch); replaces the previous one, "" clears it. Submitting clears it too.' },
            },
          }),
          responses: { 200: json(ref('Task')), ...errors },
        },
      },
      '/api/tasks/{ref}/criteria': {
        parameters: [taskRef],
        post: {
          summary: 'Tick or untick acceptance criteria, with evidence',
          description: 'Director items (owner "human") can only be ticked with X-Role: director; agents get 403. So does a task another agent holds.',
          parameters: [{ $ref: '#/components/parameters/agent' }, { $ref: '#/components/parameters/role' }],
          requestBody: body({
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  oneOf: [
                    { type: 'integer' },
                    { type: 'string' },
                    { type: 'object', required: ['item'], properties: { item: { oneOf: [{ type: 'integer' }, { type: 'string' }] }, evidence: { type: 'string' } } },
                  ],
                },
                description: '0-based indexes or exact texts, or {item, evidence}',
              },
              evidence: { type: 'string', description: 'Evidence for listed items that have none of their own' },
              done: { type: 'boolean', default: true },
              ...actingAgent,
            },
          }),
          responses: { 200: json(ref('Task')), ...errors, 403: json(ref('Error'), 'Director criterion') },
        },
      },
      '/api/tasks/{ref}/prerequisites': {
        parameters: [taskRef],
        post: {
          summary: 'Tick or untick prerequisites (Director only: X-Role: director)',
          parameters: [{ $ref: '#/components/parameters/role' }],
          requestBody: body({
            type: 'object',
            required: ['items'],
            properties: {
              items: { type: 'array', items: { oneOf: [{ type: 'integer' }, { type: 'string' }] }, description: '0-based indexes or exact texts' },
              done: { type: 'boolean', default: true },
            },
          }),
          responses: { 200: json(ref('Task')), ...errors, 403: json(ref('Error'), 'Not the Director') },
        },
      },
      '/api/tasks/{ref}/criteria/extract': {
        parameters: [taskRef],
        post: {
          summary: 'Move the description\'s "- [ ]" checklist into criteria',
          description: 'Removes the lines (and a heading that only introduced them) from the description. 400 if there are none.',
          responses: { 200: json({ allOf: [ref('Task'), { type: 'object', properties: { extracted: { type: 'integer' } } }] }), ...errors },
        },
      },
      '/api/tasks/{ref}/submit': {
        parameters: [taskRef],
        post: {
          summary: 'Submit for review with a handoff (moves to review)',
          description:
            'The response includes unchecked_criteria (agent items not ticked), awaiting_director (Director items for the human to check) ' +
            'and warnings. Warnings never fail the submit. With repo_path: a commit the repo lacks (or, with no commit, a missing branch) is a 409 and nothing is saved; files are taken from ' +
            'the diff against the merge base when omitted (files_derived) or compared when given. Protected paths and task scope are ' +
            'checked against the files and stored as handoff.violations. Only the holder may submit: 409 on an unclaimed task, 403 on another agent\'s.',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({ type: 'object', required: ['summary'], properties: { ...handoffProps, ...actingAgent } }),
          responses: { 200: json(ref('Task')), ...errors, ...holderOnly },
        },
      },
      '/api/tasks/{ref}/review': {
        parameters: [taskRef],
        post: {
          summary: 'Review verdict: accept (→ done) or changes (→ todo, back to its agent as rework). Director only',
          description: 'Agents get 403: "Only the Director can accept or send back work (from the board). Tell the human it\'s ready."',
          parameters: [{ $ref: '#/components/parameters/role' }],
          requestBody: body({
            type: 'object',
            required: ['verdict'],
            properties: { verdict: { type: 'string', enum: REVIEW_VERDICTS }, feedback: { type: 'string', description: 'Required for changes' } },
          }),
          responses: { 200: json(ref('Task')), ...errors, 403: json(ref('Error'), 'Not the Director') },
        },
      },
      '/api/projects/{key}/inbox': {
        parameters: [projectKey],
        get: {
          summary: 'Everything waiting on the human, oldest first (the Director inbox)',
          description:
            'Items: question (open questions), review (tasks in review, with the Director\'s unticked criteria), prerequisite ' +
            '(unticked prerequisites blocking work), gate (tasks assigned to the Director that nothing blocks), stale (claims with no recent activity).',
          parameters: [queryParam('me', 'The board user\'s name: tasks assigned to it also count as gates')],
          responses: {
            200: json({
              type: 'object',
              properties: {
                count: { type: 'integer' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['question', 'review', 'prerequisite', 'gate', 'stale'] },
                      since: { type: 'string', format: 'date-time' },
                      task: { type: 'string' },
                      title: { type: 'string' },
                    },
                  },
                },
              },
            }),
            ...errors,
          },
        },
      },
      '/api/projects/{key}/review': {
        parameters: [projectKey],
        get: { summary: 'Review queue: tasks in review with handoff, attachments and review history', responses: { 200: json({ type: 'array', items: ref('TaskDetail') }), ...errors } },
      },
      '/api/tasks/{ref}/questions': {
        parameters: [taskRef],
        get: { summary: 'Questions on a task', responses: { 200: json({ type: 'array', items: ref('Question') }), ...errors } },
        post: {
          summary: 'Ask the Director (ask_director)',
          description:
            'A blocking question (default) marks the task waiting_on_director: claim-next skips it and claim returns 409 for anyone but its holder. ' +
            'Only on a task you hold or an unassigned one: 409 on done tasks and epics, 403 on a task another agent holds. ' +
            'A blocking question\'s response adds parked: {task, status, note} saying what happens to the task (the asker keeps the claim; claim-next hands it back once answered).',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({
            type: 'object',
            required: ['question'],
            properties: {
              question: { type: 'string', description: 'Markdown' },
              options: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              recommendation: { type: 'string' },
              blocking: { type: 'boolean', default: true },
              ...actingAgent,
            },
          }),
          responses: { 201: json(ref('Question'), 'Created'), ...errors },
        },
      },
      '/api/projects/{key}/questions': {
        parameters: [projectKey],
        get: {
          summary: 'Questions across the project',
          parameters: [queryParam('status', 'open or answered')],
          responses: { 200: json({ type: 'array', items: ref('Question') }), ...errors },
        },
      },
      '/api/questions/{id}/answer': {
        parameters: [pathParam('id', 'Question id')],
        post: {
          summary: 'Answer a question (Director only: X-Role: director)',
          description: 'Posts the answer as a comment on the task. record_decision also records a project Decision.',
          parameters: [{ $ref: '#/components/parameters/role' }],
          requestBody: body({
            type: 'object',
            properties: {
              option: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: 'Option index (number) or exact text' },
              answer: { type: 'string', description: 'Free text (required when no option)' },
              record_decision: { type: 'boolean' },
              decision: {
                type: 'object',
                properties: { title: { type: 'string' }, decision: { type: 'string' }, rationale: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
                description: 'Defaults: the question, the answer, the task labels and epic',
              },
            },
          }),
          responses: { 200: json(ref('Question')), ...errors, 403: json(ref('Error'), 'Not the Director') },
        },
      },
      '/api/projects/{key}/decisions': {
        parameters: [projectKey],
        get: {
          summary: 'Decisions, newest first',
          parameters: [queryParam('tag', 'Comma-separated tags'), queryParam('q', 'Text search')],
          responses: { 200: json({ type: 'array', items: ref('Decision') }), ...errors },
        },
        post: {
          summary: 'Record a decision directly (Director only)',
          parameters: [{ $ref: '#/components/parameters/role' }],
          requestBody: body({
            type: 'object',
            required: ['title', 'decision'],
            properties: {
              title: { type: 'string' },
              decision: { type: 'string' },
              rationale: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              source_task: { type: 'string' },
            },
          }),
          responses: { 201: json(ref('Decision'), 'Created'), ...errors, 403: json(ref('Error'), 'Not the Director') },
        },
      },
      '/api/projects/{key}/decisions/{id}': {
        parameters: [projectKey, pathParam('id', 'D-003, or 3')],
        get: { summary: 'One decision', responses: { 200: json(ref('Decision')), ...errors } },
      },
      '/api/tasks/{ref}/attachments': {
        parameters: [taskRef],
        get: { summary: 'List attachments', responses: { 200: json({ type: 'array', items: ref('Attachment') }), ...errors } },
        post: {
          summary: 'Upload an attachment: the raw file is the body',
          parameters: [queryParam('filename', 'File name to store')],
          requestBody: {
            required: true,
            content: Object.fromEntries(ATTACHMENT_TYPES.map((t) => [t, { schema: { type: 'string', format: 'binary' } }])),
          },
          responses: { 201: json(ref('Attachment'), 'Created'), ...errors, 413: json(ref('Error'), 'Over 20 MB'), 415: json(ref('Error'), 'Type not allowed') },
        },
      },
      '/api/attachments/{id}': {
        parameters: [pathParam('id', 'Attachment id')],
        get: { summary: 'Download (browsers can pass ?api_key= since <img> sends no headers)', responses: { 200: { description: 'The file' }, ...errors } },
        delete: {
          summary: "Delete an attachment. For agents: 403 on another agent's task, and on a task in review or done (Director only)",
          parameters: [{ $ref: '#/components/parameters/agent' }],
          responses: { 200: json({ type: 'object' }), ...errors },
        },
      },
      '/api/tasks/{ref}/comments': {
        parameters: [taskRef],
        get: { summary: 'List comments', responses: { 200: json({ type: 'array', items: ref('Comment') }), ...errors } },
        post: {
          summary: 'Add comment',
          parameters: [{ $ref: '#/components/parameters/agent' }],
          requestBody: body({
            type: 'object',
            required: ['body'],
            properties: { body: { type: 'string', description: 'Markdown' }, checkpoint: { type: 'boolean', description: 'Also save it as the resume note' }, ...actingAgent },
          }),
          responses: { 201: json(ref('Comment'), 'Created'), ...errors },
        },
      },
      '/api/activity': {
        get: {
          summary: 'Activity log, newest first',
          parameters: [
            queryParam('project', 'Project key'),
            queryParam('task', 'Task key'),
            queryParam('actor', 'Actor name'),
            queryParam('after', 'Only ids greater than this (for polling)', { type: 'integer' }),
            queryParam('limit', 'Default 50, max 500', { type: 'integer' }),
          ],
          responses: { 200: json({ type: 'array', items: ref('Activity') }) },
        },
      },
      '/api/events': {
        get: {
          summary: 'Server-Sent Events stream of changes',
          parameters: [queryParam('project', 'Only events for this project')],
          responses: { 200: { description: 'text/event-stream; events named "change" with {type, project, task, at}' } },
        },
      },
      '/mcp': { post: { summary: 'Model Context Protocol endpoint (Streamable HTTP, JSON-RPC)', responses: { 200: { description: 'JSON-RPC response' } } } },
    },
  };
}
