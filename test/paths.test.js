import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePattern, parsePathList, patternsOverlap, segmentsOverlap, pathMatches, isWholeRepo } from '../src/core/paths.js';

test('normalizes patterns and rejects unsafe ones', () => {
  assert.equal(normalizePattern('./src//auth/').pattern, 'src/auth');
  assert.equal(normalizePattern('src\\auth\\x.ts').pattern, 'src/auth/x.ts');
  assert.equal(normalizePattern('src/**/**/a.ts').pattern, 'src/**/a.ts');
  assert.ok(normalizePattern('/etc/passwd').error);
  assert.ok(normalizePattern('C:/x').error);
  assert.ok(normalizePattern('src/../secrets').error);
  assert.ok(normalizePattern('   ').error);
  assert.deepEqual(parsePathList('src/a, src/b\nsrc/a').patterns, ['src/a', 'src/b']);
});

test('single segment globs', () => {
  assert.ok(segmentsOverlap('*.ts', 'login.ts'));
  assert.ok(segmentsOverlap('*.ts', 'log*'));
  assert.ok(segmentsOverlap('a*', '*b'));
  assert.ok(!segmentsOverlap('*.ts', '*.js'));
  assert.ok(segmentsOverlap('?.ts', 'a.*'));
  assert.ok(!segmentsOverlap('ab', 'a'));
  assert.ok(!segmentsOverlap('a?', 'a'));
  assert.ok(segmentsOverlap('*', ''));
});

test('directory prefixes overlap their contents', () => {
  assert.ok(patternsOverlap('src/auth', 'src/auth/login.ts'));
  assert.ok(patternsOverlap('src/auth', 'src'));
  assert.ok(patternsOverlap('src/auth/**', 'src/auth'));
  assert.ok(!patternsOverlap('src/auth', 'src/billing'));
  assert.ok(!patternsOverlap('src/auth', 'src/authz')); // segment boundary, not string prefix
});

test('globs across segments', () => {
  assert.ok(patternsOverlap('src/**/session.ts', 'src/auth/session.ts'));
  assert.ok(patternsOverlap('src/**/session.ts', 'src/auth/**'));
  assert.ok(patternsOverlap('**/*.sql', 'db/migrations'));
  assert.ok(!patternsOverlap('src/**/*.ts', 'docs/**'));
  assert.ok(!patternsOverlap('src/*/index.ts', 'src/a/b/index.ts'));
  assert.ok(patternsOverlap('src/*/index.ts', 'src/**/index.ts'));
  assert.ok(!patternsOverlap('web/*.css', 'web/*.ts'));
  assert.ok(patternsOverlap('**/migrations/**', 'api/db/migrations/0042_add.sql'));
});

test('overlap is symmetric on a grid of patterns', () => {
  const ps = ['src', 'src/auth', 'src/auth/*.ts', 'src/**/test_*.py', '**/*.md', 'docs', 'src/a?c/**', 'src/abc/x.ts', '*', 'tests/**'];
  for (const a of ps) for (const b of ps) assert.equal(patternsOverlap(a, b), patternsOverlap(b, a), `${a} vs ${b}`);
});

test('pathMatches for concrete files', () => {
  assert.ok(pathMatches('src/auth', 'src/auth/login.ts'));
  assert.ok(pathMatches('src/**/*.ts', 'src/a/b/c.ts'));
  assert.ok(!pathMatches('src/*.ts', 'src/a/b.ts'));
});

test('whole-repo detection', () => {
  for (const p of ['**', '*', '**/*']) assert.ok(isWholeRepo(p), p);
  assert.ok(!isWholeRepo('src/**'));
});

// Brute-force oracle: enumerate concrete paths over a small alphabet and check
// that the overlap test agrees with "some path matches both" on random patterns.
test('overlap agrees with a brute-force oracle', () => {
  const segs = ['a', 'b', 'ab', 'ba', 'aa'];
  const paths = [];
  const build = (prefix, depth) => {
    if (depth === 0) return;
    for (const s of segs) {
      const p = prefix ? `${prefix}/${s}` : s;
      paths.push(p);
      build(p, depth - 1);
    }
  };
  build('', 4);
  const atoms = ['a', 'b', '*', 'a*', '*b', '?', '**', 'ab'];
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 48271) % 2147483647), seed % n); // Park-Miller, exact in doubles
  const randPattern = () =>
    Array.from({ length: 1 + rnd(3) }, () => atoms[rnd(atoms.length)])
      .join('/')
      .replace(/(\*\*\/)+\*\*/g, '**');
  const kinds = new Set();
  let agreeTrue = 0;
  for (let i = 0; i < 600; i++) {
    const a = randPattern();
    const b = randPattern();
    kinds.add(a);
    const oracle = paths.some((p) => pathMatches(a, p) && pathMatches(b, p));
    // The oracle only sees paths up to depth 4, so it can miss deep witnesses;
    // whenever it finds one, the exact test must agree.
    if (oracle) assert.ok(patternsOverlap(a, b), `${a} vs ${b} should overlap`);
    if (!patternsOverlap(a, b)) assert.ok(!oracle, `${a} vs ${b} should not overlap`);
    if (oracle) agreeTrue++;
  }
  assert.ok(kinds.size > 100, `generator must vary patterns (got ${kinds.size})`);
  assert.ok(agreeTrue > 50 && agreeTrue < 590, `both outcomes must occur (overlaps: ${agreeTrue})`);
});

test('protected areas: folder claims are not refused for what might sit below them', async () => {
  const { claimEntersProtected } = await import('../src/core/paths.js');
  assert.ok(!claimEntersProtected('src/auth/**', '**/migrations/**'));
  assert.ok(!claimEntersProtected('src/auth', '**/migrations/**'));
  assert.ok(claimEntersProtected('db/migrations', '**/migrations/**'));
  assert.ok(claimEntersProtected('api/db/migrations/0042.sql', '**/migrations/**'));
  assert.ok(claimEntersProtected('infra', 'infra/**'));
  assert.ok(claimEntersProtected('src/**/*.sql', '**/migrations/**'));
  assert.ok(claimEntersProtected('.github/workflows/ci.yml', '.github/workflows/**'));
  assert.ok(!claimEntersProtected('.github/ISSUE_TEMPLATE', '.github/workflows/**'));
});
