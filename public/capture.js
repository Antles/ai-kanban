// Phone-friendly playtest capture: one note (+ screenshots) becomes a backlog task
// labeled "playtest", ready for you or an agent to triage on the board.
import { icon, statusIcon, priorityIcon } from './icons.js';
import { menuButton, bindMenus } from './menu.js';

const KINDS = { bug: 'bug', tweak: 'task', idea: 'feature' };
const STATUS_NAMES = { backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
const TITLE_MAX = 120;

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

const $ = (sel) => document.querySelector(sel);
const els = {
  project: $('#project'),
  form: $('#capture-form'),
  keyForm: $('#key-form'),
  files: $('#files'),
  shots: $('#shots'),
  submit: $('#submit'),
  recent: $('#recent'),
  toasts: $('#toasts'),
};
const state = {
  project: '',
  projects: [],
  apiKey: store.get('kanban.apiKey', ''),
  files: [],
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2500);
}

const me = () => els.form.elements.me.value.trim() || 'human';

async function api(path, { method = 'GET', body, raw, type } = {}) {
  const headers = { 'X-Agent': me(), 'X-Role': 'director' };
  // The board's Director key (same browser storage), when the server requires one.
  const directorKey = store.get('kanban.directorKey', '');
  if (directorKey) headers['X-Director-Key'] = directorKey;
  if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
  if (raw) headers['Content-Type'] = type;
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  if (res.status === 401) {
    els.keyForm.hidden = false;
    els.keyForm.elements.key.focus();
    throw new Error('This board needs an API key');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data;
}

// "iPhone OS 17_5" → "iOS 17.5". The phone you capture on is usually the one you play on,
// so screen size and OS help reproduce layout bugs in a portrait game.
function deviceSummary() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)_(\d+)[_\d]* like Mac OS X/);
  const android = ua.match(/Android (\d+(?:\.\d+)?)/);
  const os = ios ? `iOS ${ios[1]}.${ios[2]}` : android ? `Android ${android[1]}` : navigator.platform || 'desktop';
  return `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 10) / 10}x · ${os}`;
}

function buildTask(form) {
  const note = form.elements.note.value.trim();
  const [first, ...rest] = note.split('\n');
  let title = first.trim();
  let details = rest.join('\n').trim();
  if (title.length > TITLE_MAX) {
    details = `${title}\n\n${details}`.trim();
    title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  }
  const build = form.elements.build.value.trim();
  const meta = [build && `**Build:** ${build}`, `**Device:** ${deviceSummary()}`].filter(Boolean).join(' · ');
  return {
    project: state.project,
    title,
    description: `${details ? `${details}\n\n` : ''}---\n${meta} · captured while playtesting`,
    type: KINDS[form.elements.kind.value],
    priority: form.elements.priority.value,
    labels: ['playtest'],
    status: 'backlog',
  };
}

function renderShots() {
  els.shots.innerHTML = state.files
    .map((f, i) => {
      const preview = f.type.startsWith('image/')
        ? `<img src="${f.url}" alt="">`
        : `<span class="shot-file">${icon('film')}${esc(f.file.name)}</span>`;
      return `<div class="shot">${preview}<button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(f.file.name)}">${icon('x', { size: 14 })}</button></div>`;
    })
    .join('');
}

function clearShots() {
  for (const f of state.files) URL.revokeObjectURL(f.url);
  state.files = [];
  els.files.value = '';
  renderShots();
}

async function loadProjects() {
  const projects = await api('/api/projects').catch((err) => {
    toast(err.message, 'error');
    return [];
  });
  const saved = store.get('kanban.captureProject', store.get('kanban.project', ''));
  state.projects = projects;
  state.project = projects.some((p) => p.key === saved) ? saved : (projects[0]?.key ?? '');
  renderProjectMenu();
  els.submit.disabled = projects.length === 0;
  if (!projects.length && !els.keyForm.hidden) return;
  if (!projects.length) {
    els.recent.innerHTML = '<li class="muted">Create a project on the board first.</li>';
    return;
  }
  loadRecent();
}

function renderProjectMenu() {
  els.project.innerHTML = state.projects.length
    ? menuButton('capture-project', {
        label: 'Project',
        variant: 'project-trigger',
        options: state.projects.map((p) => ({ value: p.key, label: p.name, hint: p.key })),
        value: state.project,
        onChange: (key) => {
          state.project = key;
          store.set('kanban.captureProject', key);
          renderProjectMenu();
          loadRecent();
        },
      })
    : '';
}

async function loadRecent() {
  if (!state.project) return;
  const tasks = await api(`/api/tasks?project=${encodeURIComponent(state.project)}&label=playtest&limit=1000`).catch(() => []);
  const recent = tasks.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
  els.recent.innerHTML =
    recent
      .map(
        (t) => `<li><a class="task-link" href="/#/${esc(t.key)}">${esc(t.key)}</a><span class="title">${esc(t.title)}</span>
          ${t.attachment_count ? `<span class="muted meta" title="${t.attachment_count} attachments">${icon('paperclip', { size: 14 })}${t.attachment_count}</span>` : ''}
          <span class="status-pill">${statusIcon(t.status, { decorative: true })}${STATUS_NAMES[t.status]}</span>
          <time class="muted">${ago(t.created_at)}</time></li>`,
      )
      .join('') || '<li class="muted">Nothing captured yet.</li>';
}

async function submit(e) {
  e.preventDefault();
  const task = buildTask(els.form);
  if (!task.title) return;
  els.submit.disabled = true;
  els.submit.textContent = 'Saving…';
  try {
    const created = await api('/api/tasks', { method: 'POST', body: task });
    let failed = 0;
    for (const { file } of state.files) {
      els.submit.textContent = `Uploading ${file.name}…`;
      await api(`/api/tasks/${created.key}/attachments?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        raw: file,
        type: file.type,
      }).catch((err) => {
        failed++;
        toast(`${file.name}: ${err.message}`, 'error');
      });
    }
    toast(failed ? `${created.key} saved, ${failed} upload${failed > 1 ? 's' : ''} failed` : `Captured ${created.key}`, failed ? 'error' : '');
    els.form.elements.note.value = '';
    clearShots();
    loadRecent();
    els.form.elements.note.focus();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = 'Capture';
  }
}

function init() {
  const { form } = els;
  for (const el of document.querySelectorAll('[data-priority]')) el.insertAdjacentHTML('afterbegin', priorityIcon(el.dataset.priority, { decorative: true }));
  form.elements.me.value = store.get('kanban.me', '');
  form.elements.build.value = store.get('kanban.build', '');
  form.elements.me.addEventListener('change', () => store.set('kanban.me', form.elements.me.value.trim()));
  form.elements.build.addEventListener('change', () => store.set('kanban.build', form.elements.build.value.trim()));
  bindMenus();
  els.files.addEventListener('change', () => {
    for (const file of els.files.files) state.files.push({ file, type: file.type, url: URL.createObjectURL(file) });
    els.files.value = '';
    renderShots();
  });
  els.shots.addEventListener('click', (e) => {
    const i = e.target.closest('[data-remove]')?.dataset.remove;
    if (i === undefined) return;
    URL.revokeObjectURL(state.files[i].url);
    state.files.splice(Number(i), 1);
    renderShots();
  });
  form.addEventListener('submit', submit);
  form.elements.note.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  els.keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    state.apiKey = els.keyForm.elements.key.value.trim();
    store.set('kanban.apiKey', state.apiKey);
    els.keyForm.hidden = true;
    loadProjects();
  });
  loadProjects();
}

init();
