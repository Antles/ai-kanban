import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { contrast, themeTokens, TEXT_PAIRS } from './design-contrast.js';

// The stylesheet's rules: every size, radius and color lives in the token blocks (:root and
// :root[data-theme=…]); components only reference tokens. See docs/design-system.md.
const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Rule blocks outside the tokens (and @font-face), flattened to "selector { body }" strings.
function componentRules() {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim().replace(/^.*@media[^{]*$/s, '').trim();
    if (/^:root/.test(selector) || /@font-face/.test(m[1])) continue;
    rules.push({ selector, body: m[2] });
  }
  return rules;
}

test('styles.css has no raw hex color, font size or radius outside the token blocks', () => {
  for (const { selector, body } of componentRules()) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `hex color in ${selector}`);
    for (const [, value] of body.matchAll(/font-size:\s*([^;]+)/g)) {
      assert.match(value.trim(), /^(var\(--text-(xs|sm|md|lg|xl)\)|inherit)$/, `font-size ${value} in ${selector}`);
    }
    for (const [, value] of body.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;]+)/g)) {
      assert.match(value.trim(), /^((var\(--radius-(sm|md|lg|full)\)|0)\s*)+$/, `radius ${value} in ${selector}`);
    }
    assert.doesNotMatch(body, /(^|;)\s*font:(?!\s*inherit)/, `font shorthand in ${selector}`);
  }
});

test('at most 5 font sizes and 3 radii (plus fully round) are defined and used', () => {
  const sizes = new Set([...css.matchAll(/var\(--text-(xs|sm|md|lg|xl)\)/g)].map((m) => m[1]));
  const defined = [...css.matchAll(/--text-(\w+):\s*(\d+)px/g)].map((m) => Number(m[2]));
  assert.ok(new Set(defined).size <= 5, `font sizes defined: ${defined}`);
  assert.ok(sizes.size <= 5);
  const radii = new Set([...css.matchAll(/--radius-(\w+):/g)].map((m) => m[1]));
  assert.deepEqual([...radii].sort(), ['full', 'lg', 'md', 'sm']);
});

test('every text color token reaches 4.5:1 on the surfaces it is used on, in both themes', () => {
  for (const theme of ['dark', 'light']) {
    const tokens = themeTokens(css, theme);
    for (const [text, surfaces] of TEXT_PAIRS) {
      for (const surface of surfaces) {
        const ratio = contrast(tokens[text], tokens[surface]);
        assert.ok(ratio >= 4.5, `${theme}: --${text} on --${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('the page loads Inter from the repo, with its license', () => {
  for (const file of ['Inter-Regular.woff2', 'Inter-Medium.woff2', 'Inter-SemiBold.woff2', 'Inter-Italic.woff2', 'Inter-LICENSE.txt']) {
    assert.ok(fs.existsSync(new URL(`../public/fonts/${file}`, import.meta.url)), file);
  }
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) assert.match(m[1], /^'\/fonts\//, 'fonts are served by the board itself');
  for (const page of ['index.html', 'capture.html']) {
    const html = fs.readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /(src|href)="https?:/, `${page} loads nothing from another host`);
  }
});

test('text is never dimmed with opacity: partial opacity only on drag ghosts, disabled controls, icons and keyframes', () => {
  for (const { selector, body } of componentRules()) {
    for (const [, value] of body.matchAll(/(?:^|;)\s*opacity:\s*([\d.]+)/g)) {
      if (Number(value) === 0 || Number(value) === 1) continue;
      assert.match(selector, /dragging|disabled|status-icon|^\d+%$/, `opacity ${value} in ${selector}: use a quieter text token instead (docs/design-system.md)`);
    }
  }
});
