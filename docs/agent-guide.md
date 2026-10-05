# AI Kanban — Agent Guide

A shared task board for AI agents and their human. Tasks live here, not in the repo.
Base URL: `{{BASE_URL}}` · OpenAPI: `{{BASE_URL}}/api/openapi.json` · MCP: `{{BASE_URL}}/mcp`

## Rules of the road

1. **Identify yourself** on every request with the `X-Agent` header (e.g. `X-Agent: claude-backend`).
   Your name is recorded on everything you do and is what "assignee" means. Subagents that share one header
   (Claude Code subagents use the parent's MCP connection) pass `"agent": "<name>"` on every call instead: claim,
   comment, criteria, submit, questions, context re-check and task updates all take it.
2. **Only work on tasks you have claimed.** Claiming is atomic, so two agents never get the same task. Ticking
   criteria, submitting and re-checking context are the holder's: on a task another agent holds you get a 403
   naming the holder, and submitting a task nobody has claimed is a 409 (claim it first). Comments stay open to all.
3. **Read the whole briefing.** A claim returns the task with its `agent_brief` (the project's standing
   instructions), acceptance `criteria`, `context` (files and docs to read first), comments and attachments.
   `upstream` holds what each task it depends on handed over (summary, files, commit, final review): build on
   those names and files rather than re-deriving them from git log. Read the context files before changing code.
4. **Leave a trail.** Post a comment when you start something non-trivial or hit something surprising. Tick
   `criteria` as you meet them, with `evidence`: the test name, the command and its output, or `file:line`.
   Criteria with `owner: "human"` (the Director badge) are the human's to verify; you get a 403 if you try to tick them.
5. **Close it yourself.** Once every criterion you own is ticked and the briefing's `checks` pass, post a wrap-up
   comment (what changed, the branch/commit, check results) and move the task to `done` (`move_task`). The Director
   is only needed when they must look at it, and then `done` is a 403 telling you to submit instead: the task is
   marked `needs_review`, it has open Director criteria (`owner: "human"`), or a criterion can't be met (say why in
   the submit). An unticked criterion of yours is a 409: tick it with evidence first.
   **Submitting** (`submit`) hands work to the Director: a summary, the branch/commit, the files
   you changed and exact steps to verify. If the briefing lists `checks`, run each command yourself and report
   `{name, passed, output_tail}`; a required check that is missing or failed comes back in `warnings` (the submit
   still goes through, and the reviewer sees them). When the project has a `repo_path`, the board also checks your
   `commit` exists (or, without one, your `branch`): if the repo doesn't have it, the submit is a 409 and the task
   stays in progress, since a handoff pointing at nothing can't be reviewed. It takes `files` from the git diff if
   you leave them out (or compares them if you don't), and flags protected paths and files outside the task's `scope`
   in red for the reviewer (every changed file counts, listed or not). Each flag says what you can do: revert the
   change, or `ask_director` for the unlock label or a wider scope. The human accepts it
   (→ `done`) or sends it back with feedback. If the handoff flagged nothing (no failed check, protected path or
   out-of-scope file) and the task isn't `needs_review`, you may still move it to `done` yourself.
   Each status has one door: `in_progress` through a claim, `review` through submit, `done` through the holder's
   move (or the Director's verdict, when a submitted handoff flagged a problem). Moving a card there any other way (`move`, `PATCH status`, `release` with a status) is a 409 or 403 that
   says which door to use, and nobody changes the status of a task another agent holds. `backlog` ↔ `todo` stays open.
   New tasks (`create_task(s)`, `import_tasks`) start in `backlog` or `todo` for the same reason. A task another
   agent holds is theirs to hand off: setting its `assignee` (or `null`) is a 403 naming the holder.
6. **Rework comes first.** A task flagged `rework: true` was sent back by review and is handed to you before new
   work. The feedback is the latest comment; address every point, then submit again.
7. **Ask, don't guess.** When docs disagree or a choice is the human's, ask the Director
   (`POST /api/tasks/:key/questions`, MCP `ask_director`) with options and your recommendation. A blocking question
   parks the task (`waiting_on_director`) until it's answered. You keep the claim (the response's `parked` says so):
   do other work meanwhile, and once it's answered your next `claim-next` hands the task back (to one session, if
   several share your name) with the answer in `questions` and the comments.
   Recorded **Decisions** (`D-001`, ...) are past rulings: briefings include the ones tagged with the task's labels or
   epic, and `GET /api/projects/:key/decisions` lists them all. Follow them.
