// The local guard: Claude Code hooks and the git pre-commit hook, run as real
// processes in a throwaway git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, '../skill');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-guard-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
execFileSync('sh', [path.join(skill, 'install.sh')], { cwd: repo, encoding: 'utf8' });
const guard = path.join(repo, '.lease/hooks/lease-guard.mjs');
const run = (mode, input, env = {}) =>
  spawnSync('node', [guard, mode], { cwd: repo, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, LEASE_GUARD: '', ...env } });

const later = new Date(Date.now() + 30 * 60000).toISOString();
const claimResponse = {
  granted: true,
  result: 'GRANTED',
  lease: { leaseId: 'L1', kind: 'agent', issueKey: 'APP-101', repo: 'acme/web', paths: ['src/auth/**', 'tests/auth'], mustNotTouch: ['**/migrations/**'], expiresAt: later },
};

test('the vendored matcher is the app matcher, byte for byte', () => {
  assert.equal(fs.readFileSync(path.join(skill, 'hooks/lease-paths.mjs'), 'utf8'), fs.readFileSync(path.join(here, '../src/core/paths.js'), 'utf8'));
});

test('install wires Claude Code hooks, the skill and the pre-commit hook', () => {
  assert.ok(fs.existsSync(path.join(repo, '.claude/settings.local.json')));
  assert.ok(fs.existsSync(path.join(repo, '.claude/skills/lease/SKILL.md')));
  assert.match(fs.readFileSync(path.join(repo, '.git/hooks/pre-commit'), 'utf8'), /lease-guard\.mjs" precommit/);
  assert.match(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8'), /\.lease\//);
});

test('without a lease, edits are blocked with what to do', () => {
  const r = run('pre', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/auth/login.ts') } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No Lease covers src\/auth\/login\.ts. Claim the Jira work item/);
  // files outside the repository are none of Lease's business
  assert.equal(run('pre', { tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'scratch.txt') } }).status, 0);
});

test('a granted claim (MCP tool result, as Claude Code wraps it) opens exactly the leased paths', () => {
  const post = run('post', { tool_name: 'mcp__lease__claim-work', tool_input: {}, tool_response: [{ type: 'text', text: JSON.stringify(claimResponse) }] });
  assert.equal(post.status, 0);
  assert.equal(run('pre', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/auth/login.ts') } }).status, 0);
  assert.equal(run('pre', { tool_name: 'Write', tool_input: { file_path: 'tests/auth/limit.test.ts' } }).status, 0);
  const outside = run('pre', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/billing/x.ts') } });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /outside your Lease \(APP-101: src\/auth\/\*\*, tests\/auth\)/);
  const mig = run('pre', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/auth/migrations/001.sql') } });
  assert.equal(mig.status, 2);
  assert.match(mig.stderr, /only people may change/);
});

test('pre-commit refuses commits outside the lease; LEASE_GUARD=off lets a person through', () => {
  fs.mkdirSync(path.join(repo, 'src/auth'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src/billing'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/auth/login.ts'), 'x');
  git('add', 'src/auth/login.ts');
  assert.equal(spawnSync('git', ['commit', '-qm', 'in lease'], { cwd: repo, encoding: 'utf8', env: { ...process.env, LEASE_GUARD: '' } }).status, 0);
  fs.writeFileSync(path.join(repo, 'src/billing/x.ts'), 'y');
  git('add', 'src/billing/x.ts');
  const bad = spawnSync('git', ['commit', '-qm', 'outside'], { cwd: repo, encoding: 'utf8', env: { ...process.env, LEASE_GUARD: '' } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /src\/billing\/x\.ts/);
  assert.equal(spawnSync('git', ['commit', '-qm', 'by hand'], { cwd: repo, encoding: 'utf8', env: { ...process.env, LEASE_GUARD: 'off' } }).status, 0);
});

test('LEASE_GONE and release forget the lease; record works for clients without hooks', () => {
  run('post', { tool_name: 'mcp__lease__heartbeat', tool_input: { leaseId: 'L1' }, tool_response: { content: [{ type: 'text', text: JSON.stringify({ granted: false, result: 'LEASE_GONE', reasons: ['Sam took APP-101 back'] }) }] } });
  assert.equal(run('pre', { tool_name: 'Edit', tool_input: { file_path: 'src/auth/login.ts' } }).status, 2);
  const rec = spawnSync('node', [guard, 'record', JSON.stringify({ ...claimResponse, lease: { ...claimResponse.lease, leaseId: 'L2' } })], { cwd: repo, encoding: 'utf8' });
  assert.match(rec.stdout, /1 active lease/);
  assert.equal(run('pre', { tool_name: 'Edit', tool_input: { file_path: 'src/auth/login.ts' } }).status, 0);
  run('post', { tool_name: 'mcp__lease__release-work', tool_input: { leaseId: 'L2' }, tool_response: JSON.stringify({ granted: true, result: 'RELEASED', lease: { leaseId: 'L2', paths: [] } }) });
  assert.equal(run('pre', { tool_name: 'Edit', tool_input: { file_path: 'src/auth/login.ts' } }).status, 2);
});

test('an expired lease says so', () => {
  const past = new Date(Date.now() - 60000).toISOString();
  spawnSync('node', [guard, 'record', JSON.stringify({ ...claimResponse, lease: { ...claimResponse.lease, leaseId: 'L3', expiresAt: past } })], { cwd: repo, encoding: 'utf8' });
  const r = run('pre', { tool_name: 'Edit', tool_input: { file_path: 'src/auth/login.ts' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expired/);
});

test('people committing by hand are not blocked when the checkout holds no lease', () => {
  const human = { ...process.env, LEASE_GUARD: '' };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_HOME', 'CURSOR_TRACE_ID', 'CURSOR_AGENT', 'LEASE_AGENT']) delete human[k];
  fs.writeFileSync(path.join(repo, '.lease/active.json'), JSON.stringify({ leases: {} }));
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello');
  git('add', 'README.md');
  assert.equal(spawnSync('git', ['commit', '-qm', 'docs by hand'], { cwd: repo, encoding: 'utf8', env: human }).status, 0);
  fs.writeFileSync(path.join(repo, 'NOTES.md'), 'x');
  git('add', 'NOTES.md');
  const agent = spawnSync('git', ['commit', '-qm', 'agent without lease'], { cwd: repo, encoding: 'utf8', env: { ...human, LEASE_AGENT: '1' } });
  assert.notEqual(agent.status, 0, 'an agent session without a lease is blocked');
});

test('record accepts the claim result on stdin (no shell quoting)', () => {
  const withQuote = { ...claimResponse, lease: { ...claimResponse.lease, leaseId: 'L9', paths: ["docs/it's"] } };
  const r = spawnSync('node', [guard, 'record'], { cwd: repo, input: JSON.stringify(withQuote), encoding: 'utf8' });
  assert.match(r.stdout, /active lease/);
  assert.equal(run('pre', { tool_name: 'Edit', tool_input: { file_path: "docs/it's/a.md" } }).status, 0);
});
