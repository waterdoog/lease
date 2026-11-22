import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '../skill/ci/lease-pr-check.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-ci-'));
const prop = (v) => {
  const f = path.join(dir, `p${Math.random()}.json`);
  fs.writeFileSync(f, JSON.stringify(v));
  return f;
};
const run = (env) => spawnSync('node', [script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const lease = { held: false, state: 'released', kind: 'agent', agent: 'codex', repo: 'acme/web', paths: ['src/auth/**'], mustNotTouch: ['**/migrations/**'] };

test('passes a PR that stays inside the lease (key from the title)', () => {
  const r = run({ PR_TITLE: 'APP-12 Rate limit login', CHANGED_FILES: 'src/auth/login.ts,src/auth/limit.ts', LEASE_PROPERTY_FILE: prop(lease), REPOSITORY: 'git@github.com:acme/web.git' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All changed files are inside the lease/);
});

test('fails files outside the lease and in protected paths', () => {
  const r = run({ HEAD_REF: 'feature/APP-12-limit', CHANGED_FILES: 'src/auth/login.ts\nsrc/billing/x.ts\nsrc/auth/migrations/1.sql', LEASE_PROPERTY_FILE: prop(lease), REPOSITORY: 'acme/web' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Outside the lease:\n- src\/billing\/x\.ts/);
  assert.match(r.stdout, /only people may change:\n- src\/auth\/migrations\/1\.sql/);
});

test('fails a PR whose lease a person revoked', () => {
  const r = run({ PR_TITLE: 'APP-12', CHANGED_FILES: 'src/auth/a.ts', LEASE_PROPERTY_FILE: prop({ ...lease, state: 'revoked', endedAt: '2026-12-01T22:40:00Z' }) });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /taken back from codex/);
});

test('no lease: warn by default, fail when required; other repo: skip', () => {
  const missing = path.join(dir, 'missing.json');
  assert.equal(run({ PR_TITLE: 'APP-12', CHANGED_FILES: 'a', LEASE_PROPERTY_FILE: missing }).status, 0);
  assert.equal(run({ PR_TITLE: 'APP-12', CHANGED_FILES: 'a', LEASE_PROPERTY_FILE: missing, LEASE_REQUIRED: '1' }).status, 1);
  assert.equal(run({ PR_TITLE: 'APP-12', CHANGED_FILES: 'x/y', LEASE_PROPERTY_FILE: prop(lease), REPOSITORY: 'acme/api' }).status, 0);
  assert.equal(run({ PR_TITLE: 'no key here', CHANGED_FILES: 'a' }).status, 0);
});

test('writes a GitHub step summary', () => {
  const summary = path.join(dir, 'summary.md');
  run({ PR_TITLE: 'APP-12', CHANGED_FILES: 'src/auth/a.ts', LEASE_PROPERTY_FILE: prop(lease), GITHUB_STEP_SUMMARY: summary });
  assert.match(fs.readFileSync(summary, 'utf8'), /### Lease scope check/);
});
