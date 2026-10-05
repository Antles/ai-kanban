// Builders for attachment chips and thumbnails. They take raw URLs and names and escape them
// here, so a URL decoded back out of the DOM can't break out of its attribute.
// Shared by the board and node tests (test/media.test.js).
import { icon } from './icons.js';
import { esc } from './markdown.js';

// Only web links and the board's own paths become hrefs; anything else (javascript:, data:) is dropped.
export const safeUrl = (url) => (/^(https?:\/\/|\/(?!\/))/i.test(String(url ?? '')) ? String(url) : '#');

// A file as a chip: icon and name, once.
export function fileChip(url, name, remove = '') {
  return `<span class="file-chip"><a href="${esc(safeUrl(url))}" target="_blank" rel="noopener" title="${esc(name)}">${icon('file-text', { size: 14 })}<span>${esc(name)}</span></a>${remove}</span>`;
}

// An image that fails to load becomes a file chip (see bindImageFallback in app.js).
export function imageHtml(url, name) {
  const href = esc(safeUrl(url));
  return `<a class="thumb" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${esc(name)}" loading="lazy" data-fallback="${esc(name)}"></a>`;
}
