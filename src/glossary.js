// Project glossary: the words to use, and the ones to avoid ("unit" where the term is "Hero").
// Linting is whole-word, case-insensitive, and only ever produces warnings.

// Parses CONTEXT.md-style Markdown: a "**Term**:" line starts an entry and an "_Avoid_: a, b (note)"
// line lists words to avoid. A quoted phrase in a note that contains the avoided word ("unit test")
// is allowed. Avoid-words that are glossary terms themselves ("plan" when Plan is a term) are dropped.
export function parseGlossary(markdown) {
  const entries = [];
  let current = null;
  for (const line of String(markdown).split('\n')) {
    const term = line.match(/^\s*\*\*([^*]+?)\*\*\s*:/);
    if (term) {
      current = { term: term[1].trim(), avoid: [], allow: [] };
      entries.push(current);
      continue;
    }
    const avoid = line.match(/^\s*_Avoid_\s*:\s*(.*)$/i);
    if (!avoid || !current) continue;
    const quoted = [...avoid[1].matchAll(/"([^"]+)"|“([^”]+)”/g)].map((m) => m[1] ?? m[2]);
    // Split on commas outside parentheses, then drop each item's parenthetical note.
    let depth = 0;
    let item = '';
    const items = [];
    for (const ch of avoid[1]) {
      if (ch === '(') depth++;
      if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        items.push(item);
        item = '';
      } else item += ch;
    }
    items.push(item);
    for (const raw of items) {
      // A quoted phrase followed by a note ('"the release" on its own') avoids just the phrase.
      const lead = raw.trim().match(/^(?:"([^"]+)"|“([^”]+)”)/);
      const word = lead ? (lead[1] ?? lead[2]).trim() : raw.replace(/\([^)]*\)?/g, '').trim();
      if (!word) continue;
      current.avoid.push(word);
      current.allow.push(...quoted.filter((q) => q.toLowerCase().includes(word.toLowerCase()) && q.toLowerCase() !== word.toLowerCase()));
    }
  }
  const terms = new Set(entries.map((e) => e.term.toLowerCase()));
  return entries
    .map((e) => ({
      term: e.term,
      avoid: [...new Set(e.avoid.filter((w) => !terms.has(w.toLowerCase())))],
      ...(e.allow.length && { allow: [...new Set(e.allow)] }),
    }))
    .filter((e) => e.avoid.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Spaces in a phrase match any run of whitespace; in an allowed phrase, hyphens too ("unit-test").
const phraseRe = (w, gap = '\\s+') => escapeRe(w.trim()).replace(/\s+/g, gap);
const wordRe = (w, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}_])${phraseRe(w)}(?![\\p{L}\\p{N}_])`, flags);

// fields: {title: '...', description: '...', ...}. Code (`like this`, fenced blocks) is skipped,
// since identifiers aren't prose. Returns [{term, word, field}].
export function lintGlossary(glossary, fields) {
  const found = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    let prose = String(value).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    // Using a term is never wrong, even when it contains an avoided word ("base" in "Home Base").
    for (const entry of glossary) prose = prose.replace(wordRe(entry.term, 'giu'), ' ');
    for (const entry of glossary) {
      let text = prose;
      for (const phrase of entry.allow ?? []) text = text.replace(new RegExp(phraseRe(phrase, '[\\s-]+'), 'giu'), ' ');
      for (const word of entry.avoid) {
        if (wordRe(word).test(text)) found.push({ term: entry.term, word, field });
      }
    }
  }
  return found;
}

export const glossaryWarning = (w) => `Glossary: say "${w.term}", not "${w.word}" (${w.field.replace('_', ' ')}).`;
