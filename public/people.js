// Avatars for agents and people: a hue and initials derived from the name (tested in test/people.test.js).

// Golden-angle spread so similar strings (AS-21, AS-22) still get distinct colors.
export function hue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Math.round((h * 137.508) % 360);
}

// First letters of the first and the last part, so claude-code (CC) and claude-code-b (CB) differ.
// One-part names keep one letter (director → D).
export function initials(name) {
  const parts = String(name).split(/[\s\-_.]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}
