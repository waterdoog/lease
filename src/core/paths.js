// Path patterns an agent declares when it claims work, and the overlap test
// that decides whether two claims collide.
//
// Syntax (repository-relative, forward slashes):
//   src/auth            a path with no wildcard means that path and everything under it
//   src/auth/*.ts       `*` matches within one segment, `?` matches one character
//   src/**/session.ts   `**` matches zero or more whole segments
//
// Two patterns overlap when at least one concrete file path matches both.
// The test is exact for this syntax, not a heuristic: it never misses a
// collision, and it never reports one that no real file could cause.

export const MAX_PATTERN_LENGTH = 300;

export function normalizePattern(raw) {
  if (typeof raw !== 'string') return { error: 'path must be text' };
  let p = raw.trim().replace(/\\/g, '/');
  if (!p) return { error: 'empty path' };
  if (p.length > MAX_PATTERN_LENGTH) return { error: `path longer than ${MAX_PATTERN_LENGTH} characters` };
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) return { error: `"${raw}" must be relative to the repository root` };
  p = p.replace(/^(\.\/)+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!p || p === '.') return { pattern: '**' };
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) return { error: `"${raw}" must not contain ".."` };
  const cleaned = segments.filter((s) => s !== '.');
  // collapse runs of ** (a/**/**/b == a/**/b)
  const collapsed = cleaned.filter((s, i) => !(s === '**' && cleaned[i - 1] === '**'));
  return { pattern: collapsed.join('/') };
}

export function parsePathList(input) {
  // Accepts an array or a comma / newline / whitespace separated string.
  const items = Array.isArray(input)
    ? input
    : String(input ?? '')
        .split(/[,\n]+|\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
  const patterns = [];
  const errors = [];
  for (const item of items) {
    const { pattern, error } = normalizePattern(item);
    if (error) errors.push(error);
    else if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return { patterns, errors };
}

const hasWildcard = (s) => /[*?]/.test(s);

function toSegments(pattern) {
  const segs = pattern.split('/');
  // A wildcard-free pattern names a file or a directory: cover what is under it.
  if (!segs.some(hasWildcard)) segs.push('**');
  return segs;
}

// Can one string of non-slash characters match both single-segment globs?
export function segmentsOverlap(a, b) {
  const memo = new Map();
  const go = (i, j) => {
    const k = i * 1000 + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === a.length && j === b.length) r = true;
    else if (i < a.length && a[i] === '*') {
      // `*` matches nothing, or eats one character of b (whatever b has there)
      r = go(i + 1, j) || (j < b.length && go(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      r = go(i, j + 1) || (i < a.length && go(i + 1, j));
    } else if (i === a.length || j === b.length) r = false;
    else if (a[i] === '?' || b[j] === '?' || a[i] === b[j]) r = go(i + 1, j + 1);
    else r = false;
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

function seqOverlap(A, B) {
  const memo = new Map();
  const go = (i, j) => {
    const k = i * 1000 + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i < A.length && A[i] === '**') r = go(i + 1, j) || (j < B.length && go(i, j + 1));
    else if (j < B.length && B[j] === '**') r = go(i, j + 1) || (i < A.length && go(i + 1, j));
    else if (i === A.length || j === B.length) r = false;
    else r = segmentsOverlap(A[i], B[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

export function patternsOverlap(p1, p2) {
  return seqOverlap(toSegments(p1), toSegments(p2));
}

// Does a claim point INTO a protected area? Unlike patternsOverlap, a claim on
// a folder ("src/auth") is not refused just because some folder below it could
// be protected ("**/migrations/**"); those parts are excluded from the lease
// instead. A claim that names a protected path, or a pattern reaching into one
// ("src/**/*.sql" vs "**/migrations/**"), is refused.
export function claimEntersProtected(claim, protectedPattern) {
  const segs = claim.split('/');
  while (segs.length > 1 && segs[segs.length - 1] === '**') segs.pop();
  return seqOverlap(segs, toSegments(protectedPattern));
}

// Does a concrete file path fall under a pattern?
export function pathMatches(pattern, file) {
  const { pattern: f } = normalizePattern(file);
  if (!f) return false;
  // A concrete path matches iff the pattern overlaps the exact file, so reuse
  // the overlap test with the file treated as an exact (non-prefix) pattern.
  const A = toSegments(pattern);
  const B = f.split('/');
  const memo = new Map();
  const go = (i, j) => {
    const k = i * 1000 + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i < A.length && A[i] === '**') r = go(i + 1, j) || (j < B.length && go(i, j + 1));
    else if (i === A.length || j === B.length) r = false;
    else r = segmentsOverlap(A[i], B[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

export function isWholeRepo(pattern) {
  return pattern === '**' || pattern === '*' || /^(\*\*\/)*\*\*(\/\*)?$/.test(pattern);
}

// All overlapping pairs between two pattern lists.
export function overlaps(mine, theirs) {
  const out = [];
  for (const a of mine) for (const b of theirs) if (patternsOverlap(a, b)) out.push({ mine: a, theirs: b });
  return out;
}
