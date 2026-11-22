// End-to-end simulation of the deployed entry points (src/index.js) against an
// in-memory Jira and KVS: the exact calls two coding agents and a person make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-e2e-')), 'index.mjs');

await build({
  entryPoints: [path.join(here, '../src/index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
  alias: {
    '@forge/api': path.join(here, 'sim/forge-api.js'),
    '@forge/kvs': path.join(here, 'sim/forge-kvs.js'),
    '@forge/resolver': path.join(here, 'sim/forge-resolver.js'),
  },
});
const app = await import(outfile);
const jira = globalThis.__jira;

const realNow = Date.now;
let clock = Date.UTC(2026, 11, 1, 22, 0, 0);
Date.now = () => clock;
const advance = (min) => (clock += min * 60000);

const as = (accountId) => {
  jira.currentUser = accountId;
  return { accountId };
};
const issue = (key, summary, labels = ['agent-ok'], extra = {}) =>
  (jira.issues[key] = { key, summary, labels, status: 'To Do', cat: 'new', assignee: null, ...extra });

jira.users = { yu: 'Yu Chen', mei: 'Mei Lin', sam: 'Sam Ortiz' };
jira.admins.add('yu');
issue('APP-101', 'Add rate limiting to login');
issue('APP-102', 'Refactor session refresh');
issue('APP-103', 'Fix invoice rounding');
issue('APP-104', 'Rename billing columns', ['agent-ok']);
issue('APP-105', 'Dark mode for settings', []);
issue('APP-106', 'Payment retries', ['agent-ok'], { status: 'In Progress', cat: 'indeterminate', assignee: 'sam' });

test.after(() => {
  Date.now = realNow;
});

let leaseA;

test('agent A finds work and claims it', async () => {
  const found = await app.findWork({ projectKey: 'APP' }, as('yu'));
  const keys = found.available.map((a) => a.issueKey);
  assert.ok(keys.includes('APP-101') && !keys.includes('APP-105'), 'unlabelled work is not offered');
  assert.ok(found.unavailable.some((u) => u.issueKey === 'APP-106'), 'work a person has in progress is not offered');

  const r = await app.claimWork({ issueKey: 'APP-101', agent: 'claude-code', paths: 'src/auth/**, tests/auth', repo: 'acme/web', intent: 'Token bucket on /login' }, as('yu'));
  assert.equal(r.granted, true, JSON.stringify(r));
  assert.equal(r.lease.owner, 'Yu Chen');
  leaseA = r.lease.leaseId;
  assert.equal(jira.props['APP-101'].agent, 'claude-code');
  assert.match(jira.comments['APP-101'][0].text, /Leased to an agent/);
});

test('agent B (another person) collides on src/auth and is told who and until when', async () => {
  const r = await app.claimWork({ issueKey: 'APP-102', agent: 'codex', paths: 'src/auth/session.ts', repo: 'acme/web' }, as('mei'));
  assert.equal(r.granted, false);
  assert.equal(r.result, 'PATH_COLLISION');
  assert.match(r.reasons[0], /APP-101 is leased to claude-code \(for Yu Chen\)/);
  assert.equal(r.retryAfter, '2026-12-01T22:30:00Z');
  const ok = await app.claimWork({ issueKey: 'APP-103', agent: 'codex', paths: 'src/billing/rounding.ts', repo: 'acme/web' }, as('mei'));
  assert.equal(ok.granted, true);
});

test('people are protected: in-progress work and protected paths', async () => {
  const h = await app.claimWork({ issueKey: 'APP-106', agent: 'cursor', paths: 'src/payments' }, as('mei'));
  assert.equal(h.result, 'HUMAN_WORKING');
  assert.match(h.reasons[0], /Sam Ortiz is working on APP-106/);
  const p = await app.claimWork({ issueKey: 'APP-104', agent: 'cursor', paths: 'db/migrations/0042_rename.sql' }, as('mei'));
  assert.equal(p.result, 'PROTECTED_PATH');
});

test('heartbeat keeps the lease; widening into held paths is refused', async () => {
  advance(20);
  const hb = await app.heartbeat({ leaseId: leaseA, note: 'Limiter middleware done, writing tests' }, as('yu'));
  assert.equal(hb.granted, true);
  const widen = await app.heartbeat({ leaseId: leaseA, addPaths: 'src/billing' }, as('yu'));
  assert.equal(widen.result, 'PATH_COLLISION');
  const st = await app.checkPaths({ paths: 'src/auth/login.ts', repo: 'acme/web' }, as('sam'));
  assert.equal(st.clear, false);
  assert.equal(st.holders[0].issueKey, 'APP-101');
});

test('agent B goes silent: after its lease expires the work returns to the queue', async () => {
  advance(15); // codex claimed at +0, never heart-beat: expired at +30
  const n = await app.sweep();
  const st = await app.leaseStatus({ projectKey: 'APP' }, as('yu'));
  assert.deepEqual(st.activeLeases.map((l) => l.issueKey), ['APP-101']);
  assert.match(jira.comments['APP-103'].at(-1).text, /Lease expired/);
  assert.equal(jira.props['APP-103'].held, false);
  assert.equal(jira.props['APP-103'].state, 'expired', 'the property keeps the last lease for CI and JQL');
});

test('a person takes work back; the agent is stopped on its next heartbeat', async () => {
  const resolve = app.resolverHandler;
  const r = await resolve('revoke', { leaseId: leaseA, reason: 'Security review needed first' }, { accountId: 'sam', extension: { issue: { key: 'APP-101' } } });
  jira.currentUser = 'sam';
  assert.equal(r.granted, true, JSON.stringify(r));
  const hb = await app.heartbeat({ leaseId: leaseA, note: 'still going' }, as('yu'));
  assert.equal(hb.result, 'LEASE_GONE');
  assert.match(jira.comments['APP-101'].at(-1).text, /Taken back from the agent/);
});

test('a full happy path ends with a PR on the work item and in the report', async () => {
  const c = await app.claimWork({ issueKey: 'APP-102', agent: 'codex', paths: 'src/auth/session.ts', repo: 'acme/web' }, as('mei'));
  assert.equal(c.granted, true, 'free again after the revoke');
  advance(7);
  const done = await app.releaseWork({ leaseId: c.lease.leaseId, outcome: 'done', prUrl: 'https://github.com/acme/web/pull/88', summary: 'Refresh tokens rotate on use; 14 tests added.' }, as('mei'));
  assert.equal(done.granted, true);
  assert.match(jira.comments['APP-102'].at(-1).text, /pull\/88/);

  const rep = await app.agentReport({ hours: 14, projectKey: 'APP' }, as('yu'));
  assert.equal(rep.totals.finished, 1);
  assert.equal(rep.totals.expired, 1);
  assert.equal(rep.totals.revokedByPeople, 1);
  assert.equal(rep.totals.collisionsPrevented >= 2, true);
  assert.equal(rep.totals.humanWorkProtected, 1);
  assert.equal(rep.finishedWork.find((f) => f.outcome === 'done').pr, 'https://github.com/acme/web/pull/88');
  assert.ok(rep.needsAPerson.some((n) => n.issueKey === 'APP-103' && n.outcome === 'expired'));
});

test('closing a work item in Jira ends the agent lease', async () => {
  const c = await app.claimWork({ issueKey: 'APP-104', agent: 'cursor', paths: 'src/billing/columns.ts' }, as('mei'));
  assert.equal(c.granted, true);
  Object.assign(jira.issues['APP-104'], { status: 'Done', cat: 'done' });
  await app.onIssueUpdated({ issue: { key: 'APP-104' } });
  const st = await app.leaseStatus({ issueKey: 'APP-104' }, as('yu'));
  assert.equal(st.count, 0);
});

test('a person starting leased work is flagged once', async () => {
  issue('APP-107', 'Cache headers');
  const c = await app.claimWork({ issueKey: 'APP-107', agent: 'claude-code', paths: 'src/http/cache.ts' }, as('yu'));
  assert.equal(c.granted, true);
  Object.assign(jira.issues['APP-107'], { status: 'In Progress', cat: 'indeterminate', assignee: 'sam' });
  await app.onIssueUpdated({ issue: { key: 'APP-107' } });
  await app.onIssueUpdated({ issue: { key: 'APP-107' } });
  const flagged = jira.comments['APP-107'].filter((c) => /Two people on one task/.test(c.text));
  assert.equal(flagged.length, 1);
});

test('the issue panel and control tower resolvers return what the UI renders', async () => {
  const resolve = app.resolverHandler;
  const panel = await resolve('issueView', {}, { accountId: 'yu', extension: { issue: { key: 'APP-107' } } });
  assert.equal(panel.lease.agent, 'claude-code');
  assert.ok(panel.events.length >= 1);
  const tower = await resolve('tower', { hours: 24 }, { accountId: 'yu' });
  assert.ok(tower.count >= 1);
  assert.ok(tower.report.totals.finished >= 1);
  jira.currentUser = 'mei';
  const denied = await resolve('savePolicy', { projectKey: 'APP', policy: { maxActivePerAgent: 9 } }, { accountId: 'mei' });
  assert.equal(denied.ok, false, 'only project admins change policy');
  jira.currentUser = 'yu';
  const saved = await resolve('savePolicy', { projectKey: 'APP', policy: { maxActivePerAgent: 3, protectedPaths: ['infra/**'] } }, { accountId: 'yu' });
  assert.equal(saved.ok, true);
  assert.equal((await resolve('getPolicy', { projectKey: 'APP' }, {})).maxActivePerAgent, 3);
  const ready = await resolve('setAgentReady', { issueKey: 'APP-105', ready: true }, { accountId: 'yu' });
  assert.equal(ready.ok, true);
  assert.ok(jira.issues['APP-105'].labels.includes('agent-ok'));
});

test('dry run answers without taking anything; sample work is admin-only', async () => {
  const resolve = app.resolverHandler;
  jira.currentUser = 'mei';
  const dry = await resolve('dryRun', { issueKey: 'APP-101', agent: 'codex', paths: 'src/http/**', repo: 'default' }, { accountId: 'mei' });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.result, 'PATH_COLLISION', JSON.stringify(dry)); // APP-107 holds src/http/cache.ts
  const before = (await app.leaseStatus({}, as('yu'))).count;
  const free = await resolve('dryRun', { issueKey: 'APP-101', agent: 'codex', paths: 'docs/**' }, { accountId: 'mei' });
  assert.equal(free.granted, true);
  assert.equal((await app.leaseStatus({}, as('yu'))).count, before, 'a dry run never creates a lease');
  jira.currentUser = 'mei';
  assert.equal((await resolve('createSampleWork', { projectKey: 'APP' }, { accountId: 'mei' })).ok, false);
  jira.currentUser = 'yu';
  const made = await resolve('createSampleWork', { projectKey: 'APP' }, { accountId: 'yu' });
  assert.equal(made.created.length, 6);
  assert.equal(jira.issues[made.created[0]].type, '10002', 'uses a standard (non sub-task) work type');
  assert.equal(made.created.filter((k) => jira.issues[k].labels.includes('agent-ok')).length, 5);
});

test('revocation: the panel shows "stopping" until the agent hears it, and the agent is told who and why', async () => {
  const resolve = app.resolverHandler;
  issue('APP-120', 'Search endpoint pagination');
  const c = await app.claimWork({ issueKey: 'APP-120', agent: 'claude-code', paths: 'src/search', repo: 'acme/web' }, as('yu'));
  jira.currentUser = 'sam';
  await resolve('revoke', { leaseId: c.lease.leaseId, reason: 'Pairing on this with Mei' }, { accountId: 'sam' });
  let panel = await resolve('issueView', {}, { accountId: 'sam', extension: { issue: { key: 'APP-120' } } });
  assert.equal(panel.stops.length, 1);
  assert.equal(panel.stops[0].acknowledgedAt, null);
  const hb = await app.heartbeat({ leaseId: c.lease.leaseId }, as('yu'));
  assert.equal(hb.result, 'LEASE_GONE');
  assert.match(hb.reasons[0], /Sam Ortiz took APP-120 back .*"Pairing on this with Mei"/);
  panel = await resolve('issueView', {}, { accountId: 'sam', extension: { issue: { key: 'APP-120' } } });
  assert.ok(panel.stops[0].acknowledgedAt);
});

test('a person reserves paths from the panel and agents elsewhere are refused', async () => {
  const resolve = app.resolverHandler;
  issue('APP-121', 'Hand-written OAuth refactor', []);
  issue('APP-122', 'Add login audit log');
  jira.currentUser = 'sam';
  const r = await resolve('reserve', { issueKey: 'APP-121', paths: 'src/oauth', repo: 'git@github.com:acme/web.git' }, { accountId: 'sam' });
  assert.equal(r.granted, true, JSON.stringify(r));
  const c = await app.claimWork({ issueKey: 'APP-122', agent: 'codex', paths: 'src/oauth/audit.ts', repo: 'acme/web' }, as('mei'));
  assert.equal(c.result, 'PATH_COLLISION');
  assert.match(c.reasons[0], /Sam Ortiz \(a person, working by hand\)/);
  const panel = await resolve('issueView', {}, { accountId: 'sam', extension: { issue: { key: 'APP-121' } } });
  assert.equal(panel.lease.kind, 'person');
  assert.equal(panel.lease.ownerAccountId, 'sam');
  jira.currentUser = 'sam';
  assert.equal((await resolve('releaseMine', { leaseId: panel.lease.leaseId }, { accountId: 'sam' })).granted, true);
});

test('release with changed files posts a scope check on the work item', async () => {
  issue('APP-123', 'Tidy error messages');
  const c = await app.claimWork({ issueKey: 'APP-123', agent: 'codex', paths: 'src/errors', repo: 'acme/web' }, as('mei'));
  const r = await app.releaseWork({ leaseId: c.lease.leaseId, outcome: 'done', changedFiles: 'src/errors/messages.ts, src/http/cache.ts', prUrl: 'https://github.com/acme/web/pull/91' }, as('mei'));
  assert.equal(r.granted, true);
  assert.match(jira.comments['APP-123'].at(-1).text, /Scope check failed.*src\/http\/cache\.ts/);
});

test('simulate two agents runs the real flow on sample work', async () => {
  const resolve = app.resolverHandler;
  jira.currentUser = 'yu';
  await resolve('createSampleWork', { projectKey: 'SIM' }, { accountId: 'yu' }).catch(() => null);
  // SIM project is empty in the fake, so create sample work there first
  for (const k of Object.keys(jira.issues)) if (k.startsWith('SIM-')) delete jira.issues[k];
  const made = await resolve('createSampleWork', { projectKey: 'SIM' }, { accountId: 'yu' });
  assert.equal(made.ok, true);
  const sim = await resolve('simulate', { projectKey: 'SIM' }, { accountId: 'yu' });
  assert.equal(sim.ok, true, JSON.stringify(sim));
  const codes = sim.steps.map((s) => (s.granted ? 'granted' : s.result));
  assert.deepEqual(codes, ['granted', 'granted', 'PATH_COLLISION', 'granted', 'granted', 'PATH_COLLISION', 'PROTECTED_PATH']);
  assert.match(sim.steps[5].says, /a person, working by hand/);
});

test('app info gives the MCP URL for this installation', async () => {
  const info = await app.resolverHandler('appInfo', {}, {});
  assert.equal(info.mcpUrl, 'https://mcp.atlassian.com/forge/11111111-2222-3333-4444-555555555555');
});

test('released work keeps its paths on the issue property for CI', async () => {
  const p = jira.props['APP-102'];
  assert.equal(p.state, 'awaiting-merge');
  assert.equal(p.held, true);
  assert.deepEqual(p.paths, ['src/auth/session.ts']);
  assert.equal(p.prUrl, 'https://github.com/acme/web/pull/88');
});

test('a PR awaiting review keeps its files until the work item is Done', async () => {
  issue('APP-130', 'Session cookie flags');
  const r = await app.claimWork({ issueKey: 'APP-130', agent: 'cursor', paths: 'src/auth/session.ts', repo: 'acme/web' }, as('sam'));
  assert.equal(r.result, 'PATH_COLLISION', 'APP-102 PR still awaiting review');
  assert.match(r.reasons[0], /awaiting review \(https:\/\/github.com\/acme\/web\/pull\/88\)/);
  assert.match(jira.comments['APP-102'].at(-1).text, /keeps src\/auth\/session.ts reserved for this pull request/);
  Object.assign(jira.issues['APP-102'], { status: 'Done', cat: 'done' });
  await app.onIssueUpdated({ issue: { key: 'APP-102' } });
  const again = await app.claimWork({ issueKey: 'APP-130', agent: 'cursor', paths: 'src/auth/session.ts', repo: 'acme/web' }, as('sam'));
  assert.equal(again.granted, true, JSON.stringify(again));
  const rep = await app.agentReport({ hours: 24 }, as('yu'));
  assert.ok(Array.isArray(rep.awaitingMerge));
});

test('people and their agents never learn about work items they cannot see', async () => {
  issue('SEC-1', 'Rotate the signing keys after the incident');
  jira.hiddenFrom = { mei: new Set(['SEC-1']) };
  const c = await app.claimWork({ issueKey: 'SEC-1', agent: 'claude-code', paths: 'src/crypto', repo: 'acme/web', intent: 'Rotate keys (confidential)' }, as('yu'));
  assert.equal(c.granted, true);
  // Mei's agent collides: it learns the paths are taken, not by what
  const r = await app.claimWork({ issueKey: 'APP-122', agent: 'codex', paths: 'src/crypto/keys.ts', repo: 'acme/web' }, as('mei'));
  assert.equal(r.result, 'PATH_COLLISION');
  const text = JSON.stringify(r);
  assert.ok(!text.includes('SEC-1') && !text.includes('signing keys') && !text.includes('confidential'), text);
  assert.match(r.reasons[0], /a work item you cannot see/);
  assert.deepEqual(r.collisions[0].paths, ['src/crypto']);
  // the control tower and the Rovo report too
  jira.currentUser = 'mei';
  const tower = await app.resolverHandler('tower', { hours: 24 }, { accountId: 'mei' });
  assert.ok(!JSON.stringify(tower).includes('SEC-1'));
  assert.ok(tower.activeLeases.some((l) => l.hidden && l.paths[0] === 'src/crypto'));
  const st = await app.leaseStatus({}, as('mei'));
  assert.ok(!JSON.stringify(st).includes('Rotate'));
  // Yu can see it
  const mine = await app.leaseStatus({ issueKey: 'SEC-1' }, as('yu'));
  assert.equal(mine.activeLeases[0].summary, 'Rotate the signing keys after the incident');
  jira.hiddenFrom = {};
});

test('a configured "merged" status ends a pull request hold before Done', async () => {
  const resolve = app.resolverHandler;
  jira.currentUser = 'yu';
  await resolve('savePolicy', { projectKey: 'APP', policy: { mergedStatuses: 'In QA, Staging' } }, { accountId: 'yu' });
  issue('APP-140', 'Retry webhooks');
  const c = await app.claimWork({ issueKey: 'APP-140', agent: 'codex', paths: 'src/webhooks', repo: 'acme/web' }, as('mei'));
  await app.releaseWork({ leaseId: c.lease.leaseId, outcome: 'done', prUrl: 'https://github.com/acme/web/pull/95' }, as('mei'));
  assert.equal((await app.leaseStatus({ issueKey: 'APP-140' }, as('yu'))).activeLeases[0].kind, 'review');
  Object.assign(jira.issues['APP-140'], { status: 'In QA', cat: 'indeterminate' });
  await app.onIssueUpdated({ issue: { key: 'APP-140' } });
  assert.equal((await app.leaseStatus({ issueKey: 'APP-140' }, as('yu'))).activeLeases.length, 0);
});

test('Jira administrators count as project administrators (live finding: new projects have no project admins yet)', async () => {
  jira.jiraAdmins = new Set(['sam']);
  jira.currentUser = 'sam';
  for (const k of Object.keys(jira.issues)) if (k.startsWith('NEW-')) delete jira.issues[k];
  const made = await app.resolverHandler('createSampleWork', { projectKey: 'NEW' }, { accountId: 'sam' });
  assert.equal(made.ok, true, JSON.stringify(made));
  jira.jiraAdmins = new Set();
});

test('Rovo context: a project question is not narrowed to the open work item', async () => {
  const st = await app.leaseStatus({ projectKey: 'APP', context: { jira: { issueKey: 'APP-101' } } }, as('yu'));
  assert.ok(st.count >= 1 || st.activeLeases.length >= 1);
  assert.ok(st.activeLeases.some((l) => l.issueKey !== 'APP-101'));
  const one = await app.leaseStatus({ context: { jira: { issueKey: 'APP-107' } } }, as('yu'));
  assert.ok(one.activeLeases.every((l) => l.issueKey === 'APP-107'));
});

test('leases are sharded per repository: separate records, cross-repo work item check, heartbeats find their shard', async () => {
  const kv = globalThis.__kvs;
  issue('APP-150', 'Mobile push tokens');
  issue('APP-151', 'API pagination');
  const a = await app.claimWork({ issueKey: 'APP-150', agent: 'claude-code', paths: 'src/push', repo: 'acme/mobile' }, as('yu'));
  const b = await app.claimWork({ issueKey: 'APP-151', agent: 'codex', paths: 'src/push', repo: 'acme/api' }, as('mei'));
  assert.equal(a.granted && b.granted, true, 'same path, different repositories: no collision');
  const records = [...kv.entities.keys()].filter((k) => k.startsWith('board/leases:'));
  assert.ok(records.some((k) => k.includes('acme_mobile')) && records.some((k) => k.includes('acme_api')), records.join(','));
  // another person cannot take APP-150 through a different repository
  const c = await app.claimWork({ issueKey: 'APP-150', agent: 'cursor', paths: 'docs', repo: 'acme/docs' }, as('sam'));
  assert.equal(c.result, 'ISSUE_LEASED');
  // the same person's agent may work on the same work item in another repository
  const d = await app.claimWork({ issueKey: 'APP-150', agent: 'claude-code', paths: 'ios/Push', repo: 'acme/ios' }, as('yu'));
  assert.equal(d.granted, true);
  // heartbeat and release find the right shard from the lease id
  assert.equal((await app.heartbeat({ leaseId: b.lease.leaseId, note: 'pagination cursor done' }, as('mei'))).granted, true);
  assert.equal((await app.releaseWork({ leaseId: b.lease.leaseId, outcome: 'blocked', summary: 'needs API design review' }, as('mei'))).granted, true);
  // pages see every repository
  const st = await app.leaseStatus({ projectKey: 'APP' }, as('yu'));
  assert.ok(st.activeLeases.some((l) => l.repo === 'acme/mobile') && st.activeLeases.some((l) => l.repo === 'acme/ios'));
});

test('the Lease gate validator reads the live issue property', async () => {
  issue('APP-160', 'Retry budget');
  const c = await app.claimWork({ issueKey: 'APP-160', agent: 'codex', paths: 'src/retry', repo: 'acme/web' }, as('mei'));
  assert.equal((await app.leaseGate({ issue: { key: 'APP-160' } })).result, false, 'agent still working');
  await app.releaseWork({ leaseId: c.lease.leaseId, outcome: 'done', prUrl: 'https://github.com/acme/web/pull/120', changedFiles: 'src/retry/budget.ts, src/auth/login.ts' }, as('mei'));
  const g = await app.leaseGate({ issue: { key: 'APP-160' } });
  assert.equal(g.result, false);
  assert.match(g.errorMessage, /src\/auth\/login\.ts/);
  jira.issues['APP-160'].labels.push('lease-reviewed');
  assert.equal((await app.leaseGate({ issue: { key: 'APP-160' } })).result, true);
  assert.equal((await app.leaseGate({})).result, true);
});