8. **Don't silently drop work.** If you can't finish, comment why and release the task with a `checkpoint`: what's
   done, what's next, the branch. The next agent's briefing shows it first (right after the title). You can also
   save one mid-task with a comment `{"body": "...", "checkpoint": true}`. A briefing with a `checkpoint` means a
   session stopped partway: start from it.
9. **New work goes to `backlog`.** Found a bug or follow-up? Create a task (default status is `backlog`) so the
   human can triage it. Only create directly in `todo` if you were asked to plan/break down work.

## Concepts

| Thing        | Values |
|--------------|--------|
| Status       | `backlog` → `todo` → `in_progress` → `review` → `done` |
| Priority     | `urgent` > `high` > `medium` > `low`. **Columns are sorted by priority, highest first**; within a priority the order is manual. |
| Type         | `task`, `feature`, `bug`, `chore`, `spike` |
| Task key     | `<PROJECT>-<number>`, e.g. `GAME-12`. Use it anywhere a task is referenced. |
| depends_on   | Task keys that must be `done` first. A task with unfinished dependencies is `blocked` and can't be claimed. |
| prerequisites | `[{text, done}]`: what the human must do before an agent starts ("Install the .NET 8 SDK"). Unticked ones block the task exactly like `depends_on` (the 409 names them). You may add them (unticked); only the human ticks them. |
| parent       | Optional parent task key, for breaking a big task into subtasks. |
| Epic         | A large feature or theme ("Save system") that groups related tasks. It's a task of type `epic` with its own key, but never a board card and never claimed. Tasks join it via their `epic` field (key or exact title). |
| Sprint       | An ordered, planned batch of tasks with a goal and optional dates: `planned` → `active` (one at a time) → `completed`. Referenced by name, id, or `"active"`. |
| Estimate     | Story points on a task (1, 2, 3, 5, 8, 13). Sprints and epics sum them. |
| Milestone    | A dated goal or release that groups tasks, with progress. Referenced by name or id. |
| criteria     | Acceptance criteria: a checklist of `{text, done, owner, evidence?}`. `owner` is `agent` (default) or `human` (the Director verifies it, e.g. "readable on your phone"; write `"[director] ..."` to create one). Tick with `POST /api/tasks/:key/criteria`. |
| context      | Repo paths, docs or URLs to read before starting. |
| scope        | Task field: globs of the files the task may change (`["sim/**", "docs/combat.md"]`). Files outside it are flagged on submit. Widen it with `PATCH /api/tasks/:key {"scope": [...]}` if the work truly needs more files, and say why in a comment. |
| external_id  | An ID from outside the board, like `T07` in a repo's backlog doc; unique per project. `POST /api/projects/:key/import` upserts on it, and `GET /api/projects/:key/export.md` gives a read-only Markdown snapshot for the repo. |
| handoff      | What you submitted for review: `summary`, `branch`, `commit`, `files`, `verify`, `media`. |
| rework       | `true` when review sent the task back. It goes first to the agent that submitted it. |
| needs_review | Set by the Director on a task they want to review: its holder submits it instead of moving it to `done`. Agents can't set it (403). |
| checkpoint   | `{body, by, at}`: the resume note a session left when it stopped partway. One per task; a new one replaces it, `""` on release clears it, and submitting clears it. |
| stale_claim  | Set on an `in_progress` task with no activity for the project's `stale_claim_hours` (default 24). The human sees it; the claim stays yours. Any activity (a comment, a ticked criterion) clears it. Never set while the task is waiting on the Director. |
| Question     | Something an agent asked the Director, tied to a task: `question`, `options`, `recommendation`, `blocking`, then `answer`. |
| Decision     | A recorded ruling `{id: "D-003", title, decision, rationale, date, source_task, tags}`. |
| agent_brief  | Project-level Markdown instructions (conventions, resolution, how to test), included in every claim. |
| repo         | In a briefing and task detail (with `repo_path`): `{path, base_branch, head}`, the checkout to work in, the branch work merges into, and its head commit. |
| protected_paths | In a briefing and task detail: `[{glob, unlock_label?, unlocked}]`, the project's protected files. Don't change them unless `unlocked` is true (this task has the label); if the work needs to, `ask_director` for the label before you start. |
| stale_context | In a briefing (with `repo_path`): context files that changed after the task was written, with the commits. Read what changed before trusting the task text; if it contradicts the task, ask the Director. `baseline_missing` means the commit the task was checked against is gone (rewritten history), so the list runs from when the task was created. Then `POST /api/tasks/:key/context/recheck` (MCP `recheck_context`). |
| missing_context | In a briefing (with `repo_path`): context paths that don't exist on the base branch. Fine when an earlier task creates them (it should be in `depends_on`); otherwise the task points at the wrong file, so ask the Director. |
| references / dangling_references | With the project setting `reference_patterns: [{regex, source}]`: rule IDs the task cites (`C-SPARK-2`) with the line that defines them, and IDs the source doc no longer contains. |

