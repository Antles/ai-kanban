// AI Kanban board UI. Plain ES modules, no build step.
import { icon, statusIcon, priorityIcon, statusName } from './icons.js';
import { esc, markdown, inline } from './markdown.js';
import { hue, initials } from './people.js';
import { groupActivity } from './activity.js';
import { cardEdge, quietCard } from './card-state.js';
import { menuButton, bindMenus, menuIsOpen, openMenu, openMenuAt, openPalette, paletteIsOpen, closeMenu } from './menu.js';
import { fuzzyRank } from './fuzzy.js';
import { fileChip, imageHtml } from './media.js';

const STATUS_NAMES = { backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
const STATUSES = Object.keys(STATUS_NAMES);
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const TYPES = ['task', 'feature', 'bug', 'chore', 'spike'];
const TASK_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const VIEWS = ['inbox', 'board', 'plan', 'review'];

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

const state = {
  projects: [],
  projectKey: null,
  board: null,
  me: store.get('kanban.me', 'human'),
  apiKey: store.get('kanban.apiKey', ''),
  directorKey: store.get('kanban.directorKey', ''),
  auth: null, // GET /api/auth: how the server sees this board (Director or agent, locked or open)
  q: '',
  assignee: '',
  milestone: '', // '' = all, '__none__' = without milestone, otherwise a milestone id
  epic: '', // '' = all, '__none__' = no epic, otherwise an epic key
  sprint: '', // '' = all, '__none__' = unscheduled, '__active__', otherwise a sprint id
  flag: '', // '' = all, otherwise a key of FLAGS
  view: VIEWS.includes(store.get('kanban.view', 'board')) ? store.get('kanban.view', 'board') : 'board',
  plan: null,
  review: null, // tasks waiting in review, with handoffs
  inbox: null, // everything waiting on the human
  reviewing: null, // key of the task whose "request changes" box is open
  reviewDrafts: {}, // unsent feedback per task key
  reviewOpen: {}, // Review card details the Director opened or closed, per task key
  changesOpen: new Set(), // activity disclosures ("Show changes", "N more on…") left open, by data-open-id
  openSections: new Set(), // empty task sections opened from the add row (task view)
  refocus: null, // list input to refocus after the task modal re-renders
  sprintEditing: null, // sprint id being edited in the Plan view, or 'new'
  epicCreating: false,
  planDrag: null,
  msEditing: null, // milestone id being edited in the Milestones dialog, or 'new'
  task: null, // detail of the open task
  descEditing: false,
  activityOpen: store.get('kanban.activity', '0') === '1',
  drag: null,
  renderPending: false,
  taskStale: false,
  flash: new Set(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const els = {
  board: $('#board'),
  app: $('#app'),
  sidebar: $('#sidebar'),
  sidebarCollapse: $('#sidebar-collapse'),
  scrim: $('#sidebar-scrim'),
  drawerToggle: $('#drawer-toggle'),
  projectList: $('#project-list'),
  projectsSection: $('#projects-section'),
  viewNav: $('#view-nav'),
  projectSettings: $('#project-settings'),
  crumbProject: $('#crumb-project'),
  crumbView: $('#crumb-view'),
  viewActions: $('#view-actions'),
  meAvatar: $('#me-avatar'),
  filters: $('#filters'),
  search: $('#search'),
  filterFields: $('#filter-fields'),
  filterButton: $('#filter-button'),
  filterCount: $('#filter-count'),
  filterPopover: $('#filter-popover'),
  filterChips: $('#filter-chips'),
  plan: $('#plan'),
  review: $('#review'),
  reviewCount: $('#review-count'),
  inbox: $('#inbox'),
  inboxCount: $('#inbox-count'),
  viewSwitch: $('#sidebar'),
  captureLink: $('#capture-link'),
  me: $('#me'),
  directorMode: $('#director-mode'),
  themeToggle: $('#theme-toggle'),
  live: $('#live'),
  activity: $('#activity'),
  activityList: $('#activity-list'),
  activityToggle: $('#activity-toggle'),
  modalRoot: $('#modal-root'),
  toasts: $('#toasts'),
};

// ------------------------------------------------------------------ helpers

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fullDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}

function avatar(name) {
  return `<span class="avatar" style="--hue:${hue(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
}

function statusPill(status) {
  return `<span class="status-pill">${statusIcon(status, { decorative: true })}${esc(statusName(status))}</span>`;
}

// A priority as its icon (with a tooltip), optionally followed by its name.
function priorityBadge(priority, { withName = false } = {}) {
  return `<span class="prio prio-${esc(priority)}">${priorityIcon(priority)}${withName ? esc(priority) : ''}</span>`;
}

function taskLink(key) {
  return `<a class="task-link" href="#/${esc(key)}">${esc(key)}</a>`;
}

// A toast in the bottom-left corner. action: {label, run} adds a button (Undo) and keeps it up longer.
function toast(message, kind = '', { action } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.remove();
      action.run();
    });
    el.append(btn);
  }
  els.toasts.append(el);
  setTimeout(() => el.remove(), action ? 7000 : kind === 'error' ? 5000 : 2500);
}

// An empty view: an icon, one sentence, and the next thing to do.
function emptyState({ icon: name, title, text = '', action = '' }) {
  return `<div class="empty-view"><span class="empty-icon">${icon(name, { size: 20 })}</span>
    <div class="empty-title">${title}</div>${text ? `<p>${text}</p>` : ''}${action ? `<div class="empty-action">${action}</div>` : ''}</div>`;
}

// Placeholders while a view's data loads.
const sk = (width, cls = '') => `<span class="sk ${cls}" style="width:${width}"></span>`;
const skeletonCard = () => `<div class="card sk-card">${sk('45%')}${sk('90%', 'sk-title')}${sk('60%')}</div>`;
const SKELETONS = {
  board: () =>
    STATUSES.map(
      (s, i) => `<section class="column" aria-hidden="true"><header class="column-head">${sk('14px', 'sk-dot')}${sk('38%')}</header>
        <div class="cards">${Array.from({ length: [3, 4, 2, 1, 3][i] }, skeletonCard).join('')}</div></section>`,
    ).join(''),
  rows: (n) => `<ol class="plan-list">${Array.from({ length: n }, (_, i) => `<li class="plan-row sk-row">${sk('8px', 'sk-dot')}${sk('56px')}${sk(`${40 + ((i * 17) % 40)}%`)}</li>`).join('')}</ol>`,
  cards: (n) => Array.from({ length: n }, () => `<div class="review-card sk-block">${sk('30%')}${sk('70%', 'sk-title')}${sk('95%')}${sk('80%')}</div>`).join(''),
};

function skeleton(view) {
  const body =
    view === 'board'
      ? SKELETONS.board()
      : view === 'plan'
        ? `<div class="plan-main"><div class="plan-toolbar">${sk('90px', 'sk-title')}</div><section class="sprint">${SKELETONS.rows(5)}</section><section class="sprint sprint-unscheduled">${SKELETONS.rows(8)}</section></div>`
        : `<div class="review-main"><div class="plan-toolbar">${sk('90px', 'sk-title')}</div>${SKELETONS.cards(3)}</div>`;
  return `<div class="skeleton" aria-busy="true" aria-label="Loading">${body}</div>`;
}

const splitList = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------- api

// `raw` sends a File/Blob as-is (attachments); everything else is JSON.
async function api(path, { method = 'GET', body, raw } = {}) {
  // The board is the Director's seat: it may tick Director criteria and prerequisites, and answer questions.
  // When the server has a DIRECTOR_KEY, the role also needs that key.
  const headers = { 'X-Agent': state.me || 'human', 'X-Role': 'director' };
  if (state.directorKey) headers['X-Director-Key'] = state.directorKey;
  if (raw) headers['Content-Type'] = raw.type;
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
  const res = await fetch(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  if (res.status === 401) {
    openApiKeyModal();
    throw new Error('An API key is required');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data;
}

// <img>/<video> can't send headers, so the key rides in the query string.
function fileUrl(url) {
  return state.apiKey ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(state.apiKey)}` : url;
}

async function uploadFiles(key, files) {
  let uploaded = 0;
  for (const file of files) {
    const path = `/api/tasks/${key}/attachments?filename=${encodeURIComponent(file.name || 'pasted.png')}`;
    if (await attempt(api(path, { method: 'POST', raw: file }))) uploaded++;
  }
  if (uploaded) toast(`Attached ${uploaded} file${uploaded > 1 ? 's' : ''} to ${key}`);
}

async function attempt(promise) {
  try {
    return await promise;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

// ------------------------------------------------------------------ routing

function setHash() {
  const target = state.task ? state.task.key : state.projectKey;
  const hash = target ? `#/${target}` : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname);
}

async function applyHash() {
  const ref = decodeURIComponent(location.hash.replace(/^#\/?/, '')).toUpperCase();
  const taskKey = TASK_KEY_RE.test(ref) ? ref : null;
  const wanted = taskKey ? taskKey.replace(/-\d+$/, '') : ref;
  // A link to a project created since the page loaded.
  if (wanted && !state.projects.some((p) => p.key === wanted)) await loadProjects();
  const project =
    state.projects.find((p) => p.key === wanted) ??
    state.projects.find((p) => p.key === state.projectKey) ??
    state.projects.find((p) => p.key === store.get('kanban.project', '')) ??
    state.projects[0];
  if ((project?.key ?? null) !== state.projectKey || !state.board) await selectProject(project?.key ?? null);
  if (taskKey) await openTask(taskKey);
  else if (state.task) closeModal();
  setHash();
}

// ----------------------------------------------------------------- projects

async function loadProjects() {
  state.projects = (await attempt(api('/api/projects'))) ?? [];
  renderProjectPicker();
}

// A project's mark in the sidebar: its first letter on its own hue.
const projectMark = (p) => `<span class="project-mark" style="--hue:${hue(p.key)}" aria-hidden="true">${esc(p.key[0])}</span>`;

const VIEW_NAMES = { inbox: 'Inbox', board: 'Board', plan: 'Plan', review: 'Review' };

// The sidebar's project list; the current project carries its views (Board, Plan, Review) under it.
function renderProjectPicker() {
  const hasProjects = state.projects.length > 0;
  updateFilterVisibility();
  for (const el of [els.activityToggle, els.captureLink, els.projectSettings, $('[data-view="inbox"]', els.sidebar), els.viewNav]) el.hidden = !hasProjects;
  els.activity.hidden = !hasProjects || !state.activityOpen;
  els.projectList.innerHTML = state.projects
    .map(
      (p) => `<li class="project-entry${p.key === state.projectKey ? ' is-current' : ''}" data-entry="${esc(p.key)}">
        <button class="nav-item project-item" type="button" data-project="${esc(p.key)}" title="${esc(p.name)} (${esc(p.key)})"${
          p.key === state.projectKey ? ' aria-current="true"' : ''
        }>${projectMark(p)}<span class="nav-label">${esc(p.name)}</span></button></li>`,
    )
    .join('');
  // The views follow the current project in the list.
  $(`[data-entry="${CSS.escape(state.projectKey ?? '')}"]`, els.projectList)?.append(els.viewNav);
  renderLocation();
}

// The breadcrumb (Project › View) and the view's own actions in the top bar.
function renderLocation() {
  const project = state.projects.find((p) => p.key === state.projectKey);
  els.crumbProject.textContent = project?.name ?? '';
  els.crumbView.textContent = project ? VIEW_NAMES[state.view] : '';
  for (const btn of $$('[data-view]', els.sidebar)) {
    if (btn.dataset.view === state.view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  const actions = {
    board: [{ action: 'new-task', icon: 'plus', label: 'Task', shortcut: 'C' }],
    plan: [
      { action: 'new-sprint', icon: 'calendar-plus', label: 'Sprint' },
      { action: 'new-epic', icon: 'folder-plus', label: 'Epic' },
    ],
  }[state.view] ?? [];
  els.viewActions.innerHTML = project
    ? actions
        .map(
          (a) =>
            `<button class="btn" type="button" data-top-action="${a.action}" aria-label="New ${a.label.toLowerCase()}" title="New ${a.label.toLowerCase()}${a.shortcut ? ` (${a.shortcut})` : ''}"${a.shortcut ? ` aria-keyshortcuts="${a.shortcut}"` : ''}>${icon(a.icon, { size: 14 })}<span class="btn-label">${a.label}</span></button>`,
        )
        .join('')
    : '';
}

// The sidebar collapses to icons (remembered); below 860 px it's a drawer.
function setSidebarCollapsed(collapsed) {
  els.app.classList.toggle('sidebar-collapsed', collapsed);
  store.set('kanban.sidebar', collapsed ? 'collapsed' : 'open');
  const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  els.sidebarCollapse.setAttribute('aria-label', label);
  els.sidebarCollapse.title = label;
}

function setDrawer(open) {
  els.app.classList.toggle('drawer-open', open);
  els.scrim.hidden = !open;
  els.drawerToggle.setAttribute('aria-expanded', String(open));
  if (open) $('[aria-current="page"], .nav-item', els.sidebar)?.focus();
}

function bindSidebar() {
  setSidebarCollapsed(store.get('kanban.sidebar', 'open') === 'collapsed');
  els.sidebarCollapse.addEventListener('click', () => setSidebarCollapsed(!els.app.classList.contains('sidebar-collapsed')));
  els.drawerToggle.addEventListener('click', () => setDrawer(!els.app.classList.contains('drawer-open')));
  els.scrim.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.app.classList.contains('drawer-open')) {
      setDrawer(false);
      els.drawerToggle.focus();
    }
  });
  els.sidebar.addEventListener('click', (e) => {
    const project = e.target.closest('[data-project]')?.dataset.project;
    if (project) {
      closeModal();
      if (project !== state.projectKey) selectProject(project);
    }
    if (e.target.closest('[data-project], [data-view], #capture-link, #activity-toggle, #project-settings')) setDrawer(false);
  });
  els.viewActions.addEventListener('click', (e) => {
    const action = e.target.closest('[data-top-action]')?.dataset.topAction;
    if (action === 'new-task') {
      const column = $('.column[data-status="todo"]', els.board);
      if (column) openQuickAdd(column);
    } else if (action === 'new-sprint') {
      state.sprintEditing = 'new';
      renderPlan();
    } else if (action === 'new-epic') {
      state.epicCreating = true;
      renderPlan();
    }
  });
}

async function selectProject(key) {
  state.projectKey = key;
  state.board = null;
  state.milestone = '';
  state.epic = '';
  state.sprint = '';
  state.flag = '';
  state.plan = null;
  state.review = null;
  state.inbox = null;
  state.reviewing = null;
  if (key) store.set('kanban.project', key);
  renderProjectPicker();
  document.title = key ? `${state.projects.find((p) => p.key === key)?.name ?? key} · AI Kanban` : 'AI Kanban';
  renderView(); // the current view's loading state until its data arrives
  await loadBoard();
  if (state.activityOpen) loadActivity();
  setHash();
}

function projectForm(project = {}) {
  const editing = Boolean(project.key);
  return `
    <label class="field"><span>Key</span>
      <input name="key" required maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{1,9}" value="${esc(project.key ?? '')}"
        ${editing ? 'disabled' : 'autofocus'} placeholder="GAME" style="text-transform:uppercase">
      <small>Prefix for task keys, e.g. GAME-12. 2–10 letters/digits.</small>
    </label>
    <label class="field"><span>Name</span><input name="name" maxlength="200" value="${esc(project.name ?? '')}" placeholder="My Game" ${editing ? 'autofocus' : ''}></label>
    <label class="field"><span>Description</span><textarea name="description" rows="3" placeholder="Optional — agents can read this for context">${esc(project.description ?? '')}</textarea></label>
    <label class="field"><span>Agent brief</span><textarea name="agent_brief" rows="6" placeholder="Standing instructions every agent gets when it claims a task. E.g.&#10;- Portrait 1080×1920, pixel-perfect (no texture filtering)&#10;- Design rules live in docs/; read docs/style.md first&#10;- Run the play-mode tests before submitting">${esc(project.agent_brief ?? '')}</textarea>
      <small>Markdown. Sent with every claim, so agents follow your conventions without being told each time.</small></label>`;
}

// Project rules edited as rows of small forms. Column keys may be dotted ("match.labels").
// type: text (default), textarea, checkbox, list (comma-separated), number.
const SETTING_EDITORS = {
  brief_sections: {
    title: 'Brief sections',
    hint: 'Extra standing rules for some tasks only (Unity, Core, Art…). Each is appended to the agent brief in the briefing of every task it matches: all the conditions you fill in must hold.',
    columns: [
      { key: 'title', label: 'Heading', placeholder: 'Unity tasks' },
      { key: 'match.labels', label: 'Labels (any of)', type: 'list', placeholder: 'unity' },
      { key: 'match.epic', label: 'Epic (key or title)', placeholder: 'AS-23' },
      { key: 'match.type', label: 'Types', type: 'list', placeholder: 'bug, feature' },
      { key: 'body', label: 'Rules (Markdown)', type: 'textarea', placeholder: '- Never edit ProjectSettings/ by hand\n- Run ./tools/unity-test.sh before submitting' },
    ],
  },
  protected_paths: {
    title: 'Protected paths',
    hint: 'Files agents must not change. A submit touching one is flagged in red, unless the task has the unlocking label.',
    columns: [
      { key: 'glob', label: 'Glob', placeholder: 'sim/**/Golden/**', grow: true },
      { key: 'unlock_label', label: 'Unlocked by label', placeholder: 'golden-change' },
    ],
  },
  reference_patterns: {
    title: 'Rule IDs',
    hint: 'IDs your docs define and tasks cite (like C-SPARK-2). With a repository, each ID in a task links to its line in the source doc, and IDs the doc no longer has are flagged.',
    columns: [
      { key: 'regex', label: 'Pattern (regex)', placeholder: 'C-[A-Z]+-\\d+' },
      { key: 'source', label: 'Defined in', placeholder: 'docs/combat.md', grow: true },
    ],
  },
  glossary: {
    title: 'Glossary',
    hint: 'The words to use. Task text and handoffs using an avoided word get a warning (whole words, any case; never blocking).',
    columns: [
      { key: 'term', label: 'Term', placeholder: 'Hero' },
      { key: 'avoid', label: 'Avoid', type: 'list', placeholder: 'unit, character', grow: true },
      { key: 'allow', label: 'But allow', type: 'list', placeholder: 'unit test' },
    ],
    extra: (project) => `<div class="glossary-import">
      <label class="field grow"><span>Import from a CONTEXT.md-style file</span>
        <textarea data-import="markdown" rows="3" placeholder="Paste **Term**: blocks with _Avoid_: lines${project.repo_path ? ', or import a repo file' : ''}"></textarea></label>
      <div class="actions">
        ${project.repo_path ? '<input data-import="path" value="CONTEXT.md" aria-label="Repo file" spellcheck="false">' : ''}
        <button type="button" class="btn" data-action="import-glossary">Import (replaces the list)</button>
      </div>
    </div>`,
  },
  checks: {
    title: 'Checks',
    hint: 'Commands agents run before submitting and report in their handoff. Missing or failed required checks show as warnings in Review. The board never runs anything.',
    columns: [
      { key: 'name', label: 'Name', placeholder: 'core tests' },
      { key: 'command', label: 'Command', placeholder: 'dotnet test sim/', grow: true },
      { key: 'required', label: 'Always required', type: 'checkbox', default: true },
      { key: 'required_when_paths', label: 'Or required when these change', type: 'list', placeholder: 'sim/**/Rules/**, *.replay', grow: true },
    ],
  },
};

const getPath = (o, key) => key.split('.').reduce((v, k) => v?.[k], o);
function setPath(o, key, value) {
  const parts = key.split('.');
  let cur = o;
  for (const k of parts.slice(0, -1)) cur = cur[k] ??= {};
  cur[parts.at(-1)] = value;
}

function settingRowHtml(spec, row = {}) {
  const cell = (c) => {
    const v = getPath(row, c.key);
    const attrs = `data-col="${c.key}" data-type="${c.type ?? 'text'}" placeholder="${esc(c.placeholder ?? '')}"`;
    if (c.type === 'checkbox') {
      const on = v === undefined ? c.default === true : v === true;
      return `<label class="field check"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span>${esc(c.label)}</span></label>`;
    }
    const value = Array.isArray(v) ? v.join(', ') : (v ?? '');
    const input =
      c.type === 'textarea'
        ? `<textarea rows="3" ${attrs}>${esc(value)}</textarea>`
        : `<input ${c.type === 'number' ? 'type="number"' : ''} ${attrs} value="${esc(value)}">`;
    return `<label class="field${c.grow ? ' grow' : ''}${c.type === 'textarea' ? ' wide' : ''}"><span>${esc(c.label)}</span>${input}</label>`;
  };
  return `<div class="setting-row">${spec.columns.map(cell).join('')}
    <button type="button" class="icon-btn small" data-action="remove-row" aria-label="Remove">${icon('x', { size: 14 })}</button></div>`;
}

function settingsEditorsHtml(project) {
  return Object.entries(SETTING_EDITORS)
    .map(([key, spec]) => {
      const rows = project[key] ?? [];
      return `<details class="settings-group" data-rows="${key}" ${rows.length ? 'open' : ''}>
        <summary>${esc(spec.title)}${rows.length ? ` <span class="count">${rows.length}</span>` : ''}</summary>
        <p class="muted small">${spec.hint}</p>
        <div class="rows">${rows.map((r) => settingRowHtml(spec, r)).join('')}</div>
        <button type="button" class="btn btn-ghost" data-action="add-row">${icon('plus', { size: 14 })}Add</button>
        ${spec.extra ? spec.extra(project) : ''}
      </details>`;
    })
    .join('');
}

const REQUIRABLE = ['priority', 'estimate', 'epic', 'criteria', 'labels'];

function fieldRulesHtml(project) {
  const req = project.required_fields ?? [];
  const est = project.allowed_estimates ?? [];
  return `<details class="settings-group" ${req.length || est.length ? 'open' : ''}>
    <summary>Task fields</summary>
    <p class="muted small">Fields agents must fill in when they create tasks (tasks you add here are exempt; the “Missing required fields” filter finds gaps).</p>
    <div class="setting-row">
      <div class="field"><span>Required on create</span><div class="check-row">${REQUIRABLE.map(
        (f) => `<label class="field check"><input type="checkbox" name="required_fields" value="${f}" ${req.includes(f) ? 'checked' : ''}><span>${f}</span></label>`,
      ).join('')}</div></div>
      <label class="field grow"><span>Allowed estimates</span><input name="allowed_estimates" value="${esc(est.join(', '))}" placeholder="1, 2, 3, 5, 8 (empty: any)"></label>
      <label class="field"><span>Flag claims idle for (hours)</span><input name="stale_claim_hours" type="number" min="0" step="any" value="${esc(project.stale_claim_hours ?? 24)}"></label>
    </div>
  </details>`;
}

function repoSettingsHtml(project) {
  return `<details class="settings-group" ${project.repo_path ? 'open' : ''}>
    <summary>Repository</summary>
    <p class="muted small">The project's git checkout, read-only. With it, submits are checked against git (commit exists, files changed,
      protected paths, task scope) and briefings warn when context docs changed after a task was written.</p>
    <div class="setting-row">
      <label class="field grow"><span>Repo path (absolute)</span><input name="repo_path" value="${esc(project.repo_path ?? '')}" placeholder="/Users/you/Developer/my-game" spellcheck="false"></label>
      <label class="field"><span>Base branch</span><input name="base_branch" value="${esc(project.base_branch ?? '')}" placeholder="main" spellcheck="false"></label>
      <button type="button" class="btn" data-action="check-repo">Check</button>
    </div>
    <div class="repo-status small"></div>
  </details>`;
}

async function importGlossary(form, project) {
  const markdown = $('[data-import="markdown"]', form).value.trim();
  const path = $('[data-import="path"]', form)?.value.trim();
  if (!markdown && !path) return toast('Paste the glossary first', 'error');
  const body = markdown ? { markdown } : { path };
  const updated = await attempt(api(`/api/projects/${project.key}/glossary/import`, { method: 'POST', body }));
  if (!updated) return;
  toast(`Imported ${updated.imported} glossary terms`);
  await loadProjects();
  const group = $('[data-rows="glossary"]', form);
  $('.rows', group).innerHTML = updated.glossary.map((g) => settingRowHtml(SETTING_EDITORS.glossary, g)).join('');
  $('[data-import="markdown"]', form).value = '';
  project.glossary = updated.glossary;
}

async function checkRepo(form, key) {
  const out = $('.repo-status', form);
  const value = form.elements.repo_path.value.trim();
  if (!value) {
    out.innerHTML = '';
    return;
  }
  out.textContent = 'Checking…';
  const res = await attempt(api(`/api/projects/${key}/repo?path=${encodeURIComponent(value)}`));
  if (!res) return;
  out.innerHTML = res.ok
    ? `<span class="ok">${icon('check', { size: 14 })} Git repo.</span> ${esc(res.base)} is at ${copyCode(res.base_head?.sha ?? '', (res.base_head?.sha ?? '').slice(0, 8))} “${esc(res.base_head?.subject ?? '')}”`
    : `<span class="bad">${icon('x', { size: 14 })} ${esc(res.error)}</span>`;
}

function collectSettings(form) {
  const out = {};
  for (const group of $$('[data-rows]', form)) {
    out[group.dataset.rows] = $$('.setting-row', group)
      .map((rowEl) => {
        const row = {};
        let filled = false;
        for (const input of $$('[data-col]', rowEl)) {
          const type = input.dataset.type;
          let value;
          if (type === 'checkbox') value = input.checked;
          else if (type === 'list') value = splitList(input.value);
          else if (type === 'number') value = input.value === '' ? undefined : Number(input.value);
          else value = input.value.trim() || undefined;
          if (value === undefined || (Array.isArray(value) && !value.length)) continue;
          if (type !== 'checkbox') filled = true;
          setPath(row, input.dataset.col, value);
        }
        return filled ? row : null;
      })
      .filter(Boolean);
  }
  return out;
}

function openProjectModal(project) {
  const editing = Boolean(project);
  openModal(`
    <form class="modal project-modal" data-form="project">
      <div class="modal-head"><h2>${editing ? 'Project settings' : 'New project'}</h2><span class="spacer"></span><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">
        ${projectForm(project)}
        ${
          editing
            ? `<p class="muted small export-line">Snapshot for your repo: <a href="${fileUrl(`/api/projects/${encodeURIComponent(project.key)}/export.md`)}" target="_blank" rel="noopener">board as Markdown</a>
                (read-only; sync tasks back in with <code>POST /api/projects/${esc(project.key)}/import</code> or the MCP <code>import_tasks</code> tool, keyed on External ID).</p>`
            : ''
        }
        ${editing ? `<h3 class="settings-title">Rules for agents</h3>${fieldRulesHtml(project)}${repoSettingsHtml(project)}${settingsEditorsHtml(project)}` : ''}
        <div class="actions">
          ${editing ? '<button type="button" class="btn btn-danger left" data-action="delete-project">Delete project</button>' : ''}
          <button type="button" class="btn" data-close>Cancel</button>
          <button class="btn btn-primary">${editing ? 'Save' : 'Create project'}</button>
        </div>
      </div>
    </form>`);
  const form = $('form', els.modalRoot);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const saved = editing
      ? await attempt(
          api(`/api/projects/${project.key}`, {
            method: 'PATCH',
            body: {
              name: data.name,
              description: data.description,
              agent_brief: data.agent_brief,
              ...collectSettings(form),
              required_fields: $$('[name="required_fields"]:checked', form).map((el) => el.value),
              allowed_estimates: splitList(data.allowed_estimates).map(Number),
              stale_claim_hours: data.stale_claim_hours === '' ? 24 : Number(data.stale_claim_hours),
              // Only re-validate the repo when it changed, so an unreachable path doesn't block other edits.
              ...((data.repo_path.trim() || null) !== project.repo_path && { repo_path: data.repo_path.trim() || null }),
              ...((data.base_branch.trim() || null) !== project.base_branch && { base_branch: data.base_branch.trim() || null }),
            },
          }),
        )
      : await attempt(api('/api/projects', { method: 'POST', body: data }));
    if (!saved) return;
    closeModal();
    await loadProjects();
    await selectProject(saved.key);
  });
  form.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-row') {
      const group = e.target.closest('[data-rows]');
      $('.rows', group).insertAdjacentHTML('beforeend', settingRowHtml(SETTING_EDITORS[group.dataset.rows]));
      $('.rows .setting-row:last-child input', group)?.focus();
    } else if (action === 'remove-row') {
      e.target.closest('.setting-row').remove();
    } else if (action === 'check-repo') {
      checkRepo(form, project.key);
    } else if (action === 'import-glossary') {
      importGlossary(form, project);
    }
  });
  if (project?.repo_path) checkRepo(form, project.key);
  const del = $('[data-action="delete-project"]', form);
  del?.addEventListener('click', () =>
    confirmClick(del, `Delete ${project.key} and all its tasks?`, async () => {
      if (!(await attempt(api(`/api/projects/${project.key}`, { method: 'DELETE' })))) return;
      closeModal();
      state.projectKey = null;
      await loadProjects();
      await applyHash();
      toast(`Deleted project ${project.key}`);
    }),
  );
}

