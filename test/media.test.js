import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileChip, imageHtml, safeUrl } from '../public/media.js';

// The attribute values a tag carries, as the browser would split them: no quote may end one early.
const attrs = (html, tag) => {
  const m = new RegExp(`<${tag}\\s([^>]*)>`).exec(html);
  return [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => x[1]);
};

const EVIL = 'https://x.invalid/a"data-pwn="1"onmouseover="window.__pwned=1".png';

test('a file chip escapes a quote-laden URL and name, so they stay inside their attributes', () => {
  const html = fileChip(EVIL, 'a"onclick="x".png');
  assert.deepEqual(attrs(html, 'a'), ['href', 'target', 'rel', 'title']);
  assert.ok(!html.includes('onmouseover="'), html);
  assert.match(html, /href="https:\/\/x\.invalid\/a&quot;data-pwn=&quot;1&quot;onmouseover=/);
});

test('a thumbnail escapes its URL in both the link and the image', () => {
  const html = imageHtml('/api/attachments/999999?"x="1', 'attachment 999999');
  assert.deepEqual(attrs(html, 'a'), ['class', 'href', 'target', 'rel']);
  assert.deepEqual(attrs(html, 'img'), ['src', 'alt', 'loading', 'data-fallback']);
  assert.ok(html.includes('src="/api/attachments/999999?&quot;x=&quot;1"'), html);
});

test('only web links and board paths become hrefs', () => {
  assert.equal(safeUrl('/api/attachments/3?api_key=k'), '/api/attachments/3?api_key=k');
  assert.equal(safeUrl('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('//evil.example/a.png'), '#');
  assert.equal(safeUrl('data:text/html,x'), '#');
  assert.match(fileChip('javascript:alert(1)', 'x'), /href="#"/);
});
