// One dropdown menu for every choice on the board and the Capture page (WAI-ARIA combobox + listbox).
//
// menuButton(key, config) returns the trigger's HTML and remembers config under key, so a view can
// re-render its triggers freely. A click (or ↓, Enter, Space) on a trigger opens the menu under it:
// typing filters, ↑/↓ move, Enter picks, Esc closes and returns focus to the trigger.
//
// config: {
//   label: 'Status',                 // names the trigger and the listbox for screen readers
//   options: [{value, label, icon?, hint?, count?}] or () => [...],
//   value: 'todo' (or an array when multiple),
//   multiple: false,                 // multiple choice: rows toggle and the menu stays open
//   creatable: false,                // offer "Create “text”" when the filter matches nothing exactly
//   placeholder: 'None',             // trigger text when nothing is chosen
//   variant: '',                     // extra trigger class, e.g. 'ghost' or 'compact'
//   shortcut: 'S',                   // the key that opens it, shown in the trigger's tooltip
//   onChange(value),                 // the new value (array when multiple)
// }
// An option's `shortcut` shows as a key cap on its row.
import { icon } from './icons.js';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const configs = new Map();
let current = null; // the open menu: {key, config, el, input, list, items, active, query}
let uid = 0;

const optionsOf = (config) => (typeof config.options === 'function' ? config.options() : config.options) ?? [];
const selectedValues = (config) => (config.multiple ? (config.value ?? []) : [config.value ?? '']).map(String);