// -------------------------------------------------------------------- board

async function loadBoard() {
  if (!state.projectKey) {
    state.board = null;
    renderBoard();
    return;
  }
  if (!state.board) renderBoard();
  const board = await attempt(api(`/api/projects/${state.projectKey}/board`));
  if (!board) return;
  state.board = board;
  renderFilters();
  if ($('[data-dialog="milestones"]', els.modalRoot) && !state.msEditing) renderMilestonesModal();
  renderReviewCount();
  renderBoard();
  await loadInbox();
  if (state.view === 'plan') await loadPlan();
  if (state.view === 'review') await loadReview();
}

const refreshBoard = debounce(loadBoard, 120);

// ------------------------------------------------------------------ filters

// The filters in the Filters popover. options() returns [] when a filter has nothing to choose from
// on this project or view, and the filter is then hidden.
const FILTERS = [
  { key: 'assignee', label: 'Assignee', options: assigneeFilterOptions },
  { key: 'epic', label: 'Epic', options: epicFilterOptions },
  { key: 'sprint', label: 'Sprint', options: sprintFilterOptions },
  { key: 'milestone', label: 'Milestone', options: milestoneFilterOptions },
  { key: 'flag', label: 'Flag', options: flagFilterOptions },
];

// The popover's menus, one per filter that applies. Values the board no longer has are dropped first.
function renderFilters() {
  const epics = state.board?.epics ?? [];
  const sprints = state.board?.sprints ?? [];
  const milestones = state.board?.milestones ?? [];
  if (state.epic && state.epic !== '__none__' && !epics.some((e) => e.key === state.epic)) state.epic = '';
  if (state.sprint && !['__none__', '__active__'].includes(state.sprint) && !sprints.some((x) => String(x.id) === state.sprint)) state.sprint = '';
  if (state.milestone && state.milestone !== '__none__' && !milestones.some((m) => String(m.id) === state.milestone)) state.milestone = '';
  els.filterFields.innerHTML = FILTERS.map((f) => {
    const options = f.options();
    return options.length
      ? `<div class="field"><span>${esc(f.label)}</span>${menuButton(`filter-${f.key}`, {
          label: f.label,
          options,
          value: state[f.key],
          onChange: (value) => setFilter(f.key, value),
        })}</div>`
      : '';
  }).join('');
  renderFilterState();
}

// The Inbox ignores filters, so it shows neither search nor Filters.
function updateFilterVisibility() {
  els.filters.hidden = !state.projects.length || state.view === 'inbox';
  renderFilterState();
}

// The count on the Filters button and a removable chip per active filter.
function renderFilterState() {
  const active = FILTERS.map((f) => [f.key, f.options(), f.label]).filter(([key, options]) => state[key] && options.length);
  els.filterCount.hidden = !active.length;
  els.filterCount.textContent = active.length ? `· ${active.length}` : '';
  els.filterButton.classList.toggle('active', active.length > 0);
  const chips = active.map(([key, options, label]) => {
    const text = options.find((o) => o.value === state[key])?.label ?? state[key];
    return `<span class="filter-chip">${esc(label)}: <b>${esc(text)}</b><button type="button" class="icon-btn small" data-remove-filter="${key}" aria-label="Remove filter ${esc(label)}: ${esc(text)}">${icon('x', { size: 12 })}</button></span>`;
  });
  els.filterChips.hidden = !chips.length || els.filters.hidden;
  els.filterChips.innerHTML = chips.length ? `${chips.join('')}<button type="button" class="btn btn-ghost small" data-remove-filter="all">Clear all</button>` : '';
}

function setFilter(key, value) {
  state[key] = value;
  renderFilters();
  renderView();
}

function clearFilters() {
  for (const f of FILTERS) state[f.key] = '';
  renderFilters();
  renderView();
}

function setFilterPopover(open) {
  els.filterPopover.hidden = !open;
  els.filterButton.setAttribute('aria-expanded', String(open));
  if (open) $('[data-menu]', els.filterPopover)?.focus();
}

function bindFilters() {
  els.filterButton.addEventListener('click', () => setFilterPopover(els.filterPopover.hidden));
  $('#filter-clear').addEventListener('click', () => {
    clearFilters();
    setFilterPopover(false);
    els.filterButton.focus();
  });
  els.filterPopover.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menuIsOpen()) return;
    e.stopPropagation();
    setFilterPopover(false);
    els.filterButton.focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (!els.filterPopover.hidden && !e.target.closest('.filter-menu, .menu')) setFilterPopover(false);
  });
  // Actions offered by empty states and chips anywhere on the page.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    const action = el?.dataset.action;
    if (action === 'go-board') setView('board');
    else if (action === 'clear-filters') clearFilters();
    else if (action === 'why-blocked') explainBlocked(el.dataset.key);
  });
  // The phone's column switcher jumps to a column; swiping keeps it in step.
  $('#status-switcher')?.addEventListener('click', (e) => {
    const status = e.target.closest('[data-jump]')?.dataset.jump;
    if (status) $(`.column[data-status="${status}"]`, els.board)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  });
  els.board.addEventListener('scroll', debounce(markSwitcher, 60));
  els.filterChips.addEventListener('click', (e) => {
    const key = e.target.closest('[data-remove-filter]')?.dataset.removeFilter;
    if (key === 'all') clearFilters();
    else if (key) setFilter(key, '');
  });
}

function renderView() {
  renderFilterState();
  if (state.view === 'plan') renderPlan();
  else if (state.view === 'review') renderReview();
  else if (state.view === 'inbox') renderInbox();
  else renderBoard();
}

function setView(view) {
  state.view = view;
  store.set('kanban.view', view);
  renderLocation();
  renderStatusSwitcher();
  els.board.hidden = view !== 'board';
  els.plan.hidden = view !== 'plan';
  els.review.hidden = view !== 'review';
  els.inbox.hidden = view !== 'inbox';
  renderFilters();
  updateFilterVisibility();
  if (view === 'plan') loadPlan();
  else if (view === 'review') loadReview();
  else if (view === 'inbox') loadInbox();
  else renderBoard();
}

const epicOf = (key) => state.board?.epics.find((e) => e.key === key);

function epicChip(key) {
  if (!key) return '';
  const epic = epicOf(key);
  return `<span class="epic-chip" style="--hue:${hue(key)}" title="Epic ${esc(key)}">${esc(epic?.title ?? key)}</span>`;
}

function estimateBadge(t) {
  return t.estimate === null || t.estimate === undefined
    ? ''
    : `<span class="estimate" title="${t.estimate} story point${t.estimate === 1 ? '' : 's'}">${t.estimate} pt${t.estimate === 1 ? '' : 's'}</span>`;
}

// At most `max` label chips, then "+N" with every label in its tooltip.
function labelChips(labels, max = 3) {
  if (!labels.length) return '';
  const extra = labels.length - max;
  return `<div class="labels">${labels
    .slice(0, max)
    .map((l) => `<span class="label">${esc(l)}</span>`)
    .join('')}${extra > 0 ? `<span class="label label-more" title="${esc(labels.join(', '))}">+${extra}</span>` : ''}</div>`;
}

// A colored dot for an epic, as menus show it.
const epicDot = (key) => `<span class="epic-dot" style="--hue:${hue(key)}" aria-hidden="true"></span>`;

function epicFilterOptions() {
  const epics = state.board?.epics ?? [];
  if (!epics.length) return [];
  return [
    { value: '', label: 'All epics' },
    { value: '__none__', label: 'No epic' },
    ...epics.map((e) => ({ value: e.key, label: e.title, hint: e.key, icon: epicDot(e.key) })),
  ];
}

function sprintFilterOptions() {
  const sprints = state.board?.sprints ?? [];
  if (!sprints.length || state.view === 'plan') return [];
  return [
    { value: '', label: 'All sprints' },
    ...(sprints.some((x) => x.status === 'active') ? [{ value: '__active__', label: 'Active sprint' }] : []),
    { value: '__none__', label: 'Unscheduled' },
    ...sprints.map((x) => ({ value: String(x.id), label: x.name, hint: x.status === 'completed' ? 'done' : x.status === 'active' ? 'active' : '' })),
  ];
}


// Things worth finding across the board. Options only appear when some task has the flag.
const FLAGS = {
  missing: { label: 'Missing or invalid fields', test: (t) => Boolean(t.missing_fields?.length) },
  waiting: { label: 'Waiting on Director', test: (t) => t.waiting_on_director },
  setup: { label: 'Needs setup', test: (t) => Boolean(t.pending_prerequisites?.length) },
  stale: { label: 'Stale claims', test: (t) => Boolean(t.stale_claim) },
};

function flagFilterOptions() {
  const tasks = (state.board?.columns ?? []).flatMap((c) => c.tasks);
  const present = Object.entries(FLAGS)
    .map(([key, f]) => [key, f, tasks.filter(f.test).length])
    .filter(([key, , n]) => n || key === state.flag);
  if (!present.length) return [];
  return [{ value: '', label: 'All tasks' }, ...present.map(([key, f, n]) => ({ value: key, label: f.label, count: n }))];
}

function matchesFilter(task, { ignoreSprint = false } = {}) {
  if (state.flag && FLAGS[state.flag] && !FLAGS[state.flag].test(task)) return false;
  if (state.epic === '__none__' && task.epic) return false;
  if (state.epic && state.epic !== '__none__' && task.epic !== state.epic) return false;
  if (!ignoreSprint && state.sprint) {
    const active = state.board?.sprints.find((x) => x.status === 'active');
    if (state.sprint === '__none__' && task.sprint_id) return false;
    if (state.sprint === '__active__' && (!active || task.sprint_id !== active.id)) return false;
    if (!['__none__', '__active__'].includes(state.sprint) && String(task.sprint_id) !== state.sprint) return false;
  }
  if (state.milestone === '__none__' && task.milestone_id) return false;
  if (state.milestone && state.milestone !== '__none__' && String(task.milestone_id) !== state.milestone) return false;
  if (state.assignee === '__none__' && task.assignee) return false;
  if (state.assignee && state.assignee !== '__none__' && task.assignee !== state.assignee) return false;
  if (!state.q) return true;
  const hay = `${task.key} ${task.title} ${task.labels.join(' ')} ${task.assignee ?? ''} ${task.type} ${epicOf(task.epic)?.title ?? ''} ${task.sprint ?? ''}`.toLowerCase();
  return state.q
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

function milestoneFilterOptions() {
  const milestones = state.board?.milestones ?? [];
  if (!milestones.length) return [];
  return [
    { value: '', label: 'All milestones' },
    { value: '__none__', label: 'No milestone' },
    ...milestones.map((m) => ({ value: String(m.id), label: m.name, icon: icon('diamond', { size: 14 }), hint: m.status === 'closed' ? 'closed' : '' })),
  ];
}

// Everyone who holds a task on this board (and whoever the filter already names).
function assigneeNames() {
  const names = new Set();
  for (const col of state.board?.columns ?? []) for (const t of col.tasks) if (t.assignee) names.add(t.assignee);
  return names;
}

function assigneeFilterOptions() {
  const names = assigneeNames();
  if (state.assignee && state.assignee !== '__none__') names.add(state.assignee);
  return [
    { value: '', label: 'Everyone' },
    { value: '__none__', label: 'Unassigned', icon: icon('circle-dashed', { size: 16 }) },
    ...[...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n, icon: avatar(n) })),
  ];
}

