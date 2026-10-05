// Fuzzy matching for the command palette (tested in test/fuzzy.test.js).

// How well `query` matches `text`: its letters must appear in order. Matches at word starts and runs
// of consecutive letters score higher, and an exact prefix beats everything. -1 when it doesn't match.
export function fuzzyScore(query, text) {
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, '');
  const t = String(text ?? '').toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    const wordStart = found === 0 || /[\s\-_./:]/.test(t[found - 1]);
    run = found === ti ? run + 1 : 0;
    score += 1 + (wordStart ? 8 : 0) + run * 4 - Math.min(found - ti, 10) * 0.5;
    ti = found + 1;
  }
  return score;
}

// Ranks items by their best-matching text, then by recency (lower `recent` = more recent); drops non-matches.
export function fuzzyRank(items, query, texts = (item) => [item.label], recent = () => Infinity) {
  if (!String(query ?? '').trim()) return items;
  return items
    .map((item, i) => ({ item, i, score: Math.max(...texts(item).map((s) => fuzzyScore(query, s))) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || recent(a.item) - recent(b.item) || a.i - b.i)
    .map((r) => r.item);
}
