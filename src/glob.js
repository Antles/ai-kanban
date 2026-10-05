// Minimal path globs for project rules (checks, protected paths, task scope):
//   **  any number of path segments      *  anything within one segment      ?  one character
// A glob without "/" matches the file name in any folder ("*.cs"); a trailing "/" means everything under it.
const cache = new Map();

export function globToRegExp(glob) {
  let g = String(glob).trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(file, glob) {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(String(file).replace(/^\.\//, ''));
}

export const matchesAny = (file, globs) => globs.some((g) => matchesGlob(file, g));

// Whether two globs can match a common file. Conservative: when both have wildcards, they overlap
// if their fixed leading parts agree ("sim/**" and "sim/**/Golden/**" do; "src/**" and "golden/**" don't).
export function globsOverlap(a, b) {
  const norm = (g) => {
    let x = String(g).trim().replace(/^\.\//, '');
    if (x.endsWith('/')) x += '**';
    return x.includes('/') ? x : `**/${x}`;
  };
  const [x, y] = [norm(a), norm(b)];
  const literal = (g) => !/[*?]/.test(g);
  if (literal(x)) return matchesGlob(x, y);
  if (literal(y)) return matchesGlob(y, x);
  const fixed = (g) => g.slice(0, g.search(/[*?]/));
  const [fx, fy] = [fixed(x), fixed(y)];
  return fx.startsWith(fy) || fy.startsWith(fx);
}