function renderBoard() {
  // Re-rendering mid-drag would yank the card out from under the pointer.
  if (state.drag) {
    state.renderPending = true;
    return;
  }
  state.renderPending = false;

  if (!state.projects.length) {
    els.board.innerHTML = `
      <div class="empty-state">
        <h2>Create your first project</h2>
        <p>A project is a board. Its key prefixes every task, like <code>GAME-1</code>.</p>
        <form class="modal" data-form="first-project"><div class="modal-body">${projectForm()}
          <div class="actions"><button class="btn btn-primary">Create project</button></div></div></form>
      </div>`;
    const form = $('form', els.board);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saved = await attempt(api('/api/projects', { method: 'POST', body: Object.fromEntries(new FormData(form)) }));
      if (!saved) return;
      await loadProjects();
      await selectProject(saved.key);
    });
    return;
  }
  if (!state.board) {
    els.board.innerHTML = state.projectKey ? skeleton('board') : '';
    return;
  }

  const scroll = Object.fromEntries($$('.cards', els.board).map((el) => [el.dataset.status, el.scrollTop]));
  const cardFocused = Boolean(document.activeElement?.closest?.('.card[data-key]') && els.board.contains(document.activeElement));
  const quickInput = $('.quick-add textarea', els.board);
  const quick = quickInput && {
    status: quickInput.closest('.column').dataset.status,
    value: quickInput.value,
    focused: document.activeElement === quickInput,
  };
  els.board.innerHTML = state.board.columns
    .map((col) => {
      let visible = col.tasks.filter(matchesFilter);
      const count = visible.length === col.tasks.length ? col.tasks.length : `${visible.length}/${col.tasks.length}`;
      // Done is for reference: the most recently completed first, and only the last few unless asked.
      let doneToggle = '';
      if (col.status === 'done') {
        visible = [...visible].sort((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')));
        const all = doneShowsAll();
        if (visible.length > DONE_RECENT) {
          doneToggle = `<button class="add-btn done-toggle" data-action="toggle-done">${
            all ? `Show the ${DONE_RECENT} most recent` : `Show all ${visible.length}`
          }</button>`;
          if (!all) visible = visible.slice(0, DONE_RECENT);
        }
      }
      return `
      <section class="column${col.tasks.length ? '' : ' is-empty'}" data-status="${col.status}">
        <header class="column-head">
          ${statusIcon(col.status, { decorative: true })}
          <h2>${esc(col.name)}</h2>
          <span class="count">${count}</span>
        </header>
        ${
          col.status === 'todo' && state.board.next_up_reasons
            ? `<details class="idle-note"><summary>Nothing here is claimable by an agent. Why?</summary><ul>${state.board.next_up_reasons
                .map((r) => `<li>${taskLink(r.key)}: ${esc(r.why)}</li>`)
                .join('')}</ul></details>`
            : ''
        }
        <div class="cards" data-status="${col.status}">
          ${
            visible.map(cardHtml).join('') ||
            (col.tasks.length
              ? '<div class="empty-col">No tasks match the filters</div>'
              : `<div class="empty-col">${statusIcon(col.status, { decorative: true, size: 16 })}<span>No tasks in ${esc(col.name)}</span>
                  <button type="button" class="btn btn-ghost small" data-action="quick-add">${icon('plus', { size: 14 })}Add a task</button></div>`)
          }
          ${doneToggle}
        </div>
        <div class="column-foot"><button class="add-btn" data-action="quick-add">${icon('plus', { size: 14 })}Add task</button></div>
      </section>`;
    })
    .join('');
  for (const el of $$('.cards', els.board)) el.scrollTop = scroll[el.dataset.status] ?? 0;
  if (quick) openQuickAdd($(`.column[data-status="${quick.status}"]`, els.board), quick);
  for (const key of state.flash) $(`.card[data-key="${key}"]`, els.board)?.classList.add('flash');
  state.flash.clear();
  renderStatusSwitcher();
  markSelection({ refocus: cardFocused });
}

// "missing epic" / "estimate 4 not allowed": an estimate outside allowed_estimates counts as missing.
function missingLabel(t) {
  const bad = t.missing_fields.includes('estimate') && t.estimate !== null;
  const rest = t.missing_fields.filter((f) => !(bad && f === 'estimate'));
  return [bad && `estimate ${t.estimate} not allowed`, rest.length && `missing ${rest.join(', ')}`].filter(Boolean).join(' · ');
}

const DONE_RECENT = 10;
const doneShowsAll = () => store.get(`kanban.doneAll.${state.projectKey}`, '0') === '1';

// A finished task, for reference: key, title and who did it.
function doneCardHtml(t) {
  return `
    <article class="card card-done" draggable="true" tabindex="0" data-key="${esc(t.key)}">
      <div class="card-top"><span class="key">${esc(t.key)}</span><span class="spacer"></span>${
        t.assignee ? `<span class="who">${avatar(t.assignee)}${esc(t.assignee)}</span>` : ''
      }</div>
      <div class="card-title">${esc(t.title)}</div>
    </article>`;
}

function cardHtml(t) {
  if (t.status === 'done') return doneCardHtml(t);
  const labels = labelChips(t.labels);
  // An unclaimed card in Backlog or To Do is the normal case; elsewhere it's worth pointing out.
  const assignee = t.assignee
    ? `<span class="who">${avatar(t.assignee)}${esc(t.assignee)}</span>`
    : ['backlog', 'todo'].includes(t.status)
      ? ''
      : '<span class="unassigned">unassigned</span>';
  return `
    <article class="card${t.key === state.board?.next_up ? ' is-next' : ''}${quietCard(t) ? ' is-quiet' : ''}" draggable="true" tabindex="0" data-key="${esc(t.key)}"${
      cardEdge(t) ? ` data-edge="${cardEdge(t)}"` : ''
    }>
      <div class="card-top">
        ${statusIcon(t.status)}
        <span class="key">${esc(t.key)}</span>
        <span class="type type-${t.type}">${esc(t.type)}</span>
        ${t.external_id ? `<span class="ext-id" title="External ID">${esc(t.external_id)}</span>` : ''}
        ${priorityBadge(t.priority, { withName: true })}
        ${estimateBadge(t)}
      </div>
      <div class="card-title">${esc(t.title)}</div>
      ${t.epic ? `<div>${epicChip(t.epic)}</div>` : ''}
      ${labels}
      <div class="card-foot">
        ${blockedChips(t)}
        ${t.rework ? '<span class="chip-rework" title="Review sent this back; it goes to its agent first">rework</span>' : ''}
        ${t.stale_claim ? `<span class="chip-stale" title="No activity for ${esc(t.stale_claim.idle)} (since ${esc(fullDate(t.stale_claim.since))}). The claim is kept.">stale ${esc(t.stale_claim.idle)}</span>` : ''}
        ${t.waiting_on_director ? '<span class="chip-waiting" title="An agent asked you a question; open the task to answer">Waiting on Director</span>' : ''}
        ${t.missing_fields?.length ? `<span class="chip-missing" title="The project requires these fields">${esc(missingLabel(t))}</span>` : ''}
        ${criteriaBadge(t)}
        ${t.comment_count ? `<span class="meta" title="${t.comment_count} comments">${icon('message-square', { size: 14 })}${t.comment_count}</span>` : ''}
        ${t.attachment_count ? `<span class="meta" title="${t.attachment_count} attachments">${icon('paperclip', { size: 14 })}${t.attachment_count}</span>` : ''}
        ${t.key === state.board?.next_up ? '<span class="next-up" title="claim_next_task will hand this to the next agent">Next up</span>' : ''}
        ${t.milestone ? `<span class="meta ms-chip" title="Milestone">${icon('diamond', { size: 14 })}${esc(t.milestone)}</span>` : ''}
        ${t.parent ? `<span class="meta" title="Subtask of ${esc(t.parent)}">${icon('corner-down-right', { size: 14 })}${esc(t.parent)}</span>` : ''}
        <span class="spacer"></span>
        ${assignee}
      </div>
    </article>`;
}

// Dependency-blocked (waiting on other tasks) vs waiting on the human's setup steps.
// Buttons, so a tap (not just hover) says what the task waits on.
function blockedChips(t) {
  const deps = t.blocked_by ?? [];
  const setup = t.pending_prerequisites ?? [];
  return (
    (deps.length
      ? `<button type="button" class="chip-blocked" data-action="why-blocked" data-key="${esc(t.key)}" title="Waiting on ${esc(deps.join(', '))}">blocked</button>`
      : '') +
    (setup.length
      ? `<button type="button" class="chip-setup" data-action="why-blocked" data-key="${esc(t.key)}" title="Waiting on your prerequisites:\n${esc(
          setup.map((p) => `• ${p}`).join('\n'),
        )}">needs setup · ${setup.length}</button>`
      : '')
  );
}

// What a task waits on, as a toast: its unfinished dependencies (with their status) and your setup steps.
function explainBlocked(key) {
  const t = anyTask(key);
  if (!t) return;
  const deps = (t.blocked_by ?? []).map((k) => `${k} (${STATUS_NAMES[findTask(k)?.status] ?? 'not done'})`);
  const setup = t.pending_prerequisites ?? [];
  const parts = [deps.length && `waits on ${deps.join(', ')}`, setup.length && `needs your setup: ${setup.join('; ')}`].filter(Boolean);
  toast(`${key} ${parts.join(' and ')}.`);
}

// The phone's column switcher: one button per column with its count; the current column is marked.
function renderStatusSwitcher() {
  const switcher = $('#status-switcher');
  if (!switcher) return;
  switcher.hidden = state.view !== 'board' || !state.board;
  if (switcher.hidden) return;
  switcher.innerHTML = state.board.columns
    .map(
      (col) => `<button type="button" data-jump="${col.status}">${statusIcon(col.status, { decorative: true })}${esc(col.name)}<span class="nav-count">${
        col.tasks.filter(matchesFilter).length
      }</span></button>`,
    )
    .join('');
  markSwitcher();
}

function markSwitcher() {
  const columns = $$('.column[data-status]', els.board);
  const left = els.board.scrollLeft;
  // Scrolled to the end, the last column is current even when it is too narrow to reach the left edge.
  const atEnd = left > 0 && left + els.board.clientWidth >= els.board.scrollWidth - 2;
  const current = atEnd
    ? columns.at(-1)
    : columns.reduce((best, c) => (Math.abs(c.offsetLeft - els.board.offsetLeft - left) < Math.abs(best.offsetLeft - els.board.offsetLeft - left) ? c : best), columns[0]);
  for (const b of $$('[data-jump]', $('#status-switcher'))) {
    if (b.dataset.jump === current?.dataset.status) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
}

function criteriaBadge(t) {
  if (!t.criteria?.length) return '';
  const done = t.criteria.filter((c) => c.done).length;
  const all = done === t.criteria.length;
  return `<span class="meta criteria-badge${all ? ' all' : ''}" title="Acceptance criteria met">${icon('square-check-big', { size: 14 })}${done}/${t.criteria.length}</span>`;
}

function renderReviewCount() {
  const n = state.board?.columns.find((c) => c.status === 'review')?.tasks.length ?? 0;
  els.reviewCount.hidden = n === 0;
  els.reviewCount.textContent = n;
}

function findTask(key) {
  for (const col of state.board?.columns ?? []) {
    const task = col.tasks.find((t) => t.key === key);
    if (task) return task;
  }
  return null;
}

// ------------------------------------------------------------ drag and drop

let placeholder = null;

function clearDragUi() {
  placeholder?.remove();
  placeholder = null;
  for (const el of $$('.drop-target', els.board)) el.classList.remove('drop-target');
}

function cardBelow(list, y) {
  return $$('.card:not(.dragging)', list).find((card) => {
    const rect = card.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
}

function bindBoard() {
  els.board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    state.drag = { key: card.dataset.key };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.key);
    requestAnimationFrame(() => card.classList.add('dragging'));
  });

  els.board.addEventListener('dragend', () => {
    clearDragUi();
    state.drag = null;
    renderBoard();
  });

  els.board.addEventListener('dragover', (e) => {
    const column = e.target.closest('.column');
    if (!column || !state.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const list = $('.cards', column);
    if (!column.classList.contains('drop-target')) {
      for (const el of $$('.drop-target', els.board)) el.classList.remove('drop-target');
      column.classList.add('drop-target');
    }
    placeholder ??= Object.assign(document.createElement('div'), { className: 'placeholder' });
    $('.empty-col', list)?.remove();
    const below = cardBelow(list, e.clientY);
    if (below) {
      if (placeholder.nextElementSibling !== below) list.insertBefore(placeholder, below);
    } else if (list.lastElementChild !== placeholder) {
      list.append(placeholder);
    }
  });

  els.board.addEventListener('drop', async (e) => {
    const column = e.target.closest('.column');
    if (!column || !state.drag || !placeholder) return;
    e.preventDefault();
    const key = state.drag.key;
    const status = column.dataset.status;
    let next = placeholder.nextElementSibling;
    while (next && !next.classList.contains('card')) next = next.nextElementSibling;
    const target = state.board.columns.find((c) => c.status === status).tasks.filter((t) => t.key !== key);
    const index = next ? target.findIndex((t) => t.key === next.dataset.key) : target.length;
    clearDragUi();
    state.drag = null;
    await moveTask(key, status, index);
  });

  els.board.addEventListener('click', (e) => {
    const add = e.target.closest('[data-action="quick-add"]');
    if (add) return openQuickAdd(add.closest('.column'));
    if (e.target.closest('[data-action="toggle-done"]')) {
      store.set(`kanban.doneAll.${state.projectKey}`, doneShowsAll() ? '0' : '1');
      return renderBoard();
    }
    const card = e.target.closest('.card');
    if (card && !e.target.closest('a, [data-action]')) openTask(card.dataset.key);
  });

  els.board.addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (card && e.key === 'Enter') openTask(card.dataset.key);
  });
}

async function moveTask(key, status, index, { undoable = true, priority } = {}) {
  // Optimistic: reflect the move immediately, then let the server confirm.
  const task = findTask(key);
  if (!task) return;
  const from = {
    status: task.status,
    index: state.board.columns.find((c) => c.status === task.status).tasks.findIndex((t) => t.key === key),
    priority: task.priority,
  };
  for (const col of state.board.columns) col.tasks = col.tasks.filter((t) => t.key !== key);
  const col = state.board.columns.find((c) => c.status === status);
  col.tasks.splice(index, 0, { ...task, status, ...(priority && { priority }) });
  renderBoard();
  // The server fits the priority to the new neighbours, so an undo puts the old priority back
  // first: back at its old index it fits again, and the move keeps both the priority and the slot.
  // (A priority-only PATCH after the move would send the card to the bottom of its level.)
  const restored =
    priority === undefined || priority === task.priority || (await attempt(api(`/api/tasks/${key}`, { method: 'PATCH', body: { priority } })));
  const moved = restored && (await attempt(api(`/api/tasks/${key}/move`, { method: 'POST', body: { status, index } })));
  await loadBoard();
  if (moved && undoable && from.status !== status) {
    toast(`Moved ${key} to ${STATUS_NAMES[status]}`, '', {
      action: { label: 'Undo', run: () => moveTask(key, from.status, from.index, { undoable: false, priority: from.priority }) },
    });
  }
}

function openQuickAdd(column, { value = '', focused = true } = {}) {
  const foot = $('.column-foot', column);
  const status = column.dataset.status;
  foot.innerHTML = `<div class="quick-add"><textarea placeholder="Task title" aria-label="New task title"></textarea>
    <div class="hint">Enter to add · Shift+Enter for another line · Esc to close</div></div>`;
  const input = $('textarea', foot);
  input.value = value;
  if (focused) input.focus();
  const close = () => {
    foot.innerHTML = `<button class="add-btn" data-action="quick-add">${icon('plus', { size: 14 })}Add task</button>`;
  };
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      const created = await attempt(api('/api/tasks', { method: 'POST', body: { project: state.projectKey, title, status } }));
      if (created) state.flash.add(created.key);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => input.isConnected && !input.value.trim() && close(), 150));
}

// ---------------------------------------------------------------- task modal

function openModal(html) {
  els.modalRoot.innerHTML = `<div class="overlay">${html}</div>`;
  const overlay = $('.overlay', els.modalRoot);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });
  $('[autofocus]', overlay)?.focus();
}

function closeModal() {
  const wasOpen = Boolean(els.modalRoot.firstChild);
  els.modalRoot.innerHTML = '';
  if (wasOpen) markSelection({ refocus: true });
  state.msEditing = null;
  if (state.task) {
    state.task = null;
    state.descEditing = false;
    setHash();
  }
}

async function openTask(key) {
  const task = await attempt(api(`/api/tasks/${encodeURIComponent(key)}`));
  if (!task) return;
  if (task.project !== state.projectKey) await selectProject(task.project);
  const isNew = state.task?.key !== task.key;
  state.task = task;
  rememberTask(task.key);
  if (isNew) {
    state.descEditing = false;
    state.propError = null;
    state.openSections = new Set();
  }
  renderTaskModal(isNew);
  setHash();
}

async function refreshTask({ force = false } = {}) {
  if (!state.task) return;
  const modal = $('.task-modal', els.modalRoot);
  const editingField = document.activeElement?.matches('input, textarea, select') && modal?.contains(document.activeElement);
  const busy = state.descEditing || $('.comment-form textarea', modal)?.value || $('.question-form textarea[name="answer"]', modal)?.value || editingField;
  if (busy && !force) {
    state.taskStale = true;
    return;
  }
  state.taskStale = false;
  const task = await api(`/api/tasks/${state.task.key}`).catch(() => null);
  if (!task) {
    closeModal();
    return;
  }
  if (!state.task || state.task.key !== task.key) return;
  state.task = task;
  renderTaskModal(false);
}

function describeChanges(changes = {}) {
  return describeChangeList(changes).join(', ');
}

// One phrase per changed field ("set priority to high", "renamed to …").
function describeChangeList(changes = {}) {
  const parts = [];
  for (const [field, value] of Object.entries(changes)) {
    const [from, to] = Array.isArray(value) ? value : [];
    if (field === 'status') parts.push(`moved ${statusPill(from)} ${icon('arrow-right', { size: 12, cls: 'arrow' })} ${statusPill(to)}`);
    else if (field === 'assignee') parts.push(to ? `assigned to <b>${esc(to)}</b>` : `unassigned${from ? ` <b>${esc(from)}</b>` : ''}`);
    else if (field === 'description') parts.push('edited the description');
    else if (field === 'title') parts.push(`renamed to “${esc(to)}”`);
    else if (field === 'labels') parts.push(`set labels to ${to.length ? to.map(esc).join(', ') : 'none'}`);
    else if (field === 'depends_on') parts.push(to.length ? `set dependencies to ${to.map(taskLink).join(', ')}` : 'cleared dependencies');
    else if (field === 'parent') parts.push(to ? `set parent to ${taskLink(to)}` : 'removed the parent');
    else if (field === 'milestone') parts.push(to ? `added to milestone <b>${esc(to)}</b>` : `removed from milestone${from ? ` <b>${esc(from)}</b>` : ''}`);
    else if (field === 'priority') parts.push(`set priority to ${priorityBadge(to, { withName: true })}`);
    else if (field === 'due_date') parts.push(to ? `set the due date to ${esc(to)}` : 'cleared the due date');
    else if (field === 'epic') parts.push(to ? `moved into epic ${epicChip(to)}` : 'removed from its epic');
    else if (field === 'sprint') parts.push(to ? `scheduled in <b>${esc(to)}</b>` : `unscheduled${from ? ` from <b>${esc(from)}</b>` : ''}`);
    else if (field === 'estimate') parts.push(to === null ? 'cleared the estimate' : `estimated at <b>${esc(to)} pts</b>`);
    else if (field === 'start_date' || field === 'end_date') parts.push(`set ${field === 'start_date' ? 'start' : 'end'} to ${esc(to ?? 'none')}`);
    else if (field === 'goal') parts.push('edited the goal');
    else if (field === 'criteria') parts.push(`updated acceptance criteria (${esc(to)} met)`);
    else if (field === 'prerequisites') parts.push(`updated prerequisites (${esc(to)} done)`);
    else if (field === 'checkpoint') parts.push(to === 'set' ? 'set the resume note' : 'cleared the resume note');
    else if (field === 'external_id') parts.push(to ? `set the external ID to <b>${esc(to)}</b>` : 'cleared the external ID');
    else if (field === 'scope') parts.push(to.length ? `set scope to ${to.map((g) => `<code>${esc(g)}</code>`).join(', ')}` : 'cleared the scope');
    else if (field === 'context') parts.push(to.length ? `set context to ${to.map((r) => `<code>${esc(r)}</code>`).join(', ')}` : 'cleared the context');
    else parts.push(`set ${esc(field)} to <b>${esc(to)}</b>`);
  }
  return parts;
}

// A disclosure that stays open across re-renders (see bindDisclosures).
const keptOpen = (id) => `data-open-id="${id}"${state.changesOpen.has(id) ? ' open' : ''}`;

function describeActivity(a, { withTask = true, where = 'feed' } = {}) {
  const task = withTask && a.task ? ` ${taskLink(a.task)}` : '';
  switch (a.action) {
    case 'created':
      return `created${task}${withTask ? ` “${esc(a.detail.title)}”` : ''}`;
    case 'updated': {
      // A long run of changes reads as a count, with the list behind a disclosure.
      const parts = describeChangeList(a.detail.changes);
      if (parts.length <= 2) return `${parts.join(', ')}${task ? ` on${task}` : ''}`;
      return `edited ${parts.length} fields${task ? ` on${task}` : ''}
        <details class="change-list" ${keptOpen(`${where}-${a.id}`)}><summary>Show changes</summary><ul>${parts.map((p) => `<li>${p}</li>`).join('')}</ul></details>`;
    }
    case 'claimed':
      return `claimed${task}${a.detail.changes?.status ? ` · ${statusPill(a.detail.changes.status[1])}` : ''}`;
    case 'resumed':
      return `picked back up${task}`;
    case 'released':
      return `released${task}${a.detail.changes?.status ? ` · ${statusPill(a.detail.changes.status[1])}` : ''}${
        a.detail.checkpoint ? ` with a resume note: “${esc(a.detail.checkpoint.slice(0, 160))}”` : ''
      }`;
    case 'commented':
      return `commented${task ? ` on${task}` : ''}: “${esc(a.detail.excerpt)}”`;
    case 'deleted':
      return `deleted <span class="task-link">${esc(a.task)}</span> “${esc(a.detail.title)}”`;
    case 'project_created':
      return `created project “${esc(a.detail.name)}”`;
    case 'sprint_created':
      return `created sprint <b>${esc(a.detail.name)}</b>`;
    case 'sprint_started':
      return `started sprint <b>${esc(a.detail.name)}</b>`;
    case 'sprint_completed':
      return `completed sprint <b>${esc(a.detail.name)}</b>${
        a.detail.carried_over?.length ? ` · ${a.detail.carried_over.length} open moved to ${a.detail.carried_to ? esc(a.detail.carried_to) : 'unscheduled'}` : ''
      }`;
    case 'sprint_updated':
      return `updated sprint <b>${esc(a.detail.name)}</b>: ${describeChanges(a.detail.changes)}`;
    case 'sprint_deleted':
      return `deleted sprint <b>${esc(a.detail.name)}</b>`;
    case 'milestone_created':
      return `created milestone <b>${esc(a.detail.name)}</b>`;
    case 'milestone_updated':
      return `updated milestone <b>${esc(a.detail.name)}</b>: ${describeChanges(a.detail.changes)}`;
    case 'milestone_deleted':
      return `deleted milestone <b>${esc(a.detail.name)}</b>`;
    case 'project_updated':
      return a.detail.brief ? 'updated the agent brief' : 'updated project settings';
    case 'submitted':
      return `submitted${task} for review${a.detail.round > 1 ? ` (round ${a.detail.round})` : ''}: “${esc(a.detail.summary?.slice(0, 160))}”`;
    case 'reviewed':
      return a.detail.verdict === 'accepted'
        ? `accepted${task} ${statusPill('done')}`
        : `requested changes${task ? ` on${task}` : ''}: “${esc(a.detail.feedback?.slice(0, 160))}”`;
    case 'criteria_checked':
      return `${a.detail.done ? 'checked' : 'unchecked'} ${a.detail.items
        .map((i, n) => `“${esc(i)}”${a.detail.evidence?.[n] ? ` <span class="muted">(${esc(a.detail.evidence[n])})</span>` : ''}`)
        .join(', ')}${task ? ` on${task}` : ''} · ${esc(a.detail.progress)}`;
    case 'checkpoint_set':
      return `left a resume note${task ? ` on${task}` : ''}: “${esc(a.detail.excerpt)}”`;
    case 'imported':
      return `imported tasks: ${a.detail.created} created, ${a.detail.updated} updated, ${a.detail.unchanged} unchanged`;
    case 'context_rechecked':
      return `re-checked the context docs${task ? ` of${task}` : ''}`;
    case 'prerequisites_checked':
      return `${a.detail.done ? 'ticked' : 'unticked'} prerequisite ${a.detail.items.map((i) => `“${esc(i)}”`).join(', ')}${task ? ` on${task}` : ''} · ${esc(a.detail.progress)}`;
    case 'asked':
      return `asked the Director${task ? ` on${task}` : ''}${a.detail.blocking ? ' (blocking)' : ''}: “${esc(a.detail.question?.slice(0, 160))}”`;
    case 'answered':
      return `answered${task ? ` on${task}` : ''}: “${esc(a.detail.answer?.slice(0, 160))}”${a.detail.decision ? ` · recorded <b>${esc(a.detail.decision)}</b>` : ''}`;
    case 'decision_recorded':
      return `recorded decision <b>${esc(a.detail.id)}</b> “${esc(a.detail.title)}”${task ? ` from${task}` : ''}`;
    case 'attached':
      return `attached <b>${esc(a.detail.filename)}</b>${task ? ` to${task}` : ''}`;
    case 'attachment_deleted':
      return `removed attachment <b>${esc(a.detail.filename)}</b>${task ? ` from${task}` : ''}`;
    default:
      return esc(a.action);
  }
}

// The task view's property menus. Each saves on pick.
function taskMenu(field, label, options, value, extra = {}) {
  return menuButton(`task-${field}`, {
    label,
    options,
    value,
    onChange: (v) => patchTask({ [field]: extra.toValue ? extra.toValue(v) : v === '' ? null : v }),
    ...extra,
  });
}

const typeDot = (type) => `<span class="type type-${esc(type)}" aria-hidden="true"></span>`;

function epicMenuOptions() {
  return [{ value: '', label: 'None' }, ...(state.board?.epics ?? []).map((e) => ({ value: e.key, label: e.title, hint: e.key, icon: epicDot(e.key) }))];
}

function sprintMenuOptions(task) {
  const sprints = (state.board?.sprints ?? []).filter((x) => x.status !== 'completed' || x.id === task.sprint_id);
  return [
    { value: '', label: 'Unscheduled' },
    ...sprints.map((x) => ({ value: String(x.id), label: x.name, hint: x.status === 'active' ? 'active' : x.status === 'completed' ? 'done' : '' })),
  ];
}

