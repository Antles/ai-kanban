import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { filterOptions, triggerSummary, menuButton } from '../public/menu.js';

const options = [
  { value: 'KB', label: 'AI Kanban', hint: 'KB' },
  { value: 'MG', label: 'My Game', hint: 'MG' },
  { value: 'SANDBOX', label: 'Sandbox (agent feedback)', hint: 'SANDBOX' },
];

test('typing filters on label, hint and value, every word', () => {
  assert.deepEqual(filterOptions(options, 'sand').map((o) => o.value), ['SANDBOX']);
  assert.deepEqual(filterOptions(options, 'kb').map((o) => o.value), ['KB'], 'the hint (key) matches');
  assert.deepEqual(filterOptions(options, 'agent feed').map((o) => o.value), ['SANDBOX']);
  assert.equal(filterOptions(options, '').length, 3);
  assert.equal(filterOptions(options, 'zzz').length, 0);
});

test('the trigger shows the full choice (truncated by CSS, with a tooltip), or the placeholder', () => {
  assert.equal(triggerSummary({ options, value: 'SANDBOX' }).text, 'Sandbox (agent feedback)');
  assert.deepEqual(triggerSummary({ options, value: '', placeholder: 'None' }), { icon: '', text: 'None', empty: true });
  assert.equal(triggerSummary({ options, value: ['KB', 'MG'], multiple: true }).text, 'AI Kanban, My Game');
  assert.equal(triggerSummary({ options, value: ['new-label'], multiple: true }).text, 'new-label', 'free-typed values count');
  const html = menuButton('t', { label: 'Project', options, value: 'SANDBOX' });
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-label="Project: Sandbox \(agent feedback\)" title="Sandbox \(agent feedback\)"/);
});

test('no native <select> remains in public/', () => {
  for (const f of fs.readdirSync(new URL('../public/', import.meta.url))) {
    if (!/\.(js|html)$/.test(f)) continue;
    assert.doesNotMatch(fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), /<select\b/, f);
  }
});
