import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { icon, statusIcon, priorityIcon } from '../public/icons.js';

const read = (file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const sources = Object.fromEntries(
  fs
    .readdirSync(new URL('../public/', import.meta.url))
    .filter((f) => /\.(js|html|css)$/.test(f))
    .map((f) => [f, read(f)]),
);
const sprite = read('icons.svg');

test('every icon the UI references is in the sprite, and the sprite holds only those', () => {
  const used = new Set();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/icons\.svg#i-([a-z0-9-]+)/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
  }
  const inSprite = new Set([...sprite.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const name of used) assert.ok(inSprite.has(name), `icons.svg lacks ${name}`);
  for (const name of inSprite) assert.ok(used.has(name), `icons.svg holds unused ${name}`);
  assert.ok(fs.existsSync(new URL('../public/icons-LICENSE.txt', import.meta.url)), 'the Lucide license ships with the sprite');
});

test('no emoji or text symbol is used as an icon in public/', () => {
  // Emoji, and the arrows, check marks and shapes that stood in for icons.
  const ICONISH = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}⇈↑↓↳◆☑⧉×✓✗→←]/u;
  for (const [file, src] of Object.entries(sources)) {
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may describe things with arrows
      const cleaned = line.replace(/(\d|\})\s*×\s*(\d|\$)/g, ''); // "1080×1920" is a size, not an icon
      assert.doesNotMatch(cleaned, ICONISH, `${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
});

test('every icon-only button has an aria-label', () => {
  for (const [file, src] of Object.entries(sources)) {
    if (file.endsWith('.css')) continue;
    for (const m of src.matchAll(/<button\b[^>]*class="[^"]*icon-btn[^"]*"[^>]*>/g)) {
      assert.match(m[0], /aria-label=/, `${file}: ${m[0].slice(0, 120)}`);
    }
  }
});

test('status and priority icons are labelled SVGs; decorative icons are hidden', () => {
  assert.match(statusIcon('in_progress'), /role="img" aria-label="In Progress" focusable="false"><title>In Progress<\/title>/);
  assert.match(statusIcon('backlog'), /stroke-dasharray/);
  assert.match(statusIcon('done'), /class="tick"/);
  assert.match(statusIcon('todo', { decorative: true }), /aria-hidden="true"/);
  assert.doesNotMatch(statusIcon('todo', { decorative: true }), /<title>/);
  assert.equal([...priorityIcon('low').matchAll(/opacity="0.3"/g)].length, 2, 'low: one bar lit');
  assert.equal([...priorityIcon('high').matchAll(/opacity="0.3"/g)].length, 0, 'high: all three lit');
  assert.match(priorityIcon('urgent'), /<title>Urgent priority<\/title>.*class="mark"/);
  assert.match(icon('x'), /aria-hidden="true".*#i-x/);
  assert.match(icon('x', { label: 'Close' }), /role="img" aria-label="Close"/);
});