function milestoneMenuOptions(task) {
  const milestones = (state.board?.milestones ?? []).filter((m) => m.status === 'open' || m.id === task.milestone_id);
  return [{ value: '', label: 'None' }, ...milestones.map((m) => ({ value: m.name, label: m.name, icon: icon('diamond', { size: 14 }) }))];
}

// People to assign: the board's assignees, you, and the task's current holder. Typing a new name adds it.
function assigneeMenuOptions(task) {
  const names = assigneeNames();
  names.add(state.me);
  if (task.assignee) names.add(task.assignee);
  return [
    { value: '', label: 'Unassigned', icon: icon('circle-dashed', { size: 16 }) },
    ...[...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n, icon: avatar(n), hint: n === state.me ? 'you' : '' })),
  ];
}

// Every label used on the board, plus the task's own.
function labelMenuOptions(task) {
  const labels = new Set(task.labels);
  for (const col of state.board?.columns ?? []) for (const t of col.tasks) for (const l of t.labels) labels.add(l);
  return [...labels].sort((a, b) => a.localeCompare(b)).map((l) => ({ value: l, label: l }));
}

function relatedList(title, items) {
  if (!items.length) return '';
  return `<div class="related-group"><h4>${title}</h4><ul class="related">
    ${items
      .map(
        (r) => `<li>${taskLink(r.key)}<span class="title">${esc(r.title)}</span>${
          r.assignee ? avatar(r.assignee) : ''
        }${statusPill(r.status)}</li>`,
      )
      .join('')}</ul></div>`;
}

// ------------------------------------------- criteria, context, handoff, files

const IMAGE_RE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

function copyCode(value, shown = value) {
  return `<code class="copyable" data-copy="${esc(value)}" title="Click to copy">${esc(shown)}</code>`;
}

const directorBadge = '<span class="owner-badge" title="Only the Director (you) can tick this">Director</span>';

// editable: full editing (task dialog). checkable: only Director items can be ticked (Review view).
function criteriaHtml(t, { editable = false, checkable = false, only } = {}) {
  const items = t.criteria
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !only || c.owner === only)
    .map(({ c, i }) => {
      const human = c.owner === 'human';
      const canTick = editable || (checkable && human);
      return `<li class="${c.done ? 'done' : ''}${human ? ' human' : ''}">
        <label>${
          canTick
            ? `<input type="checkbox" data-criterion="${i}" ${c.done ? 'checked' : ''}>`
            : `<span class="crit-mark" role="img" aria-label="${c.done ? 'Met' : 'Not met'}">${c.done ? icon('circle-check', { size: 14 }) : icon('circle', { size: 14 })}</span>`
        }<span>${inline(esc(c.text))}</span></label>
        ${human ? directorBadge : ''}
        ${
          editable
            ? `<button class="icon-btn small owner-toggle" data-action="toggle-owner" data-index="${i}" title="${
                human ? 'Director item: click to let agents tick it' : 'Click to make this a Director item only you can tick'
              }" aria-label="${human ? 'Director item: let agents tick it' : 'Agent item: make it a Director item'}">${human ? icon('user', { size: 14 }) : icon('bot', { size: 14 })}</button>
               <button class="icon-btn small" data-action="remove-item" data-list="criteria" data-index="${i}" aria-label="Remove criterion">${icon('x', { size: 14 })}</button>`
            : ''
        }
        ${c.evidence ? `<div class="evidence" title="Evidence">${icon('check', { size: 12 })}<span class="evidence-label">evidence:</span> ${inline(esc(c.evidence))}</div>` : ''}
      </li>`;
    })
    .join('');
  return `<ul class="checklist">${items}</ul>`;
}

const hasChecklist = (description) => /^\s*[-*+]\s+\[[ xX]\]\s+\S/m.test(description ?? '');