// Options whose label or hint contains every word of the query, in their original order.
export function filterOptions(options, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const hay = `${o.label} ${o.hint ?? ''} ${o.value}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// What the trigger shows: the chosen option(s), or the placeholder.
export function triggerSummary(config) {
  // A fixed trigger text ("Add…", "Edit…"), for menus whose value is shown elsewhere.
  if (config.triggerText) return { icon: config.triggerIcon ?? '', text: config.triggerText, empty: Boolean(config.triggerEmpty) };
  const options = optionsOf(config);
  const chosen = selectedValues(config).map((v) => options.find((o) => String(o.value) === v)).filter(Boolean);
  if (!config.multiple) return { icon: chosen[0]?.icon ?? '', text: chosen[0]?.label ?? config.placeholder ?? '', empty: !chosen[0] };
  if (!chosen.length) {
    // Values that aren't options (a free-typed label) still count.
    const raw = selectedValues(config).filter(Boolean);
    return { icon: '', text: raw.length ? raw.join(', ') : (config.placeholder ?? ''), empty: !raw.length };
  }
  const extra = selectedValues(config).length - chosen.length;
  return { icon: '', text: chosen.map((o) => o.label).join(', ') + (extra > 0 ? ` +${extra}` : ''), empty: false };
}

export function menuButton(key, config) {
  configs.set(key, config);
  const s = triggerSummary(config);
  const shortcut = config.shortcut ? ` aria-keyshortcuts="${esc(config.shortcut)}"` : '';
  const title = config.shortcut ? `${config.label}: ${s.text} (${config.shortcut})` : s.text;
  return `<button type="button" class="menu-trigger${config.variant ? ` ${esc(config.variant)}` : ''}${s.empty ? ' is-empty' : ''}"
    data-menu="${esc(key)}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(config.label)}: ${esc(s.text)}" title="${esc(title)}"${shortcut}>
    ${s.icon ? `<span class="menu-trigger-icon">${s.icon}</span>` : ''}<span class="menu-trigger-text">${esc(s.text)}</span>${icon('chevron-down', { size: 14, cls: 'menu-chevron' })}</button>`;
}

const triggerFor = (key) => document.querySelector(`[data-menu="${CSS.escape(key)}"]`);

function optionHtml(o, i, selected, multiple) {
  const isSelected = selected.includes(String(o.value));
  return `<li role="option" id="menu-opt-${uid}-${i}" data-index="${i}" aria-selected="${isSelected}" class="menu-option${o.create ? ' is-create' : ''}">
    ${multiple ? `<span class="menu-check" aria-hidden="true">${isSelected ? icon('check', { size: 12 }) : ''}</span>` : ''}
    ${o.icon ? `<span class="menu-option-icon">${o.icon}</span>` : ''}
    <span class="menu-option-label">${esc(o.label)}</span>
    ${o.hint ? `<span class="menu-option-hint">${esc(o.hint)}</span>` : ''}
    ${o.shortcut ? `<kbd class="menu-option-kbd">${esc(o.shortcut)}</kbd>` : ''}
    ${o.count !== undefined ? `<span class="menu-option-count">${esc(o.count)}</span>` : ''}
    ${!multiple && isSelected ? icon('check', { size: 14, cls: 'menu-selected' }) : ''}
  </li>`;
}

function renderList() {
  const { config, query } = current;
  // config.filter(options, query) replaces the default word filter (the command palette ranks fuzzily).
  const options = config.filter ? config.filter(optionsOf(config), query) : filterOptions(optionsOf(config), query);
  const q = query.trim();
  if (config.creatable && q && !optionsOf(config).some((o) => String(o.label).toLowerCase() === q.toLowerCase())) {
    options.push({ value: q, label: `Create “${q}”`, create: true, icon: icon('plus', { size: 14 }) });
  }
  current.items = options;
  current.active = Math.min(Math.max(current.active, 0), Math.max(options.length - 1, 0));
  const selected = selectedValues(config);
  // Options may carry a group ("Tasks", "Go to"); a header starts each run of one group.
  current.list.innerHTML = options.length
    ? options
        .map(
          (o, i) =>
            (o.group && o.group !== options[i - 1]?.group ? `<li class="menu-group" role="presentation">${esc(o.group)}</li>` : '') +
            optionHtml(o, i, selected, config.multiple),
        )
        .join('')
    : `<li class="menu-empty" role="presentation">${esc(config.emptyText ?? 'No matches')}</li>`;
  highlight();
}

function highlight() {
  const { list, input, active, items } = current;
  for (const li of list.querySelectorAll('[role="option"]')) li.classList.toggle('is-active', Number(li.dataset.index) === active);
  const li = list.querySelector(`[data-index="${active}"]`);
  if (items.length && li) {
    input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function place(trigger) {
  const { el } = current;
  const r = trigger.getBoundingClientRect();
  // A trigger sets the width; under a card or row (anchored), a menu stays menu-sized.
  el.style.minWidth = `${Math.max(current.anchored ? Math.min(r.width, 280) : r.width, 220)}px`;
  const height = el.offsetHeight;
  const below = window.innerHeight - r.bottom;
  const top = below < height + 8 && r.top > below ? Math.max(8, r.top - height - 4) : r.bottom + 4;
  const left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8);
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(8, left)}px`;
}

export function openMenu(key) {
  const trigger = triggerFor(key);
  const config = configs.get(key);
  if (!trigger || !config) return;
  openList(config, { key, trigger });
}

// The command palette: the same list and keys, centered near the top, with no trigger.
// Esc or a pick returns focus to wherever it was.
export function openPalette(config) {
  openList(config, { palette: true });
}

// A menu under any element (a selected card or row) rather than a trigger. Esc or a pick returns
// focus to wherever it was; onChange(value, option) runs only when the value changes.
export function openMenuAt(anchor, config) {
  openList(config, { trigger: anchor, anchored: true });
}