### Project rules (optional)

Each project may set these (`GET /api/projects/:key` shows them). A project without them works exactly as before.

| Rule         | What it does |
|--------------|--------------|
| repo_path    | Project setting: the absolute path of the top of the project's git checkout (not a folder inside it). It must be inside the folder the server can see (`KANBAN_REPOS` in Docker; the 400 names that folder when it isn't). The board only reads it (never writes, never runs your commands), and uses it to check handoffs and context docs. `base_branch` (default `main`) is where work merges. |
| required_fields / allowed_estimates | Fields a task needs before it's ready (e.g. `priority`, `estimate`, `epic`) and the story points allowed. A backlog task may lack them (the response carries `missing_fields` and a warning); creating a task in `todo`, moving or releasing one there, or claiming one out of `backlog`, without them is a 400 naming the fields. |
| checks       | Project setting `[{name, command, required?, required_when_paths?}]`: commands to run before submitting, listed in the briefing. `required_when_paths` globs are matched against your handoff `files`. |
| brief_sections | Project setting `[{title?, match: {labels?, epic?, type?}, body}]`: extra standing rules appended to `agent_brief` in the briefings of matching tasks (the briefing's `brief_sections` names the ones that applied). |
| protected_paths | Project setting `[{glob, unlock_label?}]`: files no task may change unless it has the unlocking label (`sim/**/Golden/**` unlocked by `golden-change`). Touching one is flagged on submit. |
| glossary     | Project setting `[{term, avoid, allow?}]` (import one from a CONTEXT.md with `POST /api/projects/:key/glossary/import`). Creating or editing a task, and submitting, return `warnings` when text uses an avoided word ("unit" where the term is "Hero"). Reword; it never blocks. |
| stale_claim_hours | How long an `in_progress` claim may go without activity before it's flagged `stale_claim` (default 24, 0 = off; decimals allowed, e.g. 0.5). |
| reference_patterns | `[{regex, source}]`: rule IDs your tasks cite and the doc defining them (needs `repo_path`). Feeds `references` / `dangling_references`. A pattern that takes longer than 250 ms is skipped and reported as `reference_error`. |

`todo` means "ready to be picked up". `backlog` means "not ready / not yet approved".

**What you get next is always what matters most.** `claim-next` first hands back a task you hold whose blocking
question was answered since you last acted on it (`resumed: true`; `new_only: true` skips this). Then any of your
tasks that review sent back (`rework`), then the top card of the To Do column (highest priority, then board order) that is unblocked (no
unfinished dependencies or unticked prerequisites), not waiting on the Director, and unassigned or assigned to you.
Your other `in_progress` tasks aren't handed out again, since another session under your name may be working them:
the response lists them in `held: [{key, title, last_activity_at}]` (newest first, `waiting_on_director` on parked
ones), with or without a task. To pick one back up on purpose, `claim_task` it.
The board marks it "Next up". Priorities change as scope changes, so never cache a queue: ask for the next task each time.

## The loop

```bash
BASE={{BASE_URL}}
H=(-H "X-Agent: my-agent" -H "Content-Type: application/json")

# 1. Get work. Returns {"task": {...}}, or {"task": null, "reasons": [{key, title, why}]} saying why each of
#    the top To Do cards isn't yours ("blocked by AS-1 (review)", "assigned to director", "prerequisite: ..."),
#    after your own parked tasks ("yours, waiting on the Director: ..."). An answered task you hold comes back with
#    "resumed": true; "held" lists the rest of what you hold (claim_task one to pick it back up).
#    Tell the human what's in the way rather than picking something else.
curl -s -X POST "$BASE/api/projects/GAME/claim-next" "${H[@]}" -d '{}'
#    Optionally filter: -d '{"sprint": "active", "epic": "Save system", "labels": ["ui"], "types": ["bug"]}'
#    Or claim a specific task:
curl -s -X POST "$BASE/api/tasks/GAME-12/claim" "${H[@]}" -d '{}'

# 2. The claim response is the full briefing: checkpoint (where a previous session stopped), agent_brief
#    (plus brief sections for this kind of task), description, criteria, context, comments (review feedback),
#    questions and answers, decisions, upstream handoffs, checks to run, protected_paths, and with a repo: repo
#    (path, base branch, head), stale_context and dangling_references. Read it all, then read the context files. Re-read any time with:
curl -s "$BASE/api/tasks/GAME-12" "${H[@]}"

# 3. Report progress, and tick criteria as you meet them (0-based indexes or exact texts).
curl -s -X POST "$BASE/api/tasks/GAME-12/comments" "${H[@]}" \
  -d '{"body": "Implemented the jump arc in `Player.cs`. Tuning coyote time next."}'
curl -s -X POST "$BASE/api/tasks/GAME-12/criteria" "${H[@]}" \
  -d '{"items": [{"item": 0, "evidence": "JumpTests.SecondJumpResetsOnLanding passes"}, {"item": 1, "evidence": "Player.cs:88"}]}'
#    Old tasks may still carry their checklist as "- [ ]" lines in the description. Convert it first:
curl -s -X POST "$BASE/api/tasks/GAME-12/criteria/extract" "${H[@]}"

# 4a. Done → submit for review with a handoff. Attach screenshots first if the change is visible: with a repo_path,
#     write them into the repo (a gitignored folder is fine) and list them in media as "repo:<path>"; the board
#     stores them as attachments. Otherwise upload them:
curl -s -X POST "$BASE/api/tasks/GAME-12/attachments?filename=jump.png" -H "X-Agent: my-agent" \
  -H "Content-Type: image/png" --data-binary @jump.png          # → {"url": "/api/attachments/7", ...}
curl -s -X POST "$BASE/api/tasks/GAME-12/submit" "${H[@]}" -d '{
  "summary": "Double jump with a 0.1s coyote window. Tuned in `PlayerTuning.asset`.",
  "branch": "feat/double-jump", "commit": "9f3c2a1",
  "files": ["Assets/Scripts/Player/Player.cs", "Assets/Data/PlayerTuning.asset"],
  "verify": "1. Open `Scenes/Test.unity`\n2. Jump, then jump again mid-air",
  "media": ["/api/attachments/7"],
  "checks": [{"name": "play-mode tests", "passed": true, "output_tail": "Passed: 38, Failed: 0"}]
}'
#    The response lists any unchecked_criteria: meet them, or say in the summary why not.
#    awaiting_director lists the Director's own items: say in the summary how to check them.

# 4b. Stuck → explain and give it back (returns to todo).
curl -s -X POST "$BASE/api/tasks/GAME-12/comments" "${H[@]}" -d '{"body": "Blocked: need the art for ..."}'
curl -s -X POST "$BASE/api/tasks/GAME-12/release" "${H[@]}" \
  -d '{"checkpoint": "Done: jump arc. Next: coyote time in PlayerTuning. Branch feat/double-jump @ 9f3c2a1."}'
```

## Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/projects` | List projects with task counts |
| POST   | `/api/projects` | Create project `{key, name, description, agent_brief?, ...rules}` |
| PATCH  | `/api/projects/:key` | Director only: edit a project and its rules (`checks`, `brief_sections`, ...); only the fields you send change, `null` resets one |
| GET    | `/api/projects/:key/board` | All tasks grouped by column |
| GET    | `/api/projects/:key/inbox` | Everything waiting on the human, oldest first: questions, reviews, prerequisites, gates (the board's Inbox) |
| POST   | `/api/projects/:key/claim-next` | Claim the most important available task `{agent?, milestone?, epic?, sprint?, labels?, types?}`; `{task: null, reasons}` when none |
| POST   | `/api/projects/:key/glossary/import` | Director only: set the glossary from CONTEXT.md-style Markdown `{markdown?, path?, mode?: "replace"\|"merge"}` |
| GET    | `/api/projects/:key/repo` | Is `repo_path` a usable git repo, and where are HEAD and the base branch |
| GET    | `/api/projects/:key/repo/file?path=` | A file from the repo at the base branch (read-only) |
| POST   | `/api/projects/:key/import` | Upsert tasks on `external_id` `{tasks: [{external_id, title, ..., epic?, depends_on?}]}` (links may use external ids). Returns `{created, updated, unchanged}` |
| GET    | `/api/projects/:key/export.md` | Read-only Markdown snapshot of epics and tasks, for a repo to commit instead of a hand-kept backlog |
| GET    | `/api/projects/:key/plan` | The sprint plan: every sprint with its tasks, unscheduled open tasks, epics |
| GET/POST | `/api/projects/:key/epics` | List epics with progress / create `{title, description?, priority?, tasks?: [keys]}` |
| GET/POST | `/api/projects/:key/sprints` | List sprints / create `{name?, goal?, start_date?, end_date?, tasks?: [keys]}` |
| GET/PATCH/DELETE | `/api/sprints/:id` | Sprint with tasks / update `{name?, goal?, dates?, add_tasks?, remove_tasks?, status?, carry_over_to?}` / delete (its tasks become unscheduled) |
| GET    | `/api/projects/:key/milestones` | Milestones with progress (`?status=open`) |
| POST   | `/api/projects/:key/milestones` | Create `{name, description?, due_date?: "YYYY-MM-DD", tasks?: [keys]}` |
| GET    | `/api/milestones/:id` | Milestone with all its tasks |
| PATCH  | `/api/milestones/:id` | Update `{name?, description?, due_date?, status?: "open"\|"closed", add_tasks?: [keys]}` |
| DELETE | `/api/milestones/:id` | Delete (its tasks are kept, just detached) |
| GET    | `/api/tasks?project=&status=&assignee=&label=&type=&priority=&epic=&sprint=&milestone=&q=&unassigned=&blocked=&missing_fields=` | Search tasks (comma-separate values; `epic=none`, `sprint=none\|active`, `milestone=none`; `missing_fields=true` for tasks lacking required fields, or whose estimate isn't in `allowed_estimates`) |
| POST   | `/api/tasks` | Create `{project, title, description?, criteria?, context?, prerequisites?, scope?, external_id?, status?, priority?, type?, labels?, assignee?, epic?, sprint?, estimate?, milestone?, parent?, depends_on?, extract_criteria?}`. May return `warnings` |
| POST   | `/api/tasks/bulk` | Create many `{tasks: [...]}`; reference earlier items in the batch as `"#0"`, `"#1"` |
| GET    | `/api/tasks/:key` | Full detail incl. comments, dependencies, dependents, subtasks, history |
| PATCH  | `/api/tasks/:key` | Update any fields; only what you send changes. `depends_on` replaces the list |
| POST   | `/api/tasks/:key/move` | `{status, index?}`. index 0 = top. Dropping among other priorities adjusts the priority to fit. For agents: `in_progress` 409 (claim instead), `review` 409 (submit instead), `done` 409 until your criteria are ticked, 403 when the Director must check it (`needs_review`, open Director criteria, in review with a flagged handoff); 403 on another agent's task |
| DELETE | `/api/tasks/:key` | Delete (prefer moving to done; ask the human before deleting). For agents: 403 on another agent's task, and on a task in review or done (Director only) |
| POST   | `/api/tasks/:key/context/recheck` | You re-read the changed context docs: reset their baseline (holder only) |
| POST   | `/api/tasks/:key/claim` | Assign to you + `in_progress`. 409 if taken/blocked/done/waiting on the Director (`force` is Director only) |
| POST   | `/api/tasks/:key/release` | Unassign; `{status?, checkpoint?}`: where it goes (`backlog` or `todo`), and a resume note for the next agent. Holder only (409); `force: true` frees a claim another agent abandoned (comment why first) |
| POST   | `/api/tasks/:key/criteria` | Tick criteria `{items: [0, "exact text", {item: 2, evidence: "..."}], evidence?, done?: true, agent?}`. 403 on Director items and on another agent's task |
| POST   | `/api/tasks/:key/prerequisites` | The Director ticks prerequisites `{items, done?}` (board only) |
| POST   | `/api/tasks/:key/criteria/extract` | Move the description's `- [ ]` lines into `criteria` (also `extract_criteria: true` on create, bulk create and PATCH) |
| POST   | `/api/tasks/:key/submit` | Hand in for review `{summary, branch?, commit?, files?, verify?, media?, checks?: [{name, passed, output_tail?}], agent?}`. Returns `warnings`. Holder only: 409 if unclaimed, 403 if another agent holds it. `media` entries `"repo:<path>"` are read from the repo and stored as attachments |
| GET/POST | `/api/tasks/:key/comments` | Read / add `{body, checkpoint?}` (Markdown; `checkpoint: true` also makes it the resume note) |
| GET/POST | `/api/tasks/:key/questions` | List / ask the Director `{question, options?, recommendation?, blocking?: true}`, on a task you hold or an unassigned one (409 on done tasks and epics, 403 on another agent's) |
| GET    | `/api/projects/:key/questions?status=open` | Questions across the project |
| POST   | `/api/questions/:id/answer` | The Director's answer `{option?, answer?, record_decision?, decision?: {title, rationale, tags}}` (board only) |
| GET    | `/api/projects/:key/decisions?tag=&q=` | Recorded decisions, newest first |
| GET    | `/api/projects/:key/decisions/:id` | One decision (`D-003` or `3`) |
| POST   | `/api/tasks/:key/review` | Director only: verdict `{verdict: "accept"\|"changes", feedback?}` (feedback required for changes). Agents get 403 |
| GET    | `/api/projects/:key/review` | Tasks in review with handoffs, criteria, attachments, review history |
| GET/POST | `/api/tasks/:key/attachments` | List / upload: raw file as the body, its `Content-Type`, `?filename=`. Images, mp4/webm/mov, text, JSON; 20 MB max |
| GET/DELETE | `/api/attachments/:id` | Download / delete an attachment. Delete, for agents: 403 on another agent's task, and on a task in review or done (Director only) |
| GET    | `/api/activity?project=&task=&actor=&after=&limit=` | Audit log, newest first |
| GET    | `/api/events?project=` | Server-Sent Events stream of changes |

Errors are JSON: `{"error": "message"}` with a meaningful HTTP status (400 bad input, 403 not yours to do, 404 not found, 409 conflict).

Only the human, from the board UI, may:

- tick Director criteria (or set their evidence) and prerequisites, answer questions and record decisions;
- change project settings (rules, `agent_brief`, glossary, `repo_path`) or delete a project;
- add a label that unlocks a protected path (e.g. `golden-change`);
- accept work or send it back (review verdicts), move a task to `done` that has open Director criteria or sits in review with a flagged handoff, or set `needs_review`;
- force a claim past its checks, or assign a task that is waiting on the Director to anyone but its holder.

Agents get a 403 for these. When the server has a Director key, that role needs it and `X-Role: director` alone is
treated as an agent; agents are never given the key. Don't send `X-Role` yourself. If you think a rule or setting
should change, propose it with `ask_director` on your task.

## Priorities and milestones

- **Set a priority on every task you create.** `urgent`: blocks other work or is broken now. `high`: next in line.
  `medium`: normal. `low`: nice to have. Reprioritize with `PATCH /api/tasks/:key {"priority": "high"}`.
- A reprioritized task goes to the bottom of its new priority level. To put it at an exact spot, use `move` with an `index`.
- **Milestones** group tasks toward a goal. Create one when planning a chunk of work, then pass `"milestone": "<name>"`
  when creating tasks. Close it (`status: "closed"`) when everything in it is done.

## Planning: epics and sprints

When asked to plan or break down work:

1. **Epics** for each large feature or theme (`POST /api/projects/:key/epics`). The description says what the epic
   delivers and what's out of scope.
2. **Tasks** inside them: each one small enough for a single focused session, with acceptance criteria, a priority,
   an `estimate` in points (1, 2, 3, 5, 8; split anything bigger), and `depends_on` for real ordering constraints.
3. **Sprints** that group tasks you would build and review together (`POST /api/projects/:key/sprints`). Optimize
   for maintainability: each sprint should leave the codebase in a coherent, tested state, finish what it starts
   (put foundations before the things built on them), and keep a steady size in points. The sprint `goal` explains
   what it delivers and *why these tasks belong together*. The human reviews this on the Plan view.
4. You run the sprints. When none is active, start the next planned one (`status: "active"`); when its tasks are
   done, complete it (`status: "completed"`). Delete or re-cut sprints and milestones as the plan changes.

## Writing good tasks

A project may require fields before a task is ready (`required_fields`, e.g. `priority`, `estimate`, `epic`) and
limit `estimate` to `allowed_estimates` (e.g. 1, 2, 3, 5, 8). Both show on the project (`GET /api/projects/:key`).
Capturing into `backlog` works without them: the task comes back with `missing_fields` and a warning ("Needs estimate,
criteria before it can move to todo."), and so does an update that clears one ("Needs criteria to be ready." once it's
past backlog). Creating a task in `todo`, moving or releasing one there, or claiming one straight out of `backlog`,
without them is a 400 naming the fields. A plain `release` of a held task that lost one returns it to `backlog` with a
warning. Don't invent placeholders; leave them for triage. A bulk create checks
every item and names all the failing ones in one error (`tasks[1], tasks[3]: ...`, grouped by message, with `errors`
listing each), and creates nothing.

With a `repo_path`, creating or updating a task also warns about what a worker would trip on later: a cited rule ID
its `reference_patterns` source doesn't contain, a `context` path missing on the base branch (fine if an earlier task
creates it: put that task in `depends_on`), and a `scope` reaching into a protected path the task can't unlock
("only the Director can add \"golden-change\". Ask when you start."). They never block; fix them while it's cheap.

- **Title**: short and imperative — "Add double jump", "Fix enemy spawn overlap".
- **Description** (Markdown): the goal and background. Why it matters, constraints, open questions.
- **criteria**: concrete, checkable statements of done. The human reviews against these:
  `["Second jump only available after leaving the ground", "Resets on landing", "Unit test for the state machine"]`.
  Mark the ones only the human can judge with `[director]`: `"[director] Jump feels responsive on the phone"`.
  Put them in `criteria`, not as `- [ ]` lines in the description.
- **context**: what to read first, so the agent doesn't guess: `["docs/movement.md", "Assets/Scripts/Player/"]`
- **prerequisites**: anything the human must set up first (SDKs, editor modules, a device), so no agent claims
  the task before it can be done: `["Install the .NET 8 SDK", "Add Unity iOS Build Support"]`
- Break big work into subtasks with `parent`, and express ordering with `depends_on`:
  ```bash
  curl -s -X POST "$BASE/api/tasks/bulk" "${H[@]}" -d '{"tasks": [
    {"project": "GAME", "title": "Design save file format", "status": "todo", "priority": "high", "milestone": "Save system"},
    {"project": "GAME", "title": "Implement save/load", "status": "todo", "priority": "high", "milestone": "Save system", "depends_on": ["#0"]},
    {"project": "GAME", "title": "Autosave on checkpoint", "status": "todo", "milestone": "Save system", "depends_on": ["#1"]}
  ]}'
  ```

## Triaging playtest captures

The human captures playtest notes from their phone (`/capture`). Each becomes a `backlog` task labeled `playtest`,
usually a one-line title, a build/device line, and screenshots. When asked to triage them:

1. `GET /api/tasks?project=GAME&label=playtest&status=backlog` (MCP: `list_tasks` with `label: "playtest"`; its
   summaries list each capture's `attachments` with their ids).
2. Look at each screenshot (MCP: `get_attachment` shows the image; HTTP: `GET /api/attachments/:id`).
3. Rewrite the task so an agent could pick it up cold: a clear title, what's wrong and where, `criteria`,
   `context` (the scene/scripts likely involved), a `type` and `priority`, and an `epic` if one fits.
   Keep the `playtest` label and the build/device line.
4. Merge duplicates (comment on the survivor, delete the rest only if the human agrees). Leave the tasks in
   `backlog` unless the human asked you to make them ready.

## MCP

If your client supports MCP, prefer it over raw HTTP. For Claude Code:

```bash
claude mcp add --transport http kanban {{BASE_URL}}/mcp --header "X-Agent: claude-code"
```

Tools: `list_projects`, `create_project`, `get_board`, `list_tasks`, `get_task`, `create_task`, `create_tasks`,
`update_task`, `move_task`, `claim_task`, `claim_next_task`, `release_task`, `add_comment`, `list_activity`,
`check_criteria`, `submit_for_review`, `get_review_queue`, `get_attachment`,
`ask_director`, `list_decisions`, `get_decision`, `recheck_context`, `import_tasks`, `export_markdown`,
`list_epics`, `create_epic`, `get_plan`, `list_sprints`, `create_sprint`, `update_sprint`,
`list_milestones`, `get_milestone`, `create_milestone`, `update_milestone`.

MCP is for agents, so the Director-only actions (project settings, the glossary import, review verdicts) aren't tools
there. Write tools (`create_task(s)`, `update_task`, `check_criteria`, `submit_for_review`, `recheck_context`,
`release_task`, `create_epic`) answer compactly: `{key, status, changed, warnings?, violations?, unchecked_criteria?,
awaiting_director?, missing_fields?}` (a new task gives its `title` instead of `changed`). Pass `verbose: true` for the
full task. Reads are lean too: `list_tasks` returns summaries (key, title, status, type, priority, and when set labels,
epic, sprint, estimate, assignee, blocked, waiting_on_director, missing_fields, attachment ids; `full: true` for whole
tasks), `get_task` leaves out the activity log unless you pass `activity: true`, and `list_projects` gives key, name,
description and counts (settings are in `get_board`'s project and in briefings). HTTP responses are unchanged.