function refHtml(ref) {
  if (/^https?:\/\//.test(ref)) return `<a href="${esc(ref)}" target="_blank" rel="noopener">${esc(ref)}</a>`;
  if (TASK_KEY_RE.test(ref)) return taskLink(ref);
  return copyCode(ref);
}

// A context path that doesn't exist on the base branch (the server sends missing_context with a repo).
function missingContextChip(t, ref) {
  const path = ref.split(/[\s#]/)[0].replace(/^\.\//, '');
  if (!t.missing_context?.includes(path)) return '';
  const base = t.repo?.base_branch ?? 'main';
  return `<span class="ref-id dangling" title="${esc(path)} doesn't exist on ${esc(base)} yet; fine if an earlier task creates it">not on ${esc(base)}</span>`;
}

// Where agents work and what they may not touch, when the project has a repo_path.
function repoInfoHtml(t) {
  const rows = [];
  if (t.repo) {
    rows.push(`<dt>Repo</dt><dd>${copyCode(t.repo.path)}<span class="muted"> · ${esc(t.repo.base_branch ?? 'main')}${
      t.repo.head ? ` @ ${copyCode(t.repo.head)}` : ''
    }</span></dd>`);
  }
  if (t.protected_paths?.length) {
    rows.push(`<dt>Protected</dt><dd><ul class="protected-list">${t.protected_paths
      .map(
        (p) => `<li>${p.unlocked ? icon('lock-open', { size: 12 }) : icon('lock', { size: 12 })}${copyCode(p.glob)}${
          p.unlocked ? ` <span class="muted">unlocked by ${esc(p.unlock_label)}</span>` : p.unlock_label ? ` <span class="muted">needs ${esc(p.unlock_label)}</span>` : ''
        }</li>`,
      )
      .join('')}</ul></dd>`);
  }
  return rows.length ? `<dl class="repo-info">${rows.join('')}</dl>` : '';
}

function listSection({ list, title, items, placeholder }) {
  return `
    <section>
      <div class="section-head"><h3>${title}</h3></div>
      ${items}
      <input class="list-add" data-add="${list}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" maxlength="500">
    </section>`;
}

const attachmentId = (ref) => /^\/api\/attachments\/(\d+)(?:[?#]|$)/.exec(ref)?.[1] ?? null;

// Attachment ids a handoff shows in its media, so the Attachments list doesn't show them again.
const handoffMediaIds = (t) => new Set((t.handoff?.media ?? []).map(attachmentId).filter(Boolean));

// One attachment by its MIME type: images and videos as thumbnails with a caption, anything else as a chip.
function attachmentHtml(a, { removable = false } = {}) {
  const url = fileUrl(a.url);
  const remove = removable
    ? `<button class="icon-btn small" data-action="remove-attachment" aria-label="Remove ${esc(a.filename)}">${icon('x', { size: 14 })}</button>`
    : '';
  if (!a.mime.startsWith('image/') && !a.mime.startsWith('video/')) {
    return `<figure class="attachment attachment-file" data-id="${a.id}">${fileChip(url, a.filename, remove)}</figure>`;
  }
  const body = a.mime.startsWith('image/') ? imageHtml(url, a.filename) : `<video src="${esc(url)}" controls preload="metadata"></video>`;
  return `<figure class="attachment" data-id="${a.id}">${body}
    <figcaption><span title="${esc(a.filename)}">${esc(a.filename)}</span>${remove}</figcaption></figure>`;
}

// A handoff media entry: an attachment of this task (rendered by type), another image, or a reference.
function mediaHtml(ref, files = []) {
  const id = attachmentId(ref);
  if (id) {
    const a = files.find((f) => String(f.id) === id);
    return a ? attachmentHtml(a) : `<figure class="attachment">${imageHtml(fileUrl(ref), `attachment ${id}`)}</figure>`;
  }
  if (/^https?:\/\//.test(ref) && IMAGE_RE.test(ref)) return `<figure class="attachment">${imageHtml(ref, ref.split('/').pop())}</figure>`;
  return `<span class="media-ref">${refHtml(ref)}</span>`;
}

function attachmentsHtml(files, { removable }) {
  if (!files.length) return '';
  return `<div class="gallery">${files.map((a) => attachmentHtml(a, { removable })).join('')}</div>`;
}

// Activity and History re-render on every server event; disclosures the Director opened stay open.
function bindDisclosures() {
  document.addEventListener(
    'toggle',
    (e) => {
      const id = e.target.dataset?.openId;
      if (id) e.target.open ? state.changesOpen.add(id) : state.changesOpen.delete(id);
    },
    true,
  );
}

// Images that fail to load (deleted, not an image after all) turn into file chips instead of empty boxes.
function bindImageFallback() {
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || img.dataset.fallback === undefined) return;
      const link = img.closest('a.thumb') ?? img;
      const figure = link.closest('.attachment');
      figure?.querySelector('figcaption')?.remove();
      figure?.classList.add('attachment-file');
      link.outerHTML = fileChip(img.getAttribute('src'), img.dataset.fallback);
    },
    true,
  );
}

// Reported checks as pass/fail pills (click one for its output), and anything submit warned about.
function checkPillsHtml(h) {
  const pills = (h.checks ?? [])
    .map(
      (c) => `<details class="check-pill ${c.passed ? 'pass' : 'fail'}"><summary>${icon(c.passed ? 'check' : 'x', { size: 12, label: c.passed ? 'Passed' : 'Failed' })}${esc(c.name)}</summary>${
        c.output_tail ? `<pre>${esc(c.output_tail)}</pre>` : '<p class="muted small">No output attached.</p>'
      }</details>`,
    )
    .join('');
  const warnings = (h.warnings ?? []).map((w) => `<li>${inline(esc(w))}</li>`).join('');
  const violations = (h.violations ?? [])
    .map(
      (v) => `<li><b>${v.kind === 'protected_path' ? 'Protected path' : 'Out of scope'}</b> <code>${esc(v.rule)}</code>:
        ${v.files.map((f) => copyCode(f)).join(' ')}</li>`,
    )
    .join('');
  return (
    (violations ? `<ul class="handoff-violations">${violations}</ul>` : '') +
    (pills ? `<div class="check-pills">${pills}</div>` : '') +
    (warnings ? `<ul class="handoff-warnings">${warnings}</ul>` : '')
  );
}

// skipLead: leave out the summary's first paragraph (the Review card shows it above the details).
function handoffHtml(t, { skipLead = false } = {}) {
  const h = t.handoff;
  if (!h) return '<p class="muted">Moved to review without a handoff. Check the comments for what changed.</p>';
  const files = h.files.length
    ? `<dt>Files</dt><dd><details class="files"${h.files.length <= 6 ? ' open' : ''}><summary>${h.files.length} changed${
        h.files_derived ? ` <span class="muted">(from git, since ${esc(h.diff_base?.ref ?? 'base')})</span>` : ''
      }</summary>
        <ul>${h.files.map((f) => `<li>${copyCode(f)}</li>`).join('')}</ul></details></dd>`
    : '';
  return `
    <div class="handoff">
      <div class="markdown">${markdown(skipLead ? h.summary.split(/\n\s*\n/).slice(1).join('\n\n') : h.summary)}</div>
      ${
        h.branch || h.commit || h.files.length
          ? `<dl class="handoff-meta">
              ${h.branch ? `<dt>Branch</dt><dd>${copyCode(h.branch)}</dd>` : ''}
              ${h.commit ? `<dt>Commit</dt><dd>${copyCode(h.commit, h.commit.slice(0, 10))}</dd>` : ''}
              ${files}
            </dl>`
          : ''
      }
      ${checkPillsHtml(h)}
      ${h.verify ? `<div class="verify"><h4>How to verify</h4><div class="markdown">${markdown(h.verify)}</div></div>` : ''}
      ${h.media.length ? `<div class="gallery">${h.media.map((ref) => mediaHtml(ref, t.attachments ?? [])).join('')}</div>` : ''}
    </div>`;
}

// A question from an agent. Open ones are an answer form (used in the task dialog and the Inbox).
function questionHtml(q, t) {
  if (q.status === 'answered') {
    return `<div class="question answered">
      <div class="q-head"><b>${esc(q.asked_by)}</b> asked · <time title="${fullDate(q.asked_at)}">${ago(q.asked_at)}</time>
        ${q.decision ? `<span class="decision-chip" title="Recorded as a project decision">${esc(q.decision)}</span>` : ''}</div>
      <div class="markdown q-text">${markdown(q.question)}</div>
      <div class="q-answer"><b>${esc(q.answered_by)}:</b> <div class="markdown">${markdown(q.answer)}</div></div>
    </div>`;
  }
  const tags = [...(t?.labels ?? []), ...(t?.epic ? [t.epic] : [])].join(', ');
  const recommended = (o) => q.recommendation && q.recommendation.toLowerCase().includes(o.toLowerCase());
  return `<form class="question question-form" data-question="${q.id}">
    <div class="q-head"><b>${esc(q.asked_by)}</b> asks${t ? '' : ` on ${taskLink(q.task)}`} · <time title="${fullDate(q.asked_at)}">${ago(q.asked_at)}</time>
      ${q.blocking ? '<span class="chip-waiting" title="The task waits for your answer">blocking</span>' : ''}</div>
    <div class="markdown q-text">${markdown(q.question)}</div>
    ${q.recommendation ? `<div class="q-rec"><b>Recommendation:</b> ${inline(esc(q.recommendation))}</div>` : ''}
    ${
      q.options.length
        ? `<div class="q-options">${q.options
            .map(
              (o, i) => `<label class="q-option"><input type="radio" name="option" value="${i}"><span>${inline(esc(o))}</span>${
                recommended(o) ? '<span class="muted small">recommended</span>' : ''
              }</label>`,
            )
            .join('')}</div>`
        : ''
    }
    <textarea name="answer" rows="2" aria-label="Answer" placeholder="${q.options.length ? 'Add a note (optional)' : 'Your answer'} · ⌘/Ctrl+Enter to send"></textarea>
    <label class="q-decision"><input type="checkbox" name="record_decision"> Record as decision <span class="muted small">so future agents follow it</span></label>
    <div class="q-decision-fields" hidden>
      <label class="field"><span>Title</span><input name="title" maxlength="300" value="${esc(q.question.split('\n')[0].replace(/[*_`]/g, '').slice(0, 300))}"></label>
      <label class="field"><span>Rationale</span><textarea name="rationale" rows="2" placeholder="Why (optional)"></textarea></label>
      <label class="field"><span>Tags</span><input name="tags" value="${esc(tags)}" placeholder="${t ? 'labels or epic keys it applies to' : "empty: the task's labels and epic"}">
        <small>Briefings for tasks with a matching label or epic include this decision.</small></label>
    </div>
    <div class="actions"><button class="btn btn-primary">Answer</button></div>
  </form>`;
}

async function submitAnswer(form) {
  const data = new FormData(form);
  const option = data.get('option');
  const body = { answer: data.get('answer').trim() };
  if (option !== null) body.option = Number(option);
  if (data.get('record_decision')) {
    body.record_decision = true;
    body.decision = { title: data.get('title').trim(), rationale: data.get('rationale').trim(), tags: splitList(data.get('tags')) };
  }
  if (body.option === undefined && !body.answer) return toast('Pick an option or write an answer', 'error');
  const q = await attempt(api(`/api/questions/${form.dataset.question}/answer`, { method: 'POST', body }));
  if (!q) return;
  toast(`Answered ${q.task}${q.decision ? ` · recorded ${q.decision}` : ''}`);
  await loadBoard();
  if (state.task?.key === q.task) await refreshTask({ force: true });
}

function bindQuestionForms() {
  document.addEventListener('change', (e) => {
    if (e.target.matches('.question-form [name="record_decision"]')) {
      $('.q-decision-fields', e.target.closest('form')).hidden = !e.target.checked;
    }
  });
  document.addEventListener('submit', (e) => {
    if (!e.target.matches('.question-form')) return;
    e.preventDefault();
    submitAnswer(e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('.question-form textarea') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  });
}

function reviewRound(t) {
  return (t.reviews ?? []).filter((r) => r.event === 'submitted').length;
}

function reviewActionsHtml(t) {
  const target = t.handoff?.submitted_by ?? t.assignee;
  const open = state.reviewing === t.key;
  return `
    <div class="review-actions" data-key="${esc(t.key)}">
      ${
        open
          ? `<textarea class="feedback" data-key="${esc(t.key)}" rows="4" aria-label="Feedback"
               placeholder="What needs to change, and what does done look like? ${target ? `${esc(target)} gets this as its next task.` : ''} (⌘/Ctrl+Enter to send)">${esc(state.reviewDrafts[t.key] ?? '')}</textarea>`
          : ''
      }
      <div class="actions">
        ${
          open
            ? `<button class="btn" data-action="cancel-changes">Cancel</button>
               <button class="btn btn-warn" data-action="send-back">Send back${target ? ` to ${esc(target)}` : ''}</button>`
            : `<button class="btn" data-action="request-changes">Request changes</button>
               <button class="btn btn-primary" data-action="accept">Accept</button>`
        }
      </div>
    </div>`;
}

// Shared by the Review view and the task modal.
async function reviewAction(action, key, container) {
  if (action === 'request-changes') {
    state.reviewing = key;
  } else if (action === 'cancel-changes') {
    state.reviewing = null;
  } else if (action === 'accept' || action === 'send-back') {
    const feedback = $('textarea.feedback', container)?.value.trim() ?? '';
    if (action === 'send-back' && !feedback) {
      toast('Write what needs to change first', 'error');
      $('textarea.feedback', container)?.focus();
      return;
    }
    const body = action === 'accept' ? { verdict: 'accept' } : { verdict: 'changes', feedback };
    const task = await attempt(api(`/api/tasks/${key}/review`, { method: 'POST', body }));
    if (!task) return;
    delete state.reviewDrafts[key];
    state.reviewing = null;
    toast(action === 'accept' ? `${key} accepted` : `${key} sent back${task.assignee ? ` to ${task.assignee}` : ''}`);
    await loadBoard();
    if (state.task?.key === key) await refreshTask({ force: true });
    return;
  } else {
    return;
  }
  if (state.task?.key === key) renderTaskModal(false);
  else renderReview();
  $('textarea.feedback', els.modalRoot.firstChild ? els.modalRoot : els.review)?.focus();
}

function renderTaskModal(isNew) {
  const t = state.task;
  const oldMain = $('.task-main', els.modalRoot);
  const scrollTop = oldMain ? $('.overlay', els.modalRoot).scrollTop : 0;


  const isEpic = t.type === 'epic';
  const round = reviewRound(t);
  const doneCount = t.criteria.filter((c) => c.done).length;
  const handoffSection =
    t.handoff || t.status === 'review'
      ? `<section class="handoff-section${t.status === 'review' ? ' in-review' : ''}">
          <div class="section-head"><h3>${t.status === 'review' ? 'Waiting for review' : 'Last handoff'}${round > 1 ? ` · round ${round}` : ''}</h3>
            ${t.handoff ? `<span class="muted small">${esc(t.handoff.submitted_by)} · ${ago(t.handoff.submitted_at)}</span>` : ''}</div>
          ${handoffHtml(t)}
          ${t.status === 'review' ? reviewActionsHtml(t) : ''}
        </section>`
      : '';
  const openQuestions = t.questions.filter((q) => q.status === 'open');
  const questionsSection = t.questions.length
    ? `<section class="questions-section${openQuestions.length ? ' has-open' : ''}">
        <div class="section-head"><h3>${openQuestions.length ? `Waiting on you · ${openQuestions.length} question${openQuestions.length > 1 ? 's' : ''}` : 'Questions'}</h3></div>
        ${[...openQuestions, ...t.questions.filter((q) => q.status !== 'open').reverse()].map((q) => questionHtml(q, t)).join('')}
      </section>`
    : '';
  const criteriaSection = isEpic
    ? ''
    : listSection({
        list: 'criteria',
        title: `Acceptance criteria${t.criteria.length ? ` · ${doneCount}/${t.criteria.length}` : ''}`,
        items: t.criteria.length ? criteriaHtml(t, { editable: true }) : '',
        placeholder: 'Add a criterion: a concrete, checkable “done when…” (Enter). Start with [director] for one only you can tick',
      });
  const pendingSetup = t.pending_prerequisites.length;
  const prerequisitesSection = isEpic
    ? ''
    : listSection({
        list: 'prerequisites',
        title: `Prerequisites${t.prerequisites.length ? ` · ${t.prerequisites.length - pendingSetup}/${t.prerequisites.length}` : ''}${
          pendingSetup ? ' <span class="chip-setup">blocks agents</span>' : ''
        }`,
        items: t.prerequisites.length
          ? `<ul class="checklist">${t.prerequisites
              .map(
                (p, i) => `<li class="${p.done ? 'done' : ''}"><label><input type="checkbox" data-prereq="${i}" ${p.done ? 'checked' : ''}><span>${inline(esc(p.text))}</span></label>
                  <button class="icon-btn small" data-action="remove-item" data-list="prerequisites" data-index="${i}" aria-label="Remove prerequisite">${icon('x', { size: 14 })}</button></li>`,
              )
              .join('')}</ul>`
          : '',
        placeholder: 'Add something you must do before an agent can start, e.g. “Install the .NET 8 SDK” (Enter)',
      });
  const contextSection = isEpic
    ? ''
    : listSection({
        list: 'context',
        title: 'Context',
        items: t.context.length
          ? `<ul class="ref-list">${t.context
              .map((r, i) => `<li>${refHtml(r)}${missingContextChip(t, r)}<button class="icon-btn small" data-action="remove-item" data-list="context" data-index="${i}" aria-label="Remove">${icon('x', { size: 14 })}</button></li>`)
              .join('')}</ul>`
          : '',
        placeholder: 'Add a file, doc or URL agents should read first (Enter)',
      });
  const inHandoff = handoffMediaIds(t);
  const ownAttachments = t.attachments.filter((a) => !inHandoff.has(String(a.id)));
  const attachmentSection = `
    <section class="attachments-section">
      <div class="section-head"><h3>Attachments${ownAttachments.length ? ` · ${ownAttachments.length}` : ''}${
        t.attachments.length > ownAttachments.length ? ` <span class="muted">(${t.attachments.length - ownAttachments.length} in the handoff)</span>` : ''
      }</h3>
        <button class="btn btn-ghost" type="button" data-action="attach">${icon('paperclip', { size: 14 })}Attach…</button><input type="file" data-upload multiple hidden
          accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime,text/plain,application/json"></div>
      ${attachmentsHtml(ownAttachments, { removable: true }) || (t.attachments.length ? '' : '<p class="muted small">Screenshots, clips or logs. Paste an image anywhere in this dialog to attach it.</p>')}
    </section>`;
  const staleBanner = t.stale_context?.length
    ? `<div class="stale-banner">
        <div><b>Context changed since this task was written.</b> Re-read what changed before relying on the description.</div>
        <ul>${t.stale_context
          .map(
            (c) => `<li>${copyCode(c.path)} · ${
              c.baseline_missing ? `the commit this task was checked against (${esc(c.baseline_missing.slice(0, 7))}) is no longer in the repo; since the task was created, ` : ''
            }${c.commits_since.length} commit${c.commits_since.length === 1 ? '' : 's'}${c.commits_since.length ? ':' : ''}
              ${c.commits_since.slice(0, 3).map((x) => `${copyCode(x.sha, x.sha.slice(0, 7))} “${esc(x.subject)}”`).join(', ')}${c.commits_since.length > 3 ? ', …' : ''}</li>`,
          )
          .join('')}</ul>
        <div class="actions"><button class="btn" data-action="recheck-context">Mark re-checked</button></div>
      </div>`
    : '';
  const refs = t.references ?? [];
  const dangling = t.dangling_references ?? [];
  const referencesSection =
    refs.length || dangling.length || t.reference_error
      ? `<section><div class="section-head"><h3>Rule IDs</h3></div>
        ${t.reference_error ? `<p class="warn small">${esc(t.reference_error)}</p>` : ''}<div class="ref-ids">
          ${dangling
            .map((r) => `<span class="ref-id dangling" title="${esc(r.source_missing ? `${r.source} is not in the repo` : `No longer in ${r.source}`)}">${esc(r.id)} · not in ${esc(r.source)}</span>`)
            .join('')}
          ${refs
            .map(
              (r) => `<details class="ref-id"><summary>${esc(r.id)} <span class="muted">${esc(r.source)}:${r.line}</span></summary>
                <pre>${esc(r.excerpt)}</pre>
                <a href="${fileUrl(`/api/projects/${encodeURIComponent(t.project)}/repo/file?path=${encodeURIComponent(r.source)}`)}" target="_blank" rel="noopener">Open ${esc(r.source)}</a></details>`,
            )
            .join('')}</div></section>`
      : '';
  const upstreamSection = t.upstream?.length
    ? `<section><div class="section-head"><h3>Builds on</h3><span class="muted small">what its dependencies handed over (agents get this in their briefing)</span></div>
        ${t.upstream
          .map(
            (u) => `<details class="upstream"><summary>${taskLink(u.key)} ${esc(u.title)} ${statusPill(u.status)}${
              u.review ? ` <span class="muted small">${esc(u.review.verdict.replace('_', ' '))}</span>` : ''
            }</summary>
              <div class="markdown">${markdown(u.summary)}</div>
              ${u.commit || u.files.length ? `<div class="muted small">${u.commit ? `commit ${copyCode(u.commit, u.commit.slice(0, 10))} · ` : ''}${u.files.length} file${u.files.length === 1 ? '' : 's'}</div>` : ''}
              ${u.review?.feedback ? `<blockquote class="markdown">${markdown(u.review.feedback)}</blockquote>` : ''}
            </details>`,
          )
          .join('')}</section>`
    : '';
  const relations =
    relatedList('Blocked by', t.dependencies) + relatedList('Blocks', t.dependents) + relatedList('Subtasks', t.subtasks);
  const epicSection = isEpic
    ? `<section>
        <div class="section-head"><h3>Tasks in this epic · ${t.progress.done}/${t.progress.total} done${
          t.progress.points_total ? ` · ${t.progress.points_done}/${t.progress.points_total} pts` : ''
        }</h3></div>
        ${progressBar(t.progress)}
        ${
          t.children.length
            ? `<ul class="related" style="margin-top:8px">${t.children
                .map(
                  (c) => `<li>${taskLink(c.key)}<span class="title">${esc(c.title)}</span>${estimateBadge(c)}${
                    c.sprint ? `<span class="muted sprint-name">${esc(c.sprint)}</span>` : ''
                  }${c.assignee ? avatar(c.assignee) : ''}${statusPill(c.status)}</li>`,
                )
                .join('')}</ul>`
            : '<p class="muted">No tasks yet. Set a task\'s Epic field to add it here.</p>'
        }
      </section>`
    : '';

  // Empty sections fold into one "+ Criterion · Context · Prerequisite · Attachment" row until they
  // have content or are opened from it.
  const sectionHas = { criteria: t.criteria.length, context: t.context.length, prerequisites: t.prerequisites.length, attachments: t.attachments.length };
  const folded = (name) => !sectionHas[name] && !state.openSections.has(name);
  const foldable = isEpic ? ['attachments'] : ['criteria', 'context', 'prerequisites', 'attachments'];
  const FOLD_LABELS = { criteria: 'Criterion', context: 'Context', prerequisites: 'Prerequisite', attachments: 'Attachment' };
  const addRow = foldable.filter(folded).length
    ? `<div class="add-row">${icon('plus', { size: 14 })}${foldable
        .filter(folded)
        .map((name) => `<button type="button" class="link-btn" data-open-section="${name}">${FOLD_LABELS[name]}</button>`)
        .join('<span class="add-row-sep" aria-hidden="true">·</span>')}</div>`
    : '';

  const html = `
    <div class="modal task-modal" role="dialog" aria-modal="true" aria-label="${esc(t.key)}">
      <div class="modal-head">
        ${isEpic ? '' : statusIcon(t.status)}
        <a class="key" href="#/${esc(t.key)}" title="Link to this task">${esc(t.key)}</a>
        <span class="type type-${t.type}">${esc(t.type)}</span>
        ${t.epic ? `<span class="muted">in</span> <a href="#/${esc(t.epic)}" class="epic-link">${epicChip(t.epic)}</a>` : ''}
        ${t.parent ? `<span class="muted">under</span> ${taskLink(t.parent)}` : ''}
        <span class="head-title" aria-hidden="true">${esc(t.title)}</span>
        <span class="spacer"></span>
        <button class="icon-btn" data-action="copy" title="Copy key" aria-label="Copy task key">${icon('copy')}</button>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="task-layout">
        <div class="task-main">
          <textarea class="title-input" rows="1" data-field="title" aria-label="Title" maxlength="500">${esc(t.title)}</textarea>
          ${
            t.checkpoint
              ? `<div class="checkpoint-note"><div class="section-head"><h3>Resume note</h3>
                  <span class="muted small">${esc(t.checkpoint.by)} · <time title="${fullDate(t.checkpoint.at)}">${ago(t.checkpoint.at)}</time></span>
                  <button class="btn btn-ghost" data-action="clear-checkpoint">Clear</button></div>
                  <div class="markdown">${markdown(t.checkpoint.body)}</div></div>`
              : ''
          }
          ${t.rework ? '<div class="rework-banner">Sent back by review. The latest feedback is in the comments below.</div>' : ''}
          ${
            t.glossary_warnings?.length
              ? `<div class="glossary-strip" title="From the project glossary">Wording: ${t.glossary_warnings
                  .map((w) => `<span>“${esc(w.word)}”: say <b>${esc(w.term)}</b> <span class="muted">(${esc(w.field.replace('_', ' '))})</span></span>`)
                  .join(' · ')}</div>`
              : ''
          }
          ${staleBanner}
          ${questionsSection}
          ${pendingSetup ? prerequisitesSection : ''}
          ${handoffSection}

          <section>
            <div class="section-head"><h3>Description</h3><div class="section-actions">
              ${
                !state.descEditing && !isEpic && !t.criteria.length && hasChecklist(t.description)
                  ? '<button class="btn" data-action="extract-criteria" title="Move the - [ ] lines into acceptance criteria that agents tick off">Convert to criteria</button>'
                  : ''
              }
              ${state.descEditing ? '' : '<button class="btn btn-ghost" data-action="edit-desc">Edit</button>'}</div></div>
            ${
              state.descEditing
                ? `<div class="desc-editor"><textarea aria-label="Description" placeholder="Markdown supported. Add context and acceptance criteria as - [ ] checklists.">${esc(t.description)}</textarea>
                   <div class="actions"><span class="muted left">Markdown · ⌘/Ctrl+Enter to save</span><button class="btn" data-action="cancel-desc">Cancel</button><button class="btn btn-primary" data-action="save-desc">Save</button></div></div>`
                : `<div class="markdown desc-view" data-action="edit-desc" title="Click to edit">${
                    markdown(t.description) || '<p class="muted">No description. Click to add one.</p>'
                  }</div>`
            }
          </section>

          ${folded('criteria') ? '' : criteriaSection}
          ${referencesSection}
          ${folded('context') ? '' : contextSection}
          ${pendingSetup || folded('prerequisites') ? '' : prerequisitesSection}
          ${folded('attachments') ? '' : attachmentSection}
          ${addRow}
          ${epicSection}
          ${upstreamSection}
          ${relations ? `<section><div class="section-head"><h3>Relations</h3></div>${relations}</section>` : ''}

          <section>
            <div class="section-head"><h3>Comments${t.comments.length ? ` · ${t.comments.length}` : ''}</h3></div>
            <div class="comments">
              ${t.comments
                .map(
                  (c) => `<div class="comment">${avatar(c.author)}<div class="comment-body">
                    <div class="comment-head"><b>${esc(c.author)}</b> · <time title="${fullDate(c.created_at)}">${ago(c.created_at)}</time></div>
                    <div class="markdown">${markdown(c.body)}</div></div></div>`,
                )
                .join('')}
              <form class="comment-form">
                <textarea placeholder="Leave a note for the agents… (Markdown, ⌘/Ctrl+Enter to send)" aria-label="New comment"></textarea>
                <div class="actions"><label class="muted small left comment-checkpoint" title="Also save it as the resume note agents see first when they pick the task up"><input type="checkbox" name="checkpoint"> Save as resume note</label><button class="btn btn-primary">Comment</button></div>
              </form>
            </div>
          </section>

          <section>
            <div class="section-head"><h3>History</h3></div>
            <ol class="history">
              ${t.activity
                .map((a) => `<li><b>${esc(a.actor)}</b> ${describeActivity(a, { withTask: false, where: 'history' })}<time title="${fullDate(a.created_at)}">${ago(a.created_at)}</time></li>`)
                .join('')}
            </ol>
          </section>
        </div>

        <aside class="task-side">
          ${propertiesHtml(t)}
          ${repoInfoHtml(t)}
          <dl class="meta-list">
            <dt>Created</dt><dd title="${fullDate(t.created_at)}">${ago(t.created_at)} by ${esc(t.created_by ?? '?')}</dd>
            <dt>Updated</dt><dd title="${fullDate(t.updated_at)}">${ago(t.updated_at)}</dd>
            ${t.started_at ? `<dt>Started</dt><dd title="${fullDate(t.started_at)}">${ago(t.started_at)}</dd>` : ''}
            ${t.completed_at ? `<dt>Completed</dt><dd title="${fullDate(t.completed_at)}">${ago(t.completed_at)}</dd>` : ''}
          </dl>
          <div class="actions" style="margin-top:auto;justify-content:flex-start">
            <button class="btn btn-danger" data-action="delete-task">Delete ${isEpic ? 'epic' : 'task'}</button>
          </div>
        </aside>
      </div>
    </div>`;

  if (isNew || !oldMain) {
    openModal(html);
    bindTaskModal();
  } else {
    $('.overlay', els.modalRoot).innerHTML = html;
    $('.overlay', els.modalRoot).scrollTop = scrollTop;
  }
  autosize($('.title-input', els.modalRoot));
  if (state.descEditing) $('.desc-editor textarea', els.modalRoot)?.focus();
  watchTitle();
  if (state.refocus) {
    $(state.refocus === 'attachments' ? '[data-action="attach"]' : `[data-add="${state.refocus}"]`, els.modalRoot)?.focus();
    state.refocus = null;
  }
}

// ------------------------------------------------------------ task properties

// A task as a chip (status, key, title) that opens it.
function taskChip(key, title, status) {
  return `<a class="task-chip" href="#/${esc(key)}" title="${esc(`${key} ${title ?? ''}`)}">${status ? statusIcon(status, { decorative: true }) : ''}<span class="key">${esc(key)}</span>${
    title ? `<span class="task-chip-title">${esc(title)}</span>` : ''
  }</a>`;
}

// Every other task on the board, for the Parent and Depends on menus.
function taskMenuOptions(t) {
  return (state.board?.columns ?? [])
    .flatMap((c) => c.tasks)
    .filter((x) => x.key !== t.key)
    .map((x) => ({ value: x.key, label: x.title, hint: x.key, icon: statusIcon(x.status, { decorative: true }) }));
}

function estimateMenuOptions(t) {
  const project = state.projects.find((p) => p.key === t.project);
  const values = project?.allowed_estimates?.length ? project.allowed_estimates : [1, 2, 3, 5, 8, 13];
  return [
    { value: '', label: 'None' },
    ...[...new Set([...values, ...(t.estimate === null ? [] : [t.estimate])])]
      .sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: `${n} pt${n === 1 ? '' : 's'}` })),
  ];
}

// One property row: a label, then the value (a menu, chips or an inline editor), and any save error.
function propRow(field, label, value, { hint = '' } = {}) {
  const error = state.propError?.field === field ? `<div class="prop-error" role="alert">${esc(state.propError.message)}</div>` : '';
  return `<div class="prop-row" data-prop="${field}"><span class="prop-label">${esc(label)}</span><div class="prop-value">${value}${
    hint ? `<small class="prop-hint">${hint}</small>` : ''
  }</div>${error}</div>`;
}

// A free-text property edited in place: saves on Enter or blur (the task view's change handler).
const propInput = (field, value, label) =>
  `<input class="prop-input" data-field="${field}" value="${esc(value)}" placeholder="Add…" aria-label="${esc(label)}" spellcheck="false">`;

function propertiesHtml(t) {
  const isEpic = t.type === 'epic';
  const ghost = { variant: 'ghost' };
  const status = propRow(
    'status',
    'Status',
    taskMenu('status', 'Status', STATUSES.map((s) => ({ value: s, label: STATUS_NAMES[s], icon: statusIcon(s, { decorative: true }) })), t.status, { ...ghost, shortcut: 'S' }),
  );
  const priority = propRow(
    'priority',
    'Priority',
    taskMenu(
      'priority',
      'Priority',
      PRIORITIES.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1), icon: priorityIcon(p, { decorative: true }) })),
      t.priority,
      { ...ghost, shortcut: 'P' },
    ),
  );
  const labels = propRow(
    'labels',
    'Labels',
    menuButton('task-labels', {
      label: 'Labels',
      multiple: true,
      creatable: true,
      placeholder: 'Add…',
      variant: 'ghost',
      searchPlaceholder: 'Add or find a label…',
      options: labelMenuOptions(t),
      value: t.labels,
      onChange: (values) => patchTask({ labels: values }),
    }),
  );
  const milestone = propRow('milestone', 'Milestone', taskMenu('milestone', 'Milestone', milestoneMenuOptions(t), t.milestone ?? '', { ...ghost, placeholder: 'None' }));
  const externalId = propRow('external_id', 'External ID', propInput('external_id', t.external_id ?? '', 'External ID'));
  if (isEpic) return `<div class="prop-group">${status}${priority}${labels}${milestone}${externalId}</div>`;

  const parentTitle = t.parent ? (findTask(t.parent)?.title ?? '') : '';
  const parentStatus = t.parent ? findTask(t.parent)?.status : null;
  const deps = t.dependencies ?? [];
  return `
    <div class="prop-group">
      ${status}${priority}
      ${propRow('assignee', 'Assignee', taskMenu('assignee', 'Assignee', assigneeMenuOptions(t), t.assignee ?? '', { ...ghost, creatable: true, searchPlaceholder: 'Assign to…', placeholder: 'Unassigned', shortcut: 'A' }))}
      ${propRow('estimate', 'Estimate', taskMenu('estimate', 'Estimate', estimateMenuOptions(t), t.estimate === null ? '' : String(t.estimate), {
        ...ghost,
        placeholder: 'None',
        creatable: true,
        searchPlaceholder: 'Points…',
        toValue: (v) => (v === '' ? null : Number(v)),
      }))}
      ${labels}
    </div>
    <div class="prop-group">
      ${propRow('epic', 'Epic', taskMenu('epic', 'Epic', epicMenuOptions(), t.epic ?? '', { ...ghost, placeholder: 'None' }))}
      ${propRow('sprint', 'Sprint', taskMenu('sprint', 'Sprint', sprintMenuOptions(t), t.sprint_id ? String(t.sprint_id) : '', { ...ghost, toValue: (v) => (v === '' ? null : Number(v)) }))}
      ${milestone}
      ${propRow(
        'parent',
        'Parent',
        `${t.parent ? taskChip(t.parent, parentTitle, parentStatus) : ''}${taskMenu('parent', 'Parent', [{ value: '', label: 'None' }, ...taskMenuOptions(t)], t.parent ?? '', {
          ...ghost,
          triggerText: t.parent ? 'Change' : 'Add…',
          triggerEmpty: !t.parent,
          searchPlaceholder: 'Parent task…',
        })}`,
      )}
      ${propRow(
        'depends_on',
        'Depends on',
        `${deps.map((d) => taskChip(d.key, d.title, d.status)).join('')}${menuButton('task-depends_on', {
          label: 'Depends on',
          multiple: true,
          variant: 'ghost',
          triggerText: deps.length ? 'Edit' : 'Add…',
          triggerEmpty: !deps.length,
          searchPlaceholder: 'Tasks it waits for…',
          options: taskMenuOptions(t),
          value: t.depends_on,
          onChange: (values) => patchTask({ depends_on: values }),
        })}`,
        { hint: t.blocked_by.length ? 'Blocked until these are done' : '' },
      )}
    </div>
    <details class="prop-more"${state.moreOpen ? ' open' : ''}>
      <summary>${icon('chevron-right', { size: 14, cls: 'disclosure' })}More</summary>
      <div class="prop-group">
        ${propRow('scope', 'Scope', propInput('scope', t.scope.join(', '), 'Scope: globs of files it may change'), { hint: t.scope.length ? 'Files it may change; others are flagged on submit' : '' })}
        ${propRow('type', 'Type', taskMenu('type', 'Type', TYPES.map((x) => ({ value: x, label: x.charAt(0).toUpperCase() + x.slice(1), icon: typeDot(x) })), t.type, ghost))}
        ${externalId}
        ${propRow(
          'needs_review',
          'Review',
          taskMenu(
            'needs_review',
            'Review',
            [
              { value: 'false', label: 'Agent closes it', icon: icon('check', { size: 14 }) },
              { value: 'true', label: 'I review it', icon: icon('eye', { size: 14 }) },
            ],
            String(Boolean(t.needs_review)),
            { ...ghost, toValue: (v) => v === 'true' },
          ),
          { hint: t.needs_review ? 'The agent must submit it for your review.' : '' },
        )}
      </div>
    </details>`;
}

// ----------------------------------------------------------- command palette

// Tasks opened recently (newest first), so the palette lists them first.
function recentTasks() {
  try {
    return JSON.parse(store.get('kanban.recent', '[]'));
  } catch {
    return [];
  }
}

function rememberTask(key) {
  store.set('kanban.recent', JSON.stringify([key, ...recentTasks().filter((k) => k !== key)].slice(0, 20)));
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Everything the palette can do right now: act on the open task, open a task, go somewhere, create.
function paletteCommands() {
  const cmds = [];
  const t = state.task;
  if (t) {
    const group = `${t.key} · ${t.title}`;
    for (const s of STATUSES.filter((x) => x !== t.status)) {
      cmds.push({ group, label: `Set status: ${STATUS_NAMES[s]}`, icon: statusIcon(s, { decorative: true }), run: () => patchTask({ status: s }) });
    }
    for (const p of PRIORITIES.filter((x) => x !== t.priority)) {
      cmds.push({ group, label: `Set priority: ${capitalize(p)}`, icon: priorityIcon(p, { decorative: true }), run: () => patchTask({ priority: p }) });
    }
    if (t.type !== 'epic') {
      for (const o of assigneeMenuOptions(t).filter((o) => o.value !== (t.assignee ?? ''))) {
        cmds.push({ group, label: o.value ? `Assign to ${o.value}` : 'Unassign', icon: o.icon, run: () => patchTask({ assignee: o.value || null }) });
      }
    }
  }
  const tasks = [...(state.board?.columns ?? []).flatMap((c) => c.tasks), ...(state.board?.epics ?? [])];
  for (const task of tasks) {
    cmds.push({ group: 'Tasks', label: task.title, hint: task.key, key: task.key, icon: statusIcon(task.status, { decorative: true }), run: () => openTask(task.key) });
  }
  for (const view of VIEWS) {
    cmds.push({
      group: 'Go to',
      label: `Go to ${VIEW_NAMES[view]}`,
      shortcut: `G ${GO_KEYS[view].toUpperCase()}`,
      icon: icon({ inbox: 'inbox', board: 'square-kanban', plan: 'calendar-range', review: 'eye' }[view], { size: 14 }),
      run: () => {
        closeModal();
        setView(view);
      },
    });
  }
  cmds.push({ group: 'Help', label: 'Keyboard shortcuts', shortcut: '?', icon: icon('settings', { size: 14 }), run: openShortcutSheet });
  for (const p of state.projects.filter((x) => x.key !== state.projectKey)) {
    cmds.push({
      group: 'Go to',
      label: `Go to ${p.name}`,
      hint: p.key,
      icon: projectMark(p),
      run: () => {
        closeModal();
        selectProject(p.key);
      },
    });
  }
  return cmds;
}

async function createTaskFromPalette(title) {
  const created = await attempt(api('/api/tasks', { method: 'POST', body: { project: state.projectKey, title, status: 'backlog' } }));
  if (!created) return;
  state.flash.add(created.key);
  toast(`Created ${created.key} in Backlog`);
  await openTask(created.key);
}

// ⌘K / Ctrl+K. With no query: the open task's actions, recent tasks, then places to go. Typing ranks
// everything fuzzily (recent tasks win ties) and offers to create a task with that title.
function openCommandPalette() {
  if (!state.projectKey) return;
  const cmds = paletteCommands();
  const recent = recentTasks();
  const recency = (c) => (c.key && recent.includes(c.key) ? recent.indexOf(c.key) : Infinity);
  const options = cmds.map((c, i) => ({ ...c, value: String(i) }));
  openPalette({
    label: 'Command palette',
    searchPlaceholder: state.task ? `Search, or act on ${state.task.key}…` : 'Search tasks, go to a view or a project, create a task…',
    options,
    emptyText: 'Nothing matches',
    filter: (all, query) => {
      const q = query.trim();
      if (!q) {
        const actions = all.filter((o) => !['Tasks', 'Go to', 'Help'].includes(o.group));
        const recentTaskRows = all
          .filter((o) => o.key && recent.includes(o.key))
          .sort((a, b) => recency(a) - recency(b))
          .slice(0, 6)
          .map((o) => ({ ...o, group: 'Recent' }));
        return [...actions, ...recentTaskRows, ...all.filter((o) => o.group === 'Go to' || o.group === 'Help')];
      }
      const ranked = fuzzyRank(all, q, (o) => [o.label, ...(o.hint ? [o.hint] : [])], recency)
        .slice(0, 50)
        .map((o) => ({ ...o, hint: o.group === 'Tasks' ? o.hint : o.hint ?? (o.group === 'Go to' ? '' : o.group.split(' · ')[0]), group: undefined }));
      return [...ranked, { value: 'create', label: `Create task “${q}”`, icon: icon('plus', { size: 14 }), hint: 'Backlog', create: true, run: () => createTaskFromPalette(q) }];
    },
    onChange: (_value, option) => option.run(),
  });
}

// ------------------------------------------------------------- shortcuts

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
const GO_KEYS = { inbox: 'i', board: 'b', plan: 'p', review: 'r' };
const FIELD_KEYS = { s: 'status', p: 'priority', a: 'assignee' };

// Every shortcut, for the ? sheet. Keys in one entry are pressed together (⌘ K) or in turn (G then B).
const SHORTCUTS = [
  { group: 'General', rows: [[[MOD, 'K'], 'Command palette'], [['/'], 'Search'], [['?'], 'Keyboard shortcuts'], [['Esc'], 'Close a menu or dialog']] },
  { group: 'Go to', rows: VIEWS.map((v) => [['G', GO_KEYS[v].toUpperCase()], VIEW_NAMES[v], 'then']) },
  {
    group: 'Tasks',
    rows: [
      [['C'], 'New task'],
      [['J'], 'Select the next task'],
      [['K'], 'Select the previous task'],
      [['Enter'], 'Open the selected task'],
      [['S'], 'Status of the selected or open task'],
      [['P'], 'Priority'],
      [['A'], 'Assignee'],
      [[MOD, 'Enter'], 'Send a comment or answer'],
    ],
  },
];

// Single-key shortcuts (J, K, C, S, P, A, G, /, ?) can be turned off in the sheet (WCAG 2.1.4);
// ⌘K and Esc always work, and the palette's "Keyboard shortcuts" opens the sheet.
const shortcutsOn = () => store.get('kanban.shortcuts', 'on') !== 'off';

// The ? sheet is its own layer over any open dialog, so opening it never drops an unsent edit.
let sheetRoot = null;
let sheetReturn = null;
const sheetIsOpen = () => Boolean(sheetRoot?.firstChild);

function openShortcutSheet() {
  if (sheetIsOpen()) return;
  sheetRoot ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'sheet-root' }));
  sheetReturn = document.activeElement;
  const keys = ([combo, , sep]) => combo.map((k) => `<kbd>${esc(k)}</kbd>`).join(sep ? '<span class="kbd-sep">then</span>' : '');
  sheetRoot.innerHTML = `<div class="overlay sheet-overlay">
    <div class="modal shortcuts-modal" data-dialog="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="modal-head"><h2>Keyboard shortcuts</h2><span class="spacer"></span>
        <button class="icon-btn" data-close aria-label="Close" autofocus>${icon('x')}</button></div>
      <div class="modal-body">
        <label class="shortcut-toggle"><input type="checkbox" name="single-key"${shortcutsOn() ? ' checked' : ''}>
          <span>Single-key shortcuts<small class="muted">Turn off if they get in the way of a screen reader or voice control. ${esc(MOD)} K and Esc always work.</small></span></label>
        ${SHORTCUTS.map(
          (g) => `<section class="shortcut-group"><h3>${esc(g.group)}</h3><dl>${g.rows
            .map((r) => `<div class="shortcut-row"><dt>${esc(r[1])}</dt><dd>${keys(r)}</dd></div>`)
            .join('')}</dl></section>`,
        ).join('')}
        <p class="muted">Shortcuts are off while you type in a field.</p>
      </div>
    </div></div>`;
  const overlay = sheetRoot.firstElementChild;
  overlay.addEventListener('mousedown', (e) => e.target === overlay && closeShortcutSheet());
  overlay.addEventListener('click', (e) => e.target.closest('[data-close]') && closeShortcutSheet());
  overlay.addEventListener('change', (e) => {
    if (e.target.name === 'single-key') store.set('kanban.shortcuts', e.target.checked ? 'on' : 'off');
  });
  $('[autofocus]', overlay)?.focus();
}

function closeShortcutSheet() {
  if (!sheetIsOpen()) return;
  sheetRoot.innerHTML = '';
  if (sheetReturn?.isConnected) sheetReturn.focus({ preventScroll: true });
  sheetReturn = null;
}

// A task anywhere on the page: the Board's columns, epics, or the Plan's sprints and Unscheduled.
function anyTask(key) {
  return (
    findTask(key) ??
    (state.board?.epics ?? []).find((x) => x.key === key) ??
    [...(state.plan?.unscheduled ?? []), ...(state.plan?.sprints ?? []).flatMap((s) => s.tasks)].find((x) => x.key === key) ??
    null
  );
}

// J/K selection on the Board and Plan. The selection is a task key, so it survives re-renders and
// carries over between the two views; the selected card or row is marked and holds focus.
function selectableItems() {
  // Only what's shown: rows inside a closed disclosure (Completed sprints) can't be selected. They still
  // have boxes (closed <details> content is content-visibility: hidden), so getClientRects() isn't enough.
  const shown = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0 && !el.closest('details:not([open])'));
  const rendered = (items) => items.filter(shown);
  if (state.view === 'board') return rendered($$('.card[data-key]', els.board));
  if (state.view === 'plan') return rendered($$('.plan-row[data-key]', els.plan));
  return [];
}

function markSelection({ refocus = false } = {}) {
  for (const el of $$('.is-selected')) el.classList.remove('is-selected');
  const el = state.selected ? selectableItems().find((x) => x.dataset.key === state.selected) : null;
  if (!el) return null;
  el.classList.add('is-selected');
  if (refocus && !els.modalRoot.firstChild && !menuIsOpen()) el.focus({ preventScroll: true });
  return el;
}

function moveSelection(step) {
  const items = selectableItems();
  if (!items.length) return;
  const i = items.findIndex((x) => x.dataset.key === state.selected);
  const next = items[i < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, i + step))];
  state.selected = next.dataset.key;
  markSelection();
  next.focus({ preventScroll: true });
  // The Board scrolls sideways to the card's column as well as down to the card.
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Where a card sits on the loaded board, so an Undo can put it back in the same slot.
function boardSlot(key) {
  for (const col of state.board?.columns ?? []) {
    const index = col.tasks.findIndex((t) => t.key === key);
    if (index >= 0) return { status: col.status, index };
  }
  return null;
}

// Undo a status change: move the card back to its old column and slot when the board knew it
// (a PATCH of status alone would land it at the bottom of its old column). The priority didn't
// change, so at its old index it still fits its neighbours and the move keeps it.
function undoStatus(key, slot, before) {
  return slot?.status === before
    ? api(`/api/tasks/${key}/move`, { method: 'POST', body: { status: before, index: slot.index } })
    : api(`/api/tasks/${key}`, { method: 'PATCH', body: { status: before } });
}

// Save one field of a task that isn't open in the dialog; a status change can be undone.
async function updateListedTask(key, body) {
  const before = anyTask(key)?.status;
  const slot = boardSlot(key);
  if (!(await attempt(api(`/api/tasks/${key}`, { method: 'PATCH', body })))) return;
  state.flash.add(key);
  await loadBoard();
  if (body.status && before && body.status !== before) {
    toast(`${key} moved to ${STATUS_NAMES[body.status]}`, '', {
      action: { label: 'Undo', run: async () => (await attempt(undoStatus(key, slot, before))) && loadBoard() },
    });
  }
}

// S, P, A: the open task's own menu, or a menu under the selected card or row.
function openFieldMenu(field) {
  if (state.task) {
    openMenu(`task-${field}`);
    return;
  }
  const el = markSelection();
  const t = el && anyTask(state.selected);
  if (!t) {
    toast('Select a task first: J and K move the selection');
    return;
  }
  if (field === 'assignee' && t.type === 'epic') return;
  const menus = {
    status: {
      label: 'Status',
      options: STATUSES.map((s) => ({ value: s, label: STATUS_NAMES[s], icon: statusIcon(s, { decorative: true }) })),
      value: t.status,
    },
    priority: {
      label: 'Priority',
      options: PRIORITIES.map((p) => ({ value: p, label: capitalize(p), icon: priorityIcon(p, { decorative: true }) })),
      value: t.priority,
    },
    assignee: { label: 'Assignee', options: assigneeMenuOptions(t), value: t.assignee ?? '' },
  };
  const menu = menus[field];
  openMenuAt(el, {
    ...menu,
    searchPlaceholder: `${menu.label} of ${t.key}…`,
    onChange: (v) => updateListedTask(t.key, { [field]: v === '' ? null : v }),
  });
}

// C: on the Board, the quick add in To Do; elsewhere a title prompt that creates the task in Backlog.
function newTaskShortcut() {
  const column = state.view === 'board' && $('.column[data-status="todo"]', els.board);
  if (column) return openQuickAdd(column);
  openPalette({
    label: 'New task',
    searchPlaceholder: 'New task title…',
    options: [],
    emptyText: 'Type a title, then press Enter',
    filter: (_all, query) =>
      query.trim() ? [{ value: 'create', label: `Create task “${query.trim()}”`, hint: 'Backlog', icon: icon('plus', { size: 14 }), create: true, title: query.trim() }] : [],
    onChange: (_v, option) => option && createTaskFromPalette(option.title),
  });
}

let goPending = 0; // when G was pressed; the next key within 1.5 s picks a view

// Single-key shortcuts. The caller has already ruled out typing, modifiers and open menus.
function handleShortcut(e) {
  const key = e.key.toLowerCase();
  if (goPending && Date.now() - goPending < 1500) {
    goPending = 0;
    const view = Object.keys(GO_KEYS).find((v) => GO_KEYS[v] === key);
    if (view) {
      e.preventDefault();
      closeModal();
      if (view !== state.view) setView(view);
    }
    return;
  }
  goPending = 0;
  const dialog = Boolean(els.modalRoot.firstChild);
  if (e.key === '?') {
    e.preventDefault();
    openShortcutSheet();
  } else if (key === 'g' && !e.shiftKey) {
    goPending = Date.now();
  } else if (dialog && !state.task) {
    // Other dialogs (milestones, settings) take only ? and G.
  } else if (FIELD_KEYS[key] && !e.shiftKey) {
    e.preventDefault();
    openFieldMenu(FIELD_KEYS[key]);
  } else if (dialog) {
    // With a task open, the rest wait until it closes.
  } else if (key === 'c' && !e.shiftKey) {
    e.preventDefault();
    newTaskShortcut();
  } else if ((key === 'j' || key === 'k') && !e.shiftKey) {
    e.preventDefault();
    moveSelection(key === 'j' ? 1 : -1);
  } else if (e.key === 'Enter' && document.activeElement === document.body && state.selected && markSelection()) {
    e.preventDefault();
    openTask(state.selected);
  }
}

// The title joins the sticky dialog header once it scrolls out of view.
let titleObserver = null;
function watchTitle() {
  titleObserver?.disconnect();
  const overlay = $('.overlay', els.modalRoot);
  const title = $('.title-input', els.modalRoot);
  const head = $('.task-modal .modal-head', els.modalRoot);
  if (!overlay || !title || !head) return;
  titleObserver = new IntersectionObserver(([entry]) => head.classList.toggle('show-title', !entry.isIntersecting), {
    root: overlay,
    rootMargin: `-${head.offsetHeight}px 0px 0px 0px`,
  });
  titleObserver.observe(title);
}

function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

async function patchTask(body, { undoable = true } = {}) {
  const key = state.task.key;
  const before = state.task.status;
  const slot = body.status ? boardSlot(key) : null;
  // A failed save shows its error next to the property's row (and reverts the field to server state).
  const updated = await api(`/api/tasks/${key}`, { method: 'PATCH', body }).catch((err) => {
    state.propError = { field: Object.keys(body)[0], message: err.message };
    return null;
  });
  if (updated) {
    state.propError = null;
    await refreshTask({ force: true });
  } else if (state.task?.key === key) {
    if (!$(`[data-prop="${state.propError?.field}"]`, els.modalRoot)) toast(state.propError?.message ?? 'Could not save', 'error');
    renderTaskModal(false);
  }
  if (updated && undoable && body.status && body.status !== before) {
    toast(`${key} moved to ${STATUS_NAMES[body.status]}`, '', {
      action: {
        label: 'Undo',
        run: async () => {
          if (await attempt(undoStatus(key, slot, before))) {
            if (state.task?.key === key) await refreshTask({ force: true });
            await loadBoard();
          }
        },
      },
    });
  }
}

// Listeners live on the overlay, which survives re-renders of its contents.
function bindTaskModal() {
  const root = $('.overlay', els.modalRoot);

  root.addEventListener('change', async (e) => {
    if (e.target.dataset.criterion !== undefined) {
      const body = { items: [Number(e.target.dataset.criterion)], done: e.target.checked };
      if (await attempt(api(`/api/tasks/${state.task.key}/criteria`, { method: 'POST', body }))) await refreshTask({ force: true });
      else renderTaskModal(false);
      return;
    }
    if (e.target.dataset.prereq !== undefined) {
      const body = { items: [Number(e.target.dataset.prereq)], done: e.target.checked };
      if (await attempt(api(`/api/tasks/${state.task.key}/prerequisites`, { method: 'POST', body }))) await refreshTask({ force: true });
      else renderTaskModal(false);
      return;
    }
    if (e.target.matches('[data-upload]')) {
      await uploadFiles(state.task.key, [...e.target.files]);
      return refreshTask({ force: true });
    }
    const field = e.target.dataset.field;
    if (!field || field === 'title' || e.target.matches('.prop-input')) return;
    let value = e.target.value;
    if (field === 'labels' || field === 'depends_on' || field === 'scope') value = splitList(value);
    if (['assignee', 'parent', 'milestone', 'epic', 'sprint', 'external_id'].includes(field)) value = value.trim() || null;
    if (field === 'estimate') value = value === '' ? null : Number(value);
    if (field === 'needs_review') value = value === 'true';
    patchTask({ [field]: value });
  });

  // Free-text properties save on Enter or when focus leaves, if they changed; Esc puts the saved value back.
  const commitProp = (input) => {
    if (input.value.trim() === input.defaultValue.trim()) return;
    const field = input.dataset.field;
    input.defaultValue = input.value;
    patchTask({ [field]: field === 'scope' ? splitList(input.value) : input.value.trim() || null });
  };
  root.addEventListener('keydown', (e) => {
    if (!e.target.matches('.prop-input')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      commitProp(e.target);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      e.target.value = e.target.defaultValue;
      e.target.blur();
    }
  });
  root.addEventListener('focusout', (e) => {
    if (e.target.matches?.('.prop-input')) commitProp(e.target);
  });
  root.addEventListener(
    'toggle',
    (e) => {
      if (e.target.matches?.('.prop-more')) state.moreOpen = e.target.open;
    },
    true,
  );

  root.addEventListener('focusout', () => {
    // Apply updates that arrived while the user was mid-edit.
    setTimeout(() => state.taskStale && refreshTask(), 300);
  });

  root.addEventListener('input', (e) => {
    if (e.target.matches('.title-input')) autosize(e.target);
    if (e.target.matches('textarea.feedback')) state.reviewDrafts[e.target.dataset.key] = e.target.value;
  });

  // Paste a screenshot anywhere in the dialog to attach it.
  root.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length || !state.task) return;
    e.preventDefault();
    await uploadFiles(state.task.key, files);
    await refreshTask({ force: true });
  });

  root.addEventListener('keydown', (e) => {
    if (e.target.matches('.title-input') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
    if (e.target.matches('.desc-editor textarea') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveDescription();
    if (e.target.matches('.comment-form textarea') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
    if (e.target.matches('textarea.feedback') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      reviewAction('send-back', state.task.key, e.target.closest('.review-actions'));
    }
    if (e.target.matches('.list-add') && e.key === 'Enter') {
      e.preventDefault();
      addListItem(e.target.dataset.add, e.target.value.trim());
    }
  });

  root.addEventListener(
    'blur',
    (e) => {
      if (!e.target.matches?.('.title-input')) return;
      const title = e.target.value.trim();
      if (title && title !== state.task.title) patchTask({ title });
      else e.target.value = state.task.title;
    },
    true,
  );

  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('.comment-form')) return;
    e.preventDefault();
    const input = $('textarea', e.target);
    const body = input.value.trim();
    if (!body) return;
    const checkpoint = $('[name="checkpoint"]', e.target)?.checked === true;
    const created = await attempt(api(`/api/tasks/${state.task.key}/comments`, { method: 'POST', body: { body, checkpoint } }));
    if (created) {
      input.value = '';
      await refreshTask({ force: true });
    }
  });

  root.addEventListener('click', async (e) => {
    const section = e.target.closest('[data-open-section]')?.dataset.openSection;
    if (section) {
      state.openSections.add(section);
      state.refocus = section;
      renderTaskModal(false);
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action || e.target.closest('a')) return;
    if (action === 'attach') {
      $('[data-upload]', root)?.click();
    } else if (action === 'edit-desc') {
      state.descEditing = true;
      renderTaskModal(false);
    } else if (action === 'cancel-desc') {
      state.descEditing = false;
      renderTaskModal(false);
    } else if (action === 'save-desc') {
      saveDescription();
    } else if (action === 'copy') {
      navigator.clipboard?.writeText(state.task.key).then(() => toast(`Copied ${state.task.key}`));
    } else if (['request-changes', 'cancel-changes', 'accept', 'send-back'].includes(action)) {
      reviewAction(action, state.task.key, e.target.closest('.review-actions'));
    } else if (action === 'clear-checkpoint') {
      patchTask({ checkpoint: null });
    } else if (action === 'recheck-context') {
      if (await attempt(api(`/api/tasks/${state.task.key}/context/recheck`, { method: 'POST', body: {} }))) {
        toast('Context marked re-checked');
        await refreshTask({ force: true });
      }
    } else if (action === 'extract-criteria') {
      const task = await attempt(api(`/api/tasks/${state.task.key}/criteria/extract`, { method: 'POST', body: {} }));
      if (task) {
        toast(`Moved ${task.extracted} checklist item${task.extracted === 1 ? '' : 's'} into criteria`);
        await refreshTask({ force: true });
      }
    } else if (action === 'toggle-owner') {
      const index = Number(e.target.closest('[data-action]').dataset.index);
      patchTask({
        criteria: state.task.criteria.map((c, i) => (i === index ? { ...c, owner: c.owner === 'human' ? 'agent' : 'human' } : c)),
      });
    } else if (action === 'remove-item') {
      const { list, index } = e.target.closest('[data-action]').dataset;
      patchTask({ [list]: state.task[list].filter((_, i) => i !== Number(index)) });
    } else if (action === 'remove-attachment') {
      const btn = e.target.closest('button');
      const id = e.target.closest('[data-id]').dataset.id;
      confirmClick(btn, 'Remove?', async () => {
        if (await attempt(api(`/api/attachments/${id}`, { method: 'DELETE' }))) await refreshTask({ force: true });
      });
    } else if (action === 'delete-task') {
      const btn = e.target.closest('button');
      confirmClick(btn, 'Click again to delete', async () => {
        const key = state.task.key;
        if (await attempt(api(`/api/tasks/${key}`, { method: 'DELETE' }))) {
          closeModal();
          toast(`Deleted ${key}`);
        }
      });
    }
  });
}

async function addListItem(list, value) {
  if (!value) return;
  if (state.task[list].some((item) => (item.text ?? item) === value)) return toast('Already in the list', 'error');
  state.refocus = list;
  // Criteria go back as {text, done} so existing ticks survive.
  await patchTask({ [list]: [...state.task[list], value] });
}

async function saveDescription() {
  const description = $('.desc-editor textarea', els.modalRoot).value;
  state.descEditing = false;
  if (description.trim() === state.task.description) return renderTaskModal(false);
  await patchTask({ description });
}

// Two-step confirm without a blocking browser dialog.
function confirmClick(button, label, action) {
  if (button.classList.contains('confirming')) {
    action();
    return;
  }
  const original = button.textContent;
  button.classList.add('confirming');
  button.textContent = label;
  setTimeout(() => {
    button.classList.remove('confirming');
    button.textContent = original;
  }, 3000);
}

// --------------------------------------------------------------- milestones

function dueLabel(m) {
  if (!m.due_date) return '';
  const due = new Date(`${m.due_date}T23:59:59`);
  const text = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const overdue = m.status === 'open' && due < new Date() && m.done < m.total;
  return `<span class="${overdue ? 'overdue' : ''}">${overdue ? 'overdue · ' : 'due '}${text}</span>`;
}

// Fills with work that has moved: Done (strongest), then Review, then In Progress. Backlog and
// To Do are the empty track, so an epic nobody has started reads as empty.
const PROGRESS_FILL = ['done', 'review', 'in_progress'];

function progressBar(m) {
  if (!m.total) return '<div class="progress empty"></div>';
  return `<div class="progress" title="${STATUSES.map((s) => `${STATUS_NAMES[s]}: ${m.task_counts[s]}`).join(' · ')}">${PROGRESS_FILL.map(
    (s) => (m.task_counts[s] ? `<span class="fill-${s}" style="width:${((m.task_counts[s] / m.total) * 100).toFixed(2)}%"></span>` : ''),
  ).join('')}</div>`;
}

function milestoneFormHtml(m = {}) {
  return `
    <form class="ms-form" data-id="${m.id ?? 'new'}">
      <div class="ms-form-row">
        <label class="field grow"><span>Name</span><input name="name" required maxlength="120" value="${esc(m.name ?? '')}" placeholder="e.g. Week 2: Combat in the terminal"></label>
        <label class="field"><span>Due</span><input name="due_date" type="date" value="${esc(m.due_date ?? '')}"></label>
      </div>
      <label class="field"><span>Goal</span><textarea name="description" rows="2" placeholder="What does done look like? (Markdown)">${esc(m.description ?? '')}</textarea></label>
      <div class="actions">
        ${m.id ? `<button type="button" class="btn btn-danger left" data-action="delete-ms">Delete</button>
          <button type="button" class="btn" data-action="toggle-ms">${m.status === 'open' ? 'Close milestone' : 'Reopen'}</button>` : ''}
        <button type="button" class="btn" data-action="cancel-ms">Cancel</button>
        <button class="btn btn-primary">${m.id ? 'Save' : 'Create milestone'}</button>
      </div>
    </form>`;
}

function renderMilestonesModal() {
  const milestones = state.board?.milestones ?? [];
  const rows = milestones
    .map((m) =>
      state.msEditing === m.id
        ? `<li class="ms-row editing">${milestoneFormHtml(m)}</li>`
        : `<li class="ms-row ${m.status === 'closed' ? 'closed' : ''}" data-id="${m.id}">
            <div class="ms-top">
              <button class="ms-name" data-action="filter-ms" title="Show only this milestone on the board">${icon('diamond', { size: 14 })}${esc(m.name)}</button>
              ${m.status === 'closed' ? '<span class="label">closed</span>' : ''}
              <span class="spacer"></span>
              <button class="btn btn-ghost" data-action="edit-ms">Edit</button>
            </div>
            <div class="ms-meta">${m.done}/${m.total} done · ${m.progress}%${m.due_date ? ` · ${dueLabel(m)}` : ''}</div>
            ${progressBar(m)}
            ${m.description ? `<div class="markdown ms-desc">${markdown(m.description)}</div>` : ''}
          </li>`,
    )
    .join('');
  const html = `
    <div class="modal milestones-modal" data-dialog="milestones" role="dialog" aria-modal="true" aria-label="Milestones">
      <div class="modal-head"><h2>Milestones</h2><span class="muted">${esc(state.board?.project.name ?? '')}</span><span class="spacer"></span>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">
        ${milestones.length ? `<ol class="ms-list">${rows}</ol>` : '<p class="muted">No milestones yet. Group tasks into goals like "Vertical slice" or "Week 2", then filter the board or point an agent at one.</p>'}
        ${state.msEditing === 'new' ? milestoneFormHtml() : `<div><button class="btn" data-action="new-ms">${icon('plus', { size: 14 })}New milestone</button></div>`}
      </div>
    </div>`;

  const existing = $('[data-dialog="milestones"]', els.modalRoot);
  if (existing) {
    existing.outerHTML = html;
  } else {
    openModal(html);
    bindMilestonesModal();
  }
  $('.ms-form input[name="name"]', els.modalRoot)?.focus();
}

function bindMilestonesModal() {
  const root = $('.overlay', els.modalRoot);
  const base = `/api/projects/${state.projectKey}/milestones`;

  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('.ms-form')) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.due_date = data.due_date || null;
    const id = e.target.dataset.id;
    const saved =
      id === 'new'
        ? await attempt(api(base, { method: 'POST', body: data }))
        : await attempt(api(`/api/milestones/${id}`, { method: 'PATCH', body: data }));
    if (!saved) return;
    state.msEditing = null;
    await loadBoard();
    renderMilestonesModal();
  });

  root.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const id = Number(e.target.closest('[data-id]')?.dataset.id);
    const milestone = state.board?.milestones.find((m) => m.id === id);
    if (action === 'new-ms') {
      state.msEditing = 'new';
      renderMilestonesModal();
    } else if (action === 'edit-ms') {
      state.msEditing = id;
      renderMilestonesModal();
    } else if (action === 'cancel-ms') {
      state.msEditing = null;
      renderMilestonesModal();
    } else if (action === 'filter-ms') {
      closeModal();
      setFilter('milestone', String(id));
    } else if (action === 'toggle-ms' && milestone) {
      const status = milestone.status === 'open' ? 'closed' : 'open';
      if (!(await attempt(api(`/api/milestones/${id}`, { method: 'PATCH', body: { status } })))) return;
      state.msEditing = null;
      await loadBoard();
      renderMilestonesModal();
    } else if (action === 'delete-ms' && milestone) {
      confirmClick(e.target.closest('button'), 'Delete? Tasks are kept', async () => {
        if (!(await attempt(api(`/api/milestones/${id}`, { method: 'DELETE' })))) return;
        state.msEditing = null;
        await loadBoard();
        renderMilestonesModal();
      });
    }
  });
}

// --------------------------------------------------------------------- plan

async function loadPlan() {
  if (!state.projectKey) return;
  if (!state.plan || state.plan.project.key !== state.projectKey) renderPlan();
  const plan = await attempt(api(`/api/projects/${state.projectKey}/plan`));
  if (!plan) return;
  state.plan = plan;
  // Don't wipe a half-filled form or yank a row mid-drag; the next change re-renders.
  const busy = state.planDrag || ((state.sprintEditing !== null || state.epicCreating) && els.plan.contains(document.activeElement));
  if (!busy) renderPlan();
}

const shortDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

function sprintDates(s) {
  if (!s.start_date && !s.end_date) return '';
  return `${shortDate(s.start_date) || '…'} – ${shortDate(s.end_date) || '…'}`;
}

// One row per task on shared grid columns (see .plan-row), so every sprint and Unscheduled line up
// like a table. Empty cells keep their width.
function planRowHtml(t) {
  return `
    <li class="plan-row" draggable="true" data-key="${esc(t.key)}" tabindex="0">
      <span class="cell-type"><span class="type type-${t.type}" title="${esc(t.type)}"></span></span>
      <span class="key">${esc(t.key)}</span>
      <span class="plan-title" title="${esc(t.title)}">${esc(t.title)}</span>
      <span class="cell-blocked">${blockedChips(t)}</span>
      <span class="cell-epic">${epicChip(t.epic)}</span>
      <span class="cell-prio">${priorityBadge(t.priority)}</span>
      <span class="cell-estimate">${estimateBadge(t)}</span>
      <span class="cell-status">${statusPill(t.status)}</span>
      <span class="cell-assignee">${t.assignee ? avatar(t.assignee) : ''}</span>
    </li>`;
}

// The key column is as wide as the longest key on the page, so keys never wrap.
function sizePlanKeys() {
  const widths = $$('.plan-row .key', els.plan).map((k) => k.scrollWidth);
  if (widths.length) els.plan.style.setProperty('--plan-key-w', `${Math.ceil(Math.max(...widths))}px`);
}

function sprintFormHtml(s = {}) {
  return `
    <form class="sprint-form" data-id="${s.id ?? 'new'}">
      <div class="ms-form-row">
        <label class="field grow"><span>Name</span><input name="name" maxlength="120" value="${esc(s.name ?? '')}" placeholder="Leave empty for “Sprint N”"></label>
        <label class="field"><span>Start</span><input name="start_date" type="date" value="${esc(s.start_date ?? '')}"></label>
        <label class="field"><span>End</span><input name="end_date" type="date" value="${esc(s.end_date ?? '')}"></label>
      </div>
      <label class="field"><span>Goal</span><textarea name="goal" rows="2" placeholder="What this sprint delivers, and why these tasks belong together">${esc(s.goal ?? '')}</textarea></label>
      <div class="actions">
        ${s.id ? '<button type="button" class="btn btn-danger left" data-action="delete-sprint">Delete sprint</button>' : ''}
        <button type="button" class="btn" data-action="cancel-sprint">Cancel</button>
        <button class="btn btn-primary">${s.id ? 'Save' : 'Create sprint'}</button>
      </div>
    </form>`;
}

function sprintSectionHtml(s, { hasActive, nextPlanned }) {
  if (state.sprintEditing === s.id) return `<section class="sprint editing">${sprintFormHtml(s)}</section>`;
  const tasks = s.tasks.filter((t) => matchesFilter(t, { ignoreSprint: true }));
  const open = s.tasks.filter((t) => t.status !== 'done').length;
  const carryTo = nextPlanned && nextPlanned.id !== s.id ? nextPlanned.name : 'Unscheduled';
  const action =
    s.status === 'planned'
      ? `<button class="btn" data-action="start-sprint" ${hasActive ? 'disabled title="Complete the active sprint first"' : ''}>Start sprint</button>`
      : s.status === 'active'
        ? `<button class="btn btn-primary" data-action="complete-sprint" data-confirm="${
            open ? `Complete? ${open} open move to ${esc(carryTo)}` : 'Click again to complete'
          }">Complete sprint</button>`
        : '<button class="btn btn-ghost" data-action="reopen-sprint">Reopen</button>';
  return `
    <section class="sprint sprint-${s.status}" data-sprint="${s.id}">
      <header class="sprint-head">
        <div class="sprint-title">
          <h3>${esc(s.name)}</h3>
          <span class="sprint-status">${s.status}</span>
          ${sprintDates(s) ? `<span class="muted">${sprintDates(s)}</span>` : ''}
        </div>
        <div class="sprint-stats">
          <span>${s.done}/${s.total} done</span>
          ${s.points_total ? `<span>${s.points_done}/${s.points_total} pts</span>` : ''}
        </div>
        <div class="sprint-actions">${action}<button class="btn btn-ghost" data-action="edit-sprint">Edit</button></div>
      </header>
      ${progressBar(s)}
      ${s.goal ? `<div class="markdown sprint-goal">${markdown(s.goal)}</div>` : ''}
      <ol class="plan-list">${tasks.map(planRowHtml).join('') || `<li class="plan-empty">${s.tasks.length ? 'No tasks match the filters' : 'Drag tasks here to schedule them'}</li>`}</ol>
    </section>`;
}