function openList(config, { key = null, trigger = null, palette = false, anchored = false }) {
  const returnFocus = document.activeElement;
  closeMenu({ restoreFocus: false });
  uid++;
  const el = document.createElement('div');
  el.className = palette ? 'menu palette' : 'menu';
  if (palette) {
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', config.label);
  }
  el.innerHTML = `<input class="menu-filter" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="menu-list-${uid}"
      aria-label="${esc(config.label)}: type to filter" placeholder="${esc(config.searchPlaceholder ?? `${config.label}…`)}" autocomplete="off" spellcheck="false">
    <ul class="menu-list" role="listbox" id="menu-list-${uid}" aria-label="${esc(config.label)}"${config.multiple ? ' aria-multiselectable="true"' : ''}></ul>`;
  document.body.append(el);
  const selected = selectedValues(config);
  const options = optionsOf(config);
  current = {
    key,
    config,
    el,
    palette,
    anchored,
    returnFocus,
    input: el.querySelector('input'),
    list: el.querySelector('ul'),
    items: [],
    query: '',
    active: Math.max(0, options.findIndex((o) => selected.includes(String(o.value)))),
  };
  if (palette) {
    const scrim = document.createElement('div');
    scrim.className = 'palette-scrim';
    scrim.addEventListener('mousedown', () => closeMenu());
    document.body.insertBefore(scrim, el);
    current.scrim = scrim;
  } else if (!anchored) {
    trigger.setAttribute('aria-expanded', 'true');
  }
  renderList();
  if (!palette) place(trigger);
  current.input.focus();
  current.input.addEventListener('input', () => {
    current.query = current.input.value;
    current.active = 0;
    renderList();
  });
  current.input.addEventListener('keydown', onKey);
  current.list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the filter
  current.list.addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) pick(Number(li.dataset.index));
  });
  current.list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li && Number(li.dataset.index) !== current.active) {
      current.active = Number(li.dataset.index);
      highlight();
    }
  });
}

export function closeMenu({ restoreFocus = true } = {}) {
  if (!current) return;
  const { key, el, palette, anchored, scrim, returnFocus } = current;
  current = null;
  el.remove();
  scrim?.remove();
  if (palette || anchored) {
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    return;
  }
  const trigger = triggerFor(key);
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
}

export const paletteIsOpen = () => Boolean(current?.palette);

export const menuIsOpen = () => current !== null;

function pick(index) {
  const { key, config, items } = current;
  const option = items[index];
  if (!option) return;
  if (config.multiple) {
    const values = selectedValues(config).filter(Boolean);
    const v = String(option.value);
    const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
    config.value = next;
    current.input.value = '';
    current.query = '';
    renderList();
    config.onChange?.(next);
    // The view may re-render the trigger; keep the menu with it.
    const trigger = triggerFor(key);
    if (trigger) place(trigger);
    return;
  }
  if (current.palette) {
    closeMenu();
    config.onChange?.(option.value, option);
    return;
  }
  if (current.anchored) {
    closeMenu();
    if (String(option.value) !== String(config.value ?? '')) config.onChange?.(option.value, option);
    return;
  }
  closeMenu();
  if (String(option.value) !== String(config.value ?? '')) {
    config.onChange?.(option.value);
    refocus(key);
  }
}

// A pick often re-renders the trigger; put focus back on the new one once the view settles.
function refocus(key) {
  for (const delay of [0, 300, 900]) {
    setTimeout(() => {
      if (document.activeElement === document.body || !document.activeElement?.isConnected) triggerFor(key)?.focus();
    }, delay);
  }
}

function onKey(e) {
  if (!current) return;
  const n = current.items.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    current.active = n ? (current.active + 1) % n : 0;
    highlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    current.active = n ? (current.active - 1 + n) % n : 0;
    highlight();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    current.active = e.key === 'Home' ? 0 : Math.max(0, n - 1);
    highlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(current.active);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === 'Tab') {
    closeMenu({ restoreFocus: false });
  }
}

// One set of document listeners serves every trigger, wherever and however often it's rendered.
export function bindMenus() {
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-menu]');
    if (trigger) {
      e.preventDefault();
      const key = trigger.dataset.menu;
      if (current?.key === key) closeMenu();
      else openMenu(key);
    }
  });
  document.addEventListener('keydown', (e) => {
    const trigger = e.target.closest?.('[data-menu]');
    if (trigger && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      openMenu(trigger.dataset.menu);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (current && !current.palette && !current.el.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu({ restoreFocus: false });
  });
  window.addEventListener('resize', () => current && !current.palette && closeMenu({ restoreFocus: false }));
  document.addEventListener(
    'scroll',
    (e) => {
      if (current && !current.palette && !current.el.contains(e.target)) closeMenu({ restoreFocus: false });
    },
    true,
  );
}
