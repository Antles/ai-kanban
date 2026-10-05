// WCAG contrast for the design tokens in public/styles.css. Shared by the token test and by
// docs/design-system.md's table (node test/design-contrast.js prints it).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEXT = ['text-1', 'text-2', 'text-3', 'accent-text', 'danger-text', 'success-text', 'warning-text', 'review-text', 'info-text', 'attention-text'];
const SURFACES = ['bg', 'surface-1', 'surface-2', 'surface-3'];

// [text token, surfaces it is used on]. Fills with text on them are listed too.
export const TEXT_PAIRS = [
  ...TEXT.map((t) => [t, SURFACES]),
  ['on-accent', ['accent', 'accent-hover', 'accent-active', 'danger']],
  ['on-attention', ['attention']],
];

const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Hex color tokens of a theme: the dark :root block, with the light block over it for "light".
export function themeTokens(css, theme) {
  const block = (re) => {
    const m = css.match(re);
    return Object.fromEntries([...(m?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)].map((x) => [x[1], x[2]]));
  };
  const dark = block(/:root\s*\{([^}]*)\}/);
  return theme === 'light' ? { ...dark, ...block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/) } : dark;
}

// The minimum ratio of each text token across its surfaces, per theme (for the docs).
export function contrastTable(css) {
  return TEXT_PAIRS.map(([text, surfaces]) => {
    const row = { text, surfaces };
    for (const theme of ['dark', 'light']) {
      const t = themeTokens(css, theme);
      row[theme] = Math.min(...surfaces.map((s) => contrast(t[text], t[s])));
    }
    return row;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  console.log('| Text token | On | Dark (min) | Light (min) |\n|---|---|---|---|');
  for (const r of contrastTable(css)) {
    console.log(`| \`--${r.text}\` | ${r.surfaces.map((s) => `\`--${s}\``).join(', ')} | ${r.dark.toFixed(2)}:1 | ${r.light.toFixed(2)}:1 |`);
  }
}