function renderPlan() {
  if (state.view !== 'plan') return;
  const plan = state.plan;
  if (!plan || plan.project.key !== state.projectKey) {
    els.plan.innerHTML = state.projectKey ? skeleton('plan') : '';
    return;
  }
  const current = plan.sprints.filter((s) => s.status !== 'completed');
  const completed = plan.sprints.filter((s) => s.status === 'completed');
  const hasActive = current.some((s) => s.status === 'active');
  const nextPlanned = current.find((s) => s.status === 'planned');
  const unscheduled = plan.unscheduled.filter((t) => matchesFilter(t, { ignoreSprint: true }));
  const points = plan.unscheduled.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
  const milestones = state.board?.milestones ?? [];
  const decisions = plan.decisions ?? [];
  const wasOpen = $('.completed-sprints', els.plan)?.open ?? false;
  const scroll = $('.plan-main', els.plan)?.scrollTop ?? 0;
  const rowFocused = Boolean(document.activeElement?.closest?.('.plan-row[data-key]') && els.plan.contains(document.activeElement));

  els.plan.innerHTML = `
    <div class="plan-main">
      <div class="plan-toolbar">
        <h2>Sprints</h2>
        <span class="muted">${current.length} upcoming · ${completed.length} completed</span>
        <span class="spacer"></span>
      </div>
      ${state.sprintEditing === 'new' ? `<section class="sprint editing">${sprintFormHtml()}</section>` : ''}
      ${
        current.length || state.sprintEditing === 'new'
          ? ''
          : emptyState({
              icon: 'calendar-range',
              title: 'No sprints yet',
              text: `Ask an agent to <i>“plan the next sprints for ${esc(plan.project.key)}”</i> and it will group tasks into sprints with goals, or create one and drag tasks in.`,
              action: `<button class="btn" data-action="new-sprint">${icon('plus', { size: 14 })}Create a sprint</button>`,
            })
      }
      ${current.map((s) => sprintSectionHtml(s, { hasActive, nextPlanned })).join('')}
      <section class="sprint sprint-unscheduled" data-sprint="none">
        <header class="sprint-head">
          <div class="sprint-title"><h3>Unscheduled</h3><span class="muted">open tasks not in any sprint</span></div>
          <div class="sprint-stats"><span>${plan.unscheduled.length} task${plan.unscheduled.length === 1 ? '' : 's'}</span>${points ? `<span>${points} pts</span>` : ''}</div>
        </header>
        <ol class="plan-list">${unscheduled.map(planRowHtml).join('') || '<li class="plan-empty">Everything open is scheduled.</li>'}</ol>
      </section>
      ${
        completed.length
          ? `<details class="completed-sprints" ${wasOpen ? 'open' : ''}><summary>Completed sprints (${completed.length})</summary>
              ${completed.map((s) => sprintSectionHtml(s, { hasActive, nextPlanned })).join('')}</details>`
          : ''
      }
    </div>
    <aside class="plan-side">
      <section>
        <div class="section-head"><h3>Epics</h3><button class="btn btn-ghost" data-action="new-epic">${icon('plus', { size: 14 })}Epic</button></div>
        ${
          state.epicCreating
            ? `<form class="epic-form"><input name="title" required maxlength="500" placeholder="Epic title, e.g. Save system" autofocus>
                <div class="actions"><button type="button" class="btn" data-action="cancel-epic">Cancel</button><button class="btn btn-primary">Create</button></div></form>`
            : ''
        }
        <ul class="epic-list">
          ${
            plan.epics
              .map(
                (e) => `<li><button class="epic-item ${state.epic === e.key ? 'selected' : ''}" data-action="open-epic" data-key="${esc(e.key)}" style="--hue:${hue(e.key)}">
                  <span class="epic-name">${esc(e.title)}</span>
                  <span class="epic-meta"><span class="key">${esc(e.key)}</span> · ${e.progress.done}/${e.progress.total} done${
                    e.progress.points_total ? ` · ${e.progress.points_total} pts` : ''
                  }${e.status === 'done' ? ' · done' : ''}</span>
                  ${progressBar(e.progress)}
                </button></li>`,
              )
              .join('') || '<li class="muted">No epics yet.</li>'
          }
        </ul>
      </section>
      <section>
        <div class="section-head"><h3>Milestones</h3><button class="btn btn-ghost" data-action="manage-milestones">Manage</button></div>
        <ul class="epic-list">
          ${
            milestones
              .map(
                (m) => `<li class="ms-compact"><span class="epic-name">${icon('diamond', { size: 14 })}${esc(m.name)}</span>
                  <span class="epic-meta">${m.done}/${m.total} done${m.due_date ? ` · ${dueLabel(m)}` : ''}</span>${progressBar(m)}</li>`,
              )
              .join('') || '<li class="muted">No milestones.</li>'
          }
        </ul>
      </section>
      <section>
        <div class="section-head"><h3>Decisions</h3></div>
        <ul class="epic-list decision-list">
          ${
            decisions
              .map(
                (d) => `<li><details><summary><span class="decision-chip">${esc(d.id)}</span> ${esc(d.title)}</summary>
                  <div class="markdown">${markdown(d.decision)}</div>
                  ${d.rationale ? `<div class="markdown muted">${markdown(d.rationale)}</div>` : ''}
                  <div class="epic-meta">${esc(d.date)}${d.source_task ? ` · ${taskLink(d.source_task)}` : ''}${
                    d.tags.length ? ` · ${d.tags.map((x) => `<span class="label">${esc(x)}</span>`).join(' ')}` : ''
                  }</div></details></li>`,
              )
              .join('') || '<li class="muted">None yet. Tick “Record as decision” when you answer an agent\'s question.</li>'
          }
        </ul>
      </section>
    </aside>`;
  sizePlanKeys();
  $('.plan-main', els.plan).scrollTop = scroll;
  markSelection({ refocus: rowFocused });
  $('.sprint-form input[name="name"], .epic-form input', els.plan)?.focus();
}

