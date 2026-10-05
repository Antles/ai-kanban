import {
  STATUSES,
  STATUS_NAMES,
  PRIORITIES,
  TYPES,
  MILESTONE_STATUSES,
  SPRINT_STATUSES,
  REVIEW_VERDICTS,
  CRITERION_OWNERS,
  REQUIRABLE_FIELDS,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  ApiError,
} from './service.js';

export function registerApi(router, kanban, { guide, openapi, directorLocked = false }) {
  const created = (ctx, value) => {
    ctx.status = 201;
    return value;
  };
  // Who is acting: an "agent" in the body (subagents share one X-Agent), else the X-Agent header.
  const as = (ctx) => (typeof ctx.body.agent === 'string' && ctx.body.agent.trim().slice(0, 64)) || ctx.actor;

  router.get('/api/health', () => ({ ok: true }));
  // How this request is seen: the board UI uses it to ask for the Director key, or to say the board runs open.
  router.get('/api/auth', (ctx) => ({
    role: ctx.role,
    director_key_required: directorLocked,
    ...(directorLocked && ctx.headers['x-director-key'] && { director_key_accepted: ctx.role === 'director' }),
  }));
  router.get('/api/guide', (ctx) => {
    ctx.type = 'text/markdown; charset=utf-8';
    return guide(ctx.baseUrl);
  });
  router.get('/api/openapi.json', (ctx) => openapi(ctx.baseUrl));
  router.get('/api/meta', () => ({
    statuses: STATUSES,
    status_names: STATUS_NAMES,
    priorities: [...PRIORITIES].reverse(),
    types: TYPES,
    milestone_statuses: MILESTONE_STATUSES,
    sprint_statuses: SPRINT_STATUSES,
    review_verdicts: REVIEW_VERDICTS,
    criterion_owners: CRITERION_OWNERS,
    requirable_fields: REQUIRABLE_FIELDS,
    attachment_types: ATTACHMENT_TYPES,
    max_attachment_bytes: MAX_ATTACHMENT_BYTES,
  }));

  // Projects
  router.get('/api/projects', () => kanban.listProjects());
  router.post('/api/projects', (ctx) => created(ctx, kanban.createProject(ctx.body, ctx.actor)));
  router.get('/api/projects/:key', (ctx) => kanban.getProject(ctx.params.key));
  router.patch('/api/projects/:key', (ctx) => kanban.updateProject(ctx.params.key, ctx.body, ctx.actor, { role: ctx.role }));
  router.delete('/api/projects/:key', (ctx) => kanban.deleteProject(ctx.params.key, ctx.actor, { role: ctx.role }));
  router.get('/api/projects/:key/board', (ctx) => kanban.getBoard(ctx.params.key));
  router.get('/api/projects/:key/repo', (ctx) => kanban.repoStatus(ctx.params.key, ctx.query, { role: ctx.role }));
  router.post('/api/projects/:key/glossary/import', (ctx) => kanban.importGlossary(ctx.params.key, ctx.body, ctx.actor, { role: ctx.role }));
  router.get('/api/projects/:key/repo/file', async (ctx) => {
    const content = await kanban.repoFile(ctx.params.key, ctx.query.path);
    ctx.type = 'text/plain; charset=utf-8';
    ctx.responseHeaders = { 'x-content-type-options': 'nosniff' };
    return content;
  });
  router.post('/api/projects/:key/claim-next', (ctx) => kanban.claimNextResponse(ctx.params.key, ctx.body.agent ?? ctx.actor, ctx.body));
  router.get('/api/projects/:key/review', (ctx) => kanban.getReviewQueue(ctx.params.key));
  router.get('/api/projects/:key/inbox', (ctx) => kanban.getInbox(ctx.params.key, ctx.query));
  router.post('/api/projects/:key/import', (ctx) => kanban.importTasks(ctx.params.key, ctx.body.tasks, ctx.actor, { role: ctx.role }));
  router.get('/api/projects/:key/export.md', (ctx) => {
    ctx.type = 'text/markdown; charset=utf-8';
    ctx.responseHeaders = { 'content-disposition': `inline; filename="${ctx.params.key.toUpperCase()}-board.md"` };
    return kanban.exportMarkdown(ctx.params.key);
  });

  // Milestones
  router.get('/api/projects/:key/milestones', (ctx) => kanban.listMilestones(ctx.params.key, ctx.query));
  router.post('/api/projects/:key/milestones', (ctx) =>
    created(ctx, kanban.createMilestone(ctx.params.key, ctx.body, ctx.actor)),
  );
  router.get('/api/milestones/:id', (ctx) => kanban.getMilestone(ctx.params.id));
  router.patch('/api/milestones/:id', (ctx) => kanban.updateMilestone(ctx.params.id, ctx.body, ctx.actor));
  router.delete('/api/milestones/:id', (ctx) => kanban.deleteMilestone(ctx.params.id, ctx.actor));

  // Epics (tasks of type "epic") and sprints
  router.get('/api/projects/:key/epics', (ctx) => kanban.listEpics(ctx.params.key));
  router.post('/api/projects/:key/epics', (ctx) => created(ctx, kanban.createEpic(ctx.params.key, ctx.body, ctx.actor, { role: ctx.role })));
  router.get('/api/projects/:key/plan', (ctx) => kanban.getPlan(ctx.params.key));
  router.get('/api/projects/:key/sprints', (ctx) => kanban.listSprints(ctx.params.key, ctx.query));
  router.post('/api/projects/:key/sprints', (ctx) => created(ctx, kanban.createSprint(ctx.params.key, ctx.body, ctx.actor)));
  router.get('/api/sprints/:id', (ctx) => kanban.getSprint(ctx.params.id));
  router.patch('/api/sprints/:id', (ctx) => kanban.updateSprint(ctx.params.id, ctx.body, ctx.actor));
  router.delete('/api/sprints/:id', (ctx) => kanban.deleteSprint(ctx.params.id, ctx.actor));

  // Tasks
  router.get('/api/tasks', (ctx) => kanban.listTasks(ctx.query));
  router.post('/api/tasks', (ctx) => created(ctx, kanban.createTask(ctx.body, ctx.actor, { role: ctx.role })));
  router.post('/api/tasks/bulk', (ctx) => {
    if (!Array.isArray(ctx.body.tasks)) throw new ApiError(400, 'Body must be {"tasks": [...]}');
    return created(ctx, kanban.createTasks(ctx.body.tasks, ctx.actor, { role: ctx.role }));
  });
  router.get('/api/tasks/:ref', (ctx) => kanban.getTask(ctx.params.ref));
  router.patch('/api/tasks/:ref', (ctx) => kanban.updateTask(ctx.params.ref, ctx.body, as(ctx), { role: ctx.role }));
  router.delete('/api/tasks/:ref', (ctx) => kanban.deleteTask(ctx.params.ref, as(ctx), { role: ctx.role }));
  router.post('/api/tasks/:ref/move', (ctx) => kanban.moveTask(ctx.params.ref, ctx.body, as(ctx), { role: ctx.role }));
  router.post('/api/tasks/:ref/claim', (ctx) =>
    kanban.claimTask(ctx.params.ref, ctx.body.agent ?? ctx.actor, { force: ctx.body.force === true, role: ctx.role }),
  );
  router.post('/api/tasks/:ref/release', (ctx) =>
    kanban.releaseTask(ctx.params.ref, ctx.body.agent ?? ctx.actor, {
      status: ctx.body.status,
      force: ctx.body.force === true,
      checkpoint: ctx.body.checkpoint,
      role: ctx.role,
    }),
  );
  router.post('/api/tasks/:ref/criteria', (ctx) => kanban.checkCriteria(ctx.params.ref, ctx.body, as(ctx), { role: ctx.role }));
  router.post('/api/tasks/:ref/criteria/extract', (ctx) => kanban.extractCriteria(ctx.params.ref, ctx.actor, { role: ctx.role }));
  router.post('/api/tasks/:ref/context/recheck', (ctx) => kanban.recheckContext(ctx.params.ref, as(ctx), { role: ctx.role }));
  router.post('/api/tasks/:ref/prerequisites', (ctx) =>
    kanban.checkPrerequisites(ctx.params.ref, ctx.body, ctx.actor, { role: ctx.role }),
  );
  router.post('/api/tasks/:ref/submit', (ctx) => kanban.submitForReview(ctx.params.ref, ctx.body, as(ctx), { role: ctx.role }));
  router.post('/api/tasks/:ref/review', (ctx) => kanban.reviewTask(ctx.params.ref, ctx.body, ctx.actor, { role: ctx.role }));
  router.get('/api/tasks/:ref/comments', (ctx) => kanban.listComments(ctx.params.ref));
  router.post('/api/tasks/:ref/comments', (ctx) => created(ctx, kanban.addComment(ctx.params.ref, ctx.body, as(ctx))));

  // Questions for the Director, and the Decisions that come out of them
  router.get('/api/tasks/:ref/questions', (ctx) => kanban.questionsFor(kanban.taskRow(ctx.params.ref).id));
  router.post('/api/tasks/:ref/questions', (ctx) => created(ctx, kanban.askDirector(ctx.params.ref, ctx.body, as(ctx))));
  router.get('/api/projects/:key/questions', (ctx) => kanban.listQuestions(ctx.params.key, ctx.query));
  router.post('/api/questions/:id/answer', (ctx) => kanban.answerQuestion(ctx.params.id, ctx.body, ctx.actor, { role: ctx.role }));
  router.get('/api/projects/:key/decisions', (ctx) => kanban.listDecisions(ctx.params.key, ctx.query));
  router.post('/api/projects/:key/decisions', (ctx) =>
    created(ctx, kanban.createDecision(ctx.params.key, ctx.body, ctx.actor, { role: ctx.role })),
  );
  router.get('/api/projects/:key/decisions/:id', (ctx) => kanban.getDecision(ctx.params.key, ctx.params.id));

  // Attachments: upload the raw file as the body, with its Content-Type and ?filename=
  router.get('/api/tasks/:ref/attachments', (ctx) => kanban.attachmentsFor(kanban.taskRow(ctx.params.ref).id));
  router.post(
    '/api/tasks/:ref/attachments',
    (ctx) =>
      created(
        ctx,
        kanban.addAttachment(
          ctx.params.ref,
          { filename: ctx.query.filename ?? ctx.headers['x-filename'], mime: ctx.headers['content-type'], data: ctx.raw },
          ctx.actor,
        ),
      ),
    { raw: true },
  );
  router.get('/api/attachments/:id', (ctx) => {
    const file = kanban.getAttachment(ctx.params.id);
    ctx.type = file.mime;
    ctx.responseHeaders = {
      'content-length': file.size,
      'content-disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
    };
    return file.data;
  });
  router.delete('/api/attachments/:id', (ctx) => kanban.deleteAttachment(ctx.params.id, as(ctx), { role: ctx.role }));

  // Activity
  router.get('/api/activity', (ctx) => kanban.listActivity(ctx.query));
}