function bindPlan() {
  els.plan.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-action]');
    const action = button?.dataset.action;
    const sprintId = Number(e.target.closest('[data-sprint]')?.dataset.sprint) || Number(e.target.closest('.sprint-form')?.dataset.id);
    const sprint = state.plan?.sprints.find((s) => s.id === sprintId);
    const patchSprint = async (body) => {
      if (await attempt(api(`/api/sprints/${sprintId}`, { method: 'PATCH', body }))) await loadBoard();
    };

    if (!action) {
      const row = e.target.closest('.plan-row');
      if (row && !e.target.closest('a')) openTask(row.dataset.key);
      return;
    }
    if (action === 'new-sprint') {
      state.sprintEditing = 'new';
      renderPlan();
    } else if (action === 'edit-sprint') {
      state.sprintEditing = sprintId;
      renderPlan();
    } else if (action === 'cancel-sprint') {
      state.sprintEditing = null;
      renderPlan();
    } else if (action === 'delete-sprint') {
      confirmClick(button, 'Delete? Tasks become unscheduled', async () => {
        if (!(await attempt(api(`/api/sprints/${sprintId}`, { method: 'DELETE' })))) return;
        state.sprintEditing = null;
        await loadBoard();
      });
    } else if (action === 'start-sprint') {
      await patchSprint({ status: 'active' });
    } else if (action === 'complete-sprint') {
      confirmClick(button, button.dataset.confirm, () => patchSprint({ status: 'completed' }));
    } else if (action === 'reopen-sprint' && sprint) {
      await patchSprint({ status: 'planned' });
    } else if (action === 'new-epic') {
      state.epicCreating = true;
      renderPlan();
    } else if (action === 'cancel-epic') {
      state.epicCreating = false;
      renderPlan();
    } else if (action === 'open-epic') {
      openTask(button.dataset.key);
    } else if (action === 'manage-milestones') {
      state.msEditing = null;
      renderMilestonesModal();
    }
  });

  els.plan.addEventListener('keydown', (e) => {
    const row = e.target.closest('.plan-row');
    if (row && e.key === 'Enter') openTask(row.dataset.key);
  });

  els.plan.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.matches('.epic-form')) {
      const title = new FormData(form).get('title').trim();
      const epic = await attempt(api(`/api/projects/${state.projectKey}/epics`, { method: 'POST', body: { title } }));
      if (!epic) return;
      state.epicCreating = false;
      await loadBoard();
    } else if (form.matches('.sprint-form')) {
      const data = Object.fromEntries(new FormData(form));
      for (const k of ['start_date', 'end_date']) data[k] = data[k] || null;
      if (!data.name.trim()) delete data.name;
      const id = form.dataset.id;
      const saved =
        id === 'new'
          ? await attempt(api(`/api/projects/${state.projectKey}/sprints`, { method: 'POST', body: data }))
          : await attempt(api(`/api/sprints/${id}`, { method: 'PATCH', body: data }));
      if (!saved) return;
      state.sprintEditing = null;
      await loadBoard();
    }
  });

  // Drag rows between sprints (or to Unscheduled) to schedule them.
  els.plan.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.plan-row');
    if (!row) return;
    state.planDrag = row.dataset.key;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.key);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  els.plan.addEventListener('dragend', () => {
    state.planDrag = null;
    for (const el of $$('.drop-target, .dragging', els.plan)) el.classList.remove('drop-target', 'dragging');
  });
  els.plan.addEventListener('dragover', (e) => {
    const section = e.target.closest('.sprint[data-sprint]');
    if (!section || !state.planDrag) return;
    e.preventDefault();
    if (!section.classList.contains('drop-target')) {
      for (const el of $$('.drop-target', els.plan)) el.classList.remove('drop-target');
      section.classList.add('drop-target');
    }
  });
  els.plan.addEventListener('drop', async (e) => {
    const section = e.target.closest('.sprint[data-sprint]');
    if (!section || !state.planDrag) return;
    e.preventDefault();
    const key = state.planDrag;
    state.planDrag = null;
    const target = section.dataset.sprint === 'none' ? null : Number(section.dataset.sprint);
    const task = [...state.plan.unscheduled, ...state.plan.sprints.flatMap((s) => s.tasks)].find((t) => t.key === key);
    if (!task || (task.sprint_id ?? null) === target) return renderPlan();
    if (await attempt(api(`/api/tasks/${key}`, { method: 'PATCH', body: { sprint: target } }))) await loadBoard();
  });
}

// ------------------------------------------------------------------- review

async function loadReview() {
  if (!state.projectKey) return;
  if (state.review === null) renderReview();
  const queue = await attempt(api(`/api/projects/${state.projectKey}/review`));
  if (!queue) return;
  state.review = queue;
  // Don't yank the feedback box out from under someone typing; drafts survive re-renders anyway.
  if (!document.activeElement?.matches('#review textarea')) renderReview();
}

// The line of facts a reviewer scans first: checks, warnings, criteria.
function reviewFactsHtml(t, agentItems, done) {
  const h = t.handoff ?? {};
  const checks = (h.checks ?? [])
    .map(
      (c) => `<span class="fact ${c.passed ? 'fact-pass' : 'fact-fail'}" title="${c.passed ? 'Passed' : 'Failed'}">${
        c.passed ? icon('check', { size: 12 }) : icon('x', { size: 12 })
      }${esc(c.name)}</span>`,
    )
    .join('');
  const warnings = (h.warnings?.length ?? 0) + (h.violations?.length ?? 0);
  return `<div class="review-facts">
    ${checks || '<span class="fact muted">No checks reported</span>'}
    <span class="fact ${warnings ? 'fact-warn' : 'muted'}">${icon('triangle-alert', { size: 12 })}${warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'No warnings'}</span>
    ${
      agentItems.length
        ? `<span class="fact ${done < agentItems.length ? 'fact-warn' : 'fact-pass'}">${icon('square-check-big', { size: 12 })}${done}/${agentItems.length} criteria</span>`
        : ''
    }
  </div>`;
}

function reviewCardHtml(t, index = 0) {
  const round = reviewRound(t);
  const lastChanges = [...t.reviews].reverse().find((r) => r.event === 'changes_requested');
  const human = t.criteria.filter((c) => c.owner === 'human');
  const agentItems = t.criteria.filter((c) => c.owner !== 'human');
  const done = agentItems.filter((c) => c.done).length;
  const by = t.handoff?.submitted_by ?? t.assignee;
  const lead = t.handoff?.summary.split(/\n\s*\n/)[0] ?? '';
  // Open on the first card, closed on the rest, unless the Director toggled it this session.
  const open = state.reviewOpen[t.key] ?? index === 0;
  const h = t.handoff;
  const detailBits = h
    ? [
        h.files.length && `${h.files.length} file${h.files.length === 1 ? '' : 's'}`,
        h.verify && 'how to verify',
        h.media.length && `${h.media.length} media`,
        agentItems.length && 'criteria with evidence',
      ].filter(Boolean)
    : [];
  return `
    <article class="review-card" data-key="${esc(t.key)}">
      <header class="review-head">
        ${statusIcon(t.status)}
        ${taskLink(t.key)}
        <span class="type type-${t.type}">${esc(t.type)}</span>
        ${priorityBadge(t.priority)}
        ${t.epic ? epicChip(t.epic) : ''}
        ${round > 1 ? `<span class="round" title="Submitted ${round} times">round ${round}</span>` : ''}
        <span class="spacer"></span>
        ${by ? `<span class="who">${avatar(by)}${esc(by)}</span>` : ''}
        ${t.handoff ? `<time class="muted" title="${fullDate(t.handoff.submitted_at)}">${ago(t.handoff.submitted_at)}</time>` : ''}
      </header>
      <h3 class="review-title"><a href="#/${esc(t.key)}">${esc(t.title)}</a></h3>
      ${reviewFactsHtml(t, agentItems, done)}
      ${
        human.length
          ? `<div class="review-block for-director"><h4>For you to check · ${human.filter((c) => c.done).length}/${human.length}</h4>
              ${criteriaHtml(t, { checkable: true, only: 'human' })}</div>`
          : ''
      }
      ${lead ? `<div class="markdown review-lead">${markdown(lead)}</div>` : ''}
      <details class="review-details" data-key="${esc(t.key)}" ${open ? 'open' : ''}>
        <summary>${icon('chevron-right', { size: 14, cls: 'disclosure' })}Details${detailBits.length ? ` <span class="muted">· ${detailBits.join(' · ')}</span>` : ''}</summary>
      <div class="review-details-body">
      ${handoffHtml(t, { skipLead: true })}
      ${
        agentItems.length
          ? `<div class="review-block"><h4>Acceptance criteria · ${done}/${agentItems.length}${
              done < agentItems.length ? ' <span class="warn">not all met</span>' : ''
            }</h4>${criteriaHtml(t, { only: 'agent' })}</div>`
          : ''
      }
      ${(() => {
        const inHandoff = handoffMediaIds(t);
        const rest = t.attachments.filter((a) => !inHandoff.has(String(a.id)));
        return rest.length ? `<div class="review-block"><h4>Attachments</h4>${attachmentsHtml(rest, { removable: false })}</div>` : '';
      })()}
      ${
        lastChanges
          ? `<details class="prev-feedback"><summary>Your feedback in round ${lastChanges.round}</summary><div class="markdown">${markdown(lastChanges.feedback)}</div></details>`
          : ''
      }
      </div>
      </details>
      ${reviewActionsHtml(t)}
    </article>`;
}

function renderReview() {
  if (state.view !== 'review') return;
  if (state.review === null) {
    els.review.innerHTML = skeleton('review');
    return;
  }
  const queue = state.review;
  const visible = queue.filter((t) => matchesFilter(t));
  const hidden = queue.length - visible.length;
  els.review.innerHTML = `
    <div class="review-main">
      <div class="plan-toolbar">
        <h2>Review</h2>
        <span class="muted">${queue.length ? `${queue.length} waiting${hidden ? ` · ${hidden} hidden by filters` : ''}` : ''}</span>
      </div>
      ${
        visible.length
          ? visible.map((t, i) => reviewCardHtml(t, i)).join('')
          : queue.length
            ? emptyState({
                icon: 'list-filter',
                title: 'Nothing matches the filters',
                action: '<button class="btn" data-action="clear-filters">Clear filters</button>',
              })
            : emptyState({
                icon: 'circle-check',
                title: 'Nothing to review',
                text: 'When agents call <code>submit_for_review</code>, their handoffs land here: what changed, where, how to verify, and screenshots.',
                action: '<button class="btn" data-action="go-board">Go to the board</button>',
              })
      }
    </div>`;
}

function bindReview() {
  // Remember which cards the Director opened or closed while the page is open.
  els.review.addEventListener(
    'toggle',
    (e) => {
      if (e.target.matches?.('.review-details')) state.reviewOpen[e.target.dataset.key] = e.target.open;
    },
    true,
  );
  // The Director ticks their own criteria right on the review card.
  els.review.addEventListener('change', async (e) => {
    const card = e.target.closest('.review-card');
    if (!card || e.target.dataset.criterion === undefined) return;
    const body = { items: [Number(e.target.dataset.criterion)], done: e.target.checked };
    if (await attempt(api(`/api/tasks/${card.dataset.key}/criteria`, { method: 'POST', body }))) await loadReview();
    else e.target.checked = !e.target.checked;
  });
  els.review.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    const card = e.target.closest('.review-card');
    if (!action || !card) return;
    reviewAction(action, card.dataset.key, card);
  });
  els.review.addEventListener('input', (e) => {
    if (e.target.matches('textarea.feedback')) state.reviewDrafts[e.target.dataset.key] = e.target.value;
  });
  els.review.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea.feedback') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      reviewAction('send-back', e.target.dataset.key, e.target.closest('.review-card'));
    }
  });
  els.review.addEventListener('focusout', () => setTimeout(() => !els.review.contains(document.activeElement) && renderReview(), 200));
}

// -------------------------------------------------------------------- inbox

async function loadInbox() {
  if (!state.projectKey) return;
  if (!state.inbox && state.view === 'inbox') renderInbox();
  const inbox = await api(`/api/projects/${state.projectKey}/inbox?me=${encodeURIComponent(state.me)}`).catch(() => null);
  if (!inbox || inbox.project !== state.projectKey) return;
  state.inbox = inbox;
  els.inboxCount.hidden = inbox.count === 0;
  els.inboxCount.textContent = inbox.count;
  const blocking = inbox.items.filter(blocksAgents).length;
  els.inboxCount.classList.toggle('blocking', blocking > 0);
  els.inboxCount.title = blocking ? `${blocking} waiting on you block agents` : `${inbox.count} waiting on you`;
  // Don't wipe an answer being typed.
  const typing = document.activeElement?.matches('#inbox textarea, #inbox input:not([type="checkbox"]):not([type="radio"])');
  if (state.view === 'inbox' && !typing) renderInbox();
}

// Items an agent is parked on until the Director acts: blocking questions and prerequisites (which stop claims).
const blocksAgents = (item) => (item.kind === 'question' && item.question.blocking) || item.kind === 'prerequisite';

const INBOX_KINDS = {
  question: { label: 'Question', hint: 'An agent is waiting for your answer' },
  review: { label: 'Review', hint: 'Submitted work to accept or send back' },
  prerequisite: { label: 'Setup', hint: 'Agents can’t start until you do this' },
  gate: { label: 'Your task', hint: 'Assigned to you, and nothing blocks it any more' },
  stale: { label: 'Stale claim', hint: 'Claimed, but nothing has happened on it for a while' },
};

function inboxItemHtml(item) {
  const kind = INBOX_KINDS[item.kind] ?? { label: item.kind, hint: '' };
  let body = '';
  if (item.kind === 'question') {
    body = questionHtml(item.question, null);
  } else if (item.kind === 'review') {
    const t = { key: item.task, criteria: item.criteria };
    body = `<p class="muted small">From ${esc(item.submitted_by ?? 'an agent')}${item.warnings ? ` · <span class="warn">${item.warnings} warning${item.warnings === 1 ? '' : 's'}</span>` : ''}${
      item.director_items_open ? ` · ${item.director_items_open} item${item.director_items_open === 1 ? '' : 's'} for you to check` : ''
    }</p>
      ${item.criteria.some((c) => c.owner === 'human') ? criteriaHtml(t, { checkable: true, only: 'human' }) : ''}
      <div class="actions"><button class="btn" data-action="open-review">Open in Review</button></div>`;
  } else if (item.kind === 'prerequisite') {
    body = `<ul class="checklist">${item.prerequisites
      .map((p) => `<li><label><input type="checkbox" data-prereq="${p.index}"><span>${inline(esc(p.text))}</span></label></li>`)
      .join('')}</ul>`;
  } else if (item.kind === 'gate') {
    body = `<p class="muted small">Assigned to ${esc(item.assignee)} · ${STATUS_NAMES[item.status]}</p>`;
  } else if (item.kind === 'stale') {
    body = `<p class="muted small">${esc(item.assignee)} claimed it; no activity for ${esc(item.idle)}. The claim is kept.</p>`;
  }
  return `<article class="inbox-item kind-${item.kind}" data-key="${esc(item.task)}">
    <header class="review-head"><span class="inbox-kind" title="${esc(kind.hint)}">${esc(kind.label)}</span>${taskLink(item.task)}
      <span class="inbox-title">${esc(item.title)}</span><span class="spacer"></span>
      <time class="muted small" title="${fullDate(item.since)}">${ago(item.since)}</time></header>
    ${body}
  </article>`;
}

// Two groups: what agents are parked on (blocking questions, then prerequisites), then everything else.
// The API sends items oldest first, and each group keeps that order.
function inboxGroupsHtml(items) {
  const blocking = [
    ...items.filter((i) => i.kind === 'question' && i.question.blocking),
    ...items.filter((i) => i.kind === 'prerequisite'),
  ];
  const rest = items.filter((i) => !blocksAgents(i));
  const group = (title, hint, list, cls) =>
    list.length
      ? `<section class="inbox-group ${cls}"><h3 class="inbox-group-head">${esc(title)} <span class="count">${list.length}</span>
          <span class="muted small">${esc(hint)}</span></h3>${list.map(inboxItemHtml).join('')}</section>`
      : '';
  return (
    group('Blocking agents', 'an agent waits until you act', blocking, 'blocking') +
    group(blocking.length ? 'Everything else' : 'Waiting on you', 'reviews, questions, gates, stale claims', rest, 'rest')
  );
}

// Answers in progress survive re-renders (live updates arrive while you type).
function saveFormDrafts(root) {
  return Object.fromEntries(
    $$('.question-form', root).map((form) => [
      form.dataset.question,
      $$('input, textarea', form).map((el) => (el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value)),
    ]),
  );
}

function restoreFormDrafts(root, drafts) {
  for (const form of $$('.question-form', root)) {
    const values = drafts[form.dataset.question];
    if (!values) continue;
    $$('input, textarea', form).forEach((el, i) => {
      if (el.type === 'radio' || el.type === 'checkbox') el.checked = values[i];
      else el.value = values[i];
    });
    $('.q-decision-fields', form).hidden = !$('[name="record_decision"]', form).checked;
  }
}

function renderInbox() {
  if (state.view !== 'inbox') return;
  const inbox = state.inbox;
  if (!inbox) {
    els.inbox.innerHTML = state.projectKey ? skeleton('inbox') : '';
    return;
  }
  const drafts = saveFormDrafts(els.inbox);
  els.inbox.innerHTML = `
    <div class="review-main">
      <div class="plan-toolbar"><h2>Inbox</h2><span class="muted">${inbox?.count ? `${inbox.count} waiting on you · oldest first` : ''}</span></div>
      ${
        inbox?.items.length
          ? inboxGroupsHtml(inbox.items)
          : emptyState({
              icon: 'inbox',
              title: 'Nothing is waiting on you',
              text: "Agents' questions, work submitted for review (with the checks only you can make), setup steps that block agents, and tasks assigned to you that are ready to start show up here, oldest first.",
              action: '<button class="btn" data-action="go-board">Go to the board</button>',
            })
      }
    </div>`;
  restoreFormDrafts(els.inbox, drafts);
}

function bindInbox() {
  els.inbox.addEventListener('change', async (e) => {
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    const key = item.dataset.key;
    let path = null;
    if (e.target.dataset.prereq !== undefined) path = { url: `/api/tasks/${key}/prerequisites`, index: e.target.dataset.prereq };
    else if (e.target.dataset.criterion !== undefined) path = { url: `/api/tasks/${key}/criteria`, index: e.target.dataset.criterion };
    if (!path) return;
    const ok = await attempt(api(path.url, { method: 'POST', body: { items: [Number(path.index)], done: e.target.checked } }));
    if (!ok) e.target.checked = !e.target.checked;
    await loadBoard();
  });
  els.inbox.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'open-review') setView('review');
  });
  els.inbox.addEventListener('focusout', () => setTimeout(() => !els.inbox.contains(document.activeElement) && renderInbox(), 300));
}

// ----------------------------------------------------------------- activity

async function loadActivity() {
  if (!state.activityOpen || !state.projectKey) return;
  const items = await api(`/api/activity?project=${state.projectKey}&limit=100`).catch(() => []);
  // Day separators, and one entry for a burst of actions by one actor on one task.
  els.activityList.innerHTML =
    groupActivity(items)
      .map(
        (day) => `<li class="day-sep">${esc(day.day)}</li>${day.entries
          .map(({ actor, items: [latest, ...earlier] }) => {
            const more = earlier.length
              ? `<details class="change-list merged" ${keptOpen(`more-${earlier.at(-1).id}`)}><summary>${earlier.length} more on ${esc(latest.task)}</summary><ul>${earlier
                  .map((a) => `<li>${describeActivity(a, { withTask: false })} <time title="${fullDate(a.created_at)}">${ago(a.created_at)}</time></li>`)
                  .join('')}</ul></details>`
              : '';
            return `<li>${avatar(actor)}<div><div class="what"><b>${esc(actor)}</b> ${describeActivity(latest)}</div>${more}
              <time title="${fullDate(latest.created_at)}">${ago(latest.created_at)}</time></div></li>`;
          })
          .join('')}`,
      )
      .join('') || '<li class="muted">Nothing yet.</li>';
}

const refreshActivity = debounce(loadActivity, 200);

function setActivityOpen(open) {
  state.activityOpen = open;
  store.set('kanban.activity', open ? '1' : '0');
  els.activity.hidden = !open;
  els.activityToggle.setAttribute('aria-pressed', String(open));
  if (open) loadActivity();
}

// ------------------------------------------------------------ live updates

let events = null;

function connectEvents() {
  events?.close();
  const url = `/api/events${state.apiKey ? `?api_key=${encodeURIComponent(state.apiKey)}` : ''}`;
  events = new EventSource(url);
  events.addEventListener('open', () => setLive(true));
  events.addEventListener('error', () => setLive(false));
  events.addEventListener('change', (e) => onServerChange(JSON.parse(e.data)));
}

function setLive(on) {
  els.live.className = `live ${on ? 'on' : 'off'}`;
  els.live.title = on ? 'Live: updates appear as agents work' : 'Disconnected — retrying…';
}

const reloadProjects = debounce(async () => {
  await loadProjects();
  if (state.projectKey && !state.projects.some((p) => p.key === state.projectKey)) {
    closeModal();
    state.projectKey = null;
    await applyHash();
  }
}, 150);

function onServerChange(event) {
  if (event.type.startsWith('project.')) reloadProjects();
  if (event.project !== state.projectKey) return;
  if (event.task && event.type !== 'task.deleted') state.flash.add(event.task);
  refreshBoard();
  refreshActivity();
  // An epic's modal lists its tasks, so refresh it when any of them changes.
  if (state.task?.type === 'epic' && event.task !== state.task.key) refreshTask();
  if (state.task && event.task === state.task.key) {
    if (event.type === 'task.deleted') closeModal();
    else refreshTask();
  }
}

// ------------------------------------------------------------------- misc UI

function openApiKeyModal() {
  if ($('[data-form="api-key"]', els.modalRoot)) return;
  openModal(`
    <form class="modal" data-form="api-key">
      <div class="modal-head"><h2>API key required</h2></div>
      <div class="modal-body">
        <label class="field"><span>API key</span><input name="key" type="password" autofocus autocomplete="off">
          <small>This server was started with API_KEY. It's stored in this browser only.</small></label>
        <div class="actions"><button class="btn btn-primary">Save</button></div>
      </div>
    </form>`);
  $('form', els.modalRoot).addEventListener('submit', async (e) => {
    e.preventDefault();
    state.apiKey = new FormData(e.target).get('key').trim();
    store.set('kanban.apiKey', state.apiKey);
    closeModal();
    connectEvents();
    await loadProjects();
    await applyHash();
  });
}

// ------------------------------------------------------------ Director key

async function loadAuth() {
  state.auth = await api('/api/auth').catch(() => null);
  renderDirectorMode();
}

// A header chip: "Open board" when any client may act as the Director, a key prompt when the
// server wants a key this browser doesn't have (or has wrong), and a quiet "Director" otherwise.
function renderDirectorMode() {
  const a = state.auth;
  const chip = els.directorMode;
  chip.hidden = !a;
  if (!a) return;
  if (!a.director_key_required) {
    chip.className = 'director-mode open';
    chip.textContent = 'Open board';
    chip.title = 'No DIRECTOR_KEY is set on the server, so any client that can reach this board, agents included, can act as the Director. Click for details.';
  } else if (a.role === 'director') {
    chip.className = 'director-mode ok';
    chip.textContent = 'Director';
    chip.title = 'Signed in with the Director key. Click to change or forget it.';
  } else {
    chip.className = 'director-mode locked';
    chip.textContent = a.director_key_accepted === false ? 'Director key rejected' : 'Enter Director key';
    chip.title = 'This board needs the Director key for your actions (ticking your criteria and prerequisites, answering questions). Until then you act as an agent.';
  }
}

function openDirectorKeyModal() {
  const a = state.auth ?? {};
  const open = !a.director_key_required;
  openModal(`
    <form class="modal" data-form="director-key">
      <div class="modal-head"><h2>${open ? 'This board runs open' : 'Director key'}</h2></div>
      <div class="modal-body">
        ${
          open
            ? `<p>The server has no <code>DIRECTOR_KEY</code>, so the Director role is only the <code>X-Role: director</code> header.
                Any client that can reach this board, agents included, can send it and tick your criteria, answer questions and tick prerequisites.</p>
               <p class="muted small">To lock it, start the server with <code>DIRECTOR_KEY</code> set (in Docker: <code>KANBAN_DIRECTOR_KEY</code> in <code>.env</code>), then enter the same key here. Don't give it to agents.</p>
               <div class="actions"><button type="button" class="btn" data-action="close">OK</button></div>`
            : `<label class="field"><span>Director key</span><input name="key" type="password" autocomplete="off" value="" autofocus>
                 <small>The server's DIRECTOR_KEY. It's stored in this browser only and sent with your requests.</small></label>
               ${a.director_key_accepted === false ? '<p class="warn small">The saved key was rejected.</p>' : ''}
               <div class="actions">
                 ${state.directorKey ? '<button type="button" class="btn btn-ghost" data-action="forget-director-key">Forget key</button>' : ''}
                 <button class="btn btn-primary">Save</button></div>`
        }
      </div>
    </form>`);
  const form = $('form', els.modalRoot);
  const setKey = async (key) => {
    state.directorKey = key;
    store.set('kanban.directorKey', key);
    closeModal();
    await loadAuth();
    if (key && state.auth?.role !== 'director') toast('That key was rejected', 'error');
    else if (key) toast('Signed in as the Director');
    refreshBoard();
    loadInbox();
  };
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close"]')) closeModal();
    if (e.target.closest('[data-action="forget-director-key"]')) setKey('');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setKey(new FormData(form).get('key').trim());
  });
}

// System → light → dark. theme.js applies the choice (and follows the system when there is none).
const THEMES = {
  system: { next: 'light', label: 'Theme: system', icon: 'monitor' },
  light: { next: 'dark', label: 'Theme: light', icon: 'sun' },
  dark: { next: 'system', label: 'Theme: dark', icon: 'moon' },
};

function renderThemeToggle() {
  const theme = THEMES[window.kanbanTheme?.get()] ?? THEMES.system;
  els.themeToggle.innerHTML = icon(theme.icon);
  els.themeToggle.title = `${theme.label} (click to change)`;
  els.themeToggle.setAttribute('aria-label', theme.label);
}

function bindTopbar() {
  els.directorMode.addEventListener('click', openDirectorKeyModal);
  renderThemeToggle();
  els.themeToggle.addEventListener('click', () => {
    window.kanbanTheme?.set((THEMES[window.kanbanTheme.get()] ?? THEMES.system).next);
    renderThemeToggle();
  });
  els.me.value = state.me;
  els.meAvatar.innerHTML = avatar(state.me);
  els.me.addEventListener('change', () => {
    state.me = els.me.value.trim() || 'human';
    els.me.value = state.me;
    els.meAvatar.innerHTML = avatar(state.me);
    store.set('kanban.me', state.me);
    loadInbox();
  });
  $('#new-project').addEventListener('click', () => openProjectModal());
  els.projectSettings.addEventListener('click', () => {
    const project = state.projects.find((p) => p.key === state.projectKey);
    if (project) openProjectModal(project);
  });
  els.search.addEventListener('input', () => {
    state.q = els.search.value.trim();
    renderView();
  });
  els.viewSwitch.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]')?.dataset.view;
    if (view && view !== state.view) setView(view);
  });
  els.activityToggle.addEventListener('click', () => setActivityOpen(!state.activityOpen));
  $('#activity-close').addEventListener('click', () => setActivityOpen(false));

  document.addEventListener('keydown', (e) => {
    const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
    // ⌘K (Ctrl+K elsewhere) opens the command palette from anywhere, even while typing.
    if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (paletteIsOpen()) closeMenu();
      else openCommandPalette();
      return;
    }
    if (paletteIsOpen()) return;
    // The sheet sits over everything else and takes only Esc and ? (to close it).
    if (sheetIsOpen()) {
      if (e.key === 'Escape' || (e.key === '?' && !typing)) {
        e.preventDefault();
        closeShortcutSheet();
      }
      return;
    }
    if (e.key === 'Escape' && els.modalRoot.firstChild) {
      if (state.descEditing) {
        state.descEditing = false;
        renderTaskModal(false);
      } else if (!typing || e.target.matches('.title-input')) {
        closeModal();
      } else {
        e.target.blur();
      }
    } else if (!shortcutsOn()) {
      // Single-key shortcuts are off (see the ? sheet).
    } else if (e.key === '/' && !typing && !els.modalRoot.firstChild) {
      e.preventDefault();
      els.search.focus();
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && !menuIsOpen() && !e.repeat) {
      handleShortcut(e);
    }
  });
  // Focusing a card or row (Tab, a click) selects it, so S, P and A act on it.
  document.addEventListener('focusin', (e) => {
    const item = e.target.closest?.('.card[data-key], .plan-row[data-key]');
    if (item && item === e.target && item.dataset.key !== state.selected) {
      state.selected = item.dataset.key;
      markSelection();
    }
  });

  // Click any code chip marked data-copy (branches, commits, paths) to copy it.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-copy]');
    if (el) navigator.clipboard?.writeText(el.dataset.copy).then(() => toast(`Copied ${el.dataset.copy}`));
  });

  window.addEventListener('hashchange', applyHash);
  // Keep relative timestamps fresh.
  setInterval(() => {
    if (state.activityOpen) loadActivity();
  }, 60000);
}

async function init() {
  bindMenus();
  bindSidebar();
  bindTopbar();
  bindFilters();
  bindBoard();
  bindPlan();
  bindReview();
  bindQuestionForms();
  bindInbox();
  bindImageFallback();
  bindDisclosures();
  setView(state.view);
  setActivityOpen(state.activityOpen);
  connectEvents();
  await loadAuth();
  await loadProjects();
  await applyHash();
}

init();
