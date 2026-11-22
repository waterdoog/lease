import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/core/leases.js';
import { makeStore } from '../src/core/store.js';
import { makeFakeKvs } from './fake-kvs.js';

const T0 = Date.UTC(2026, 10, 21, 22, 0, 0);
const MIN = 60000;
const issue = (key, extra = {}) => ({
  key,
  projectKey: key.split('-')[0],
  summary: `Work ${key}`,
  labels: ['agent-ok'],
  statusCategory: 'new',
  statusName: 'To Do',
  assigneeAccountId: null,
  assigneeName: null,
  ...extra,
});
let n = 0;
const ctx = (over = {}) => ({ now: T0, accountId: 'yu', ownerName: 'Yu', policy: null, newId: `L${++n}`, ...over });
const claimOn = (board, issueKey, paths, over = {}, issueExtra = {}) =>
  L.claim(board, { issueKey, agent: over.agent || 'claude-code', paths, intent: 'fix', repo: over.repo }, ctx({ issue: issue(issueKey, issueExtra), ...over }));

test('grants a clean claim and records the lease', () => {
  const r = claimOn(L.emptyBoard(), 'APP-1', 'src/auth/**');
  assert.equal(r.decision.code, 'GRANTED');
  const l = r.decision.lease;
  assert.deepEqual(l.paths, ['src/auth/**']);
  assert.equal(l.expiresAt, T0 + 30 * MIN);
  assert.equal(Object.keys(r.board.leases).length, 1);
});

test('refuses a second agent on overlapping paths, with who/what/when', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  const b = claimOn(a.board, 'APP-2', 'src/auth/session.ts, src/ui', { agent: 'codex', accountId: 'mei', ownerName: 'Mei' });
  assert.equal(b.decision.code, 'PATH_COLLISION');
  assert.match(b.decision.reasons[0], /APP-1 is leased to claude-code \(for Yu\)/);
  assert.equal(b.decision.collisions[0].overlaps[0].mine, 'src/auth/session.ts');
  assert.equal(b.decision.retryAfter, T0 + 30 * MIN);
  // narrowing to disjoint paths succeeds
  const c = claimOn(a.board, 'APP-2', 'src/ui', { agent: 'codex', accountId: 'mei' });
  assert.equal(c.decision.code, 'GRANTED');
});

test('paths only collide inside the same repository', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src', { repo: 'acme/web' });
  const b = claimOn(a.board, 'APP-2', 'src', { agent: 'codex', repo: 'acme/api' });
  assert.equal(b.decision.code, 'GRANTED');
  const c = claimOn(b.board, 'APP-3', 'src/x', { agent: 'cursor', repo: 'https://github.com/acme/web.git' });
  assert.equal(c.decision.code, 'PATH_COLLISION');
});

test('one lease per work item; same agent re-claim is idempotent', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/a');
  const again = claimOn(a.board, 'APP-1', 'src/a');
  assert.equal(again.decision.code, 'ALREADY_HELD');
  const other = claimOn(a.board, 'APP-1', 'docs', { agent: 'codex' });
  assert.equal(other.decision.code, 'ISSUE_LEASED');
});

test('respects people: label required, in-progress work, done work', () => {
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', 'src', {}, { labels: [] }).decision.code, 'NOT_AGENT_READY');
  assert.equal(
    claimOn(L.emptyBoard(), 'APP-1', 'src', {}, { statusCategory: 'indeterminate', assigneeAccountId: 'mei', assigneeName: 'Mei' }).decision.code,
    'HUMAN_WORKING'
  );
  // the agent's own person having it in progress is fine
  assert.equal(
    claimOn(L.emptyBoard(), 'APP-1', 'src', {}, { statusCategory: 'indeterminate', assigneeAccountId: 'yu' }).decision.code,
    'GRANTED'
  );
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', 'src', {}, { statusCategory: 'done' }).decision.code, 'ISSUE_DONE');
  assert.equal(L.claim(L.emptyBoard(), { issueKey: 'APP-404', agent: 'x', paths: 'src' }, ctx({ issue: null })).decision.code, 'NOT_FOUND');
});

test('policy: protected paths, whole repo, per-agent limit, ttl cap', () => {
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', 'api/db/migrations/0042.sql').decision.code, 'PROTECTED_PATH');
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', '**').decision.code, 'TOO_BROAD');
  let b = L.emptyBoard();
  b = claimOn(b, 'APP-1', 'a').board;
  b = claimOn(b, 'APP-2', 'b').board;
  assert.equal(claimOn(b, 'APP-3', 'c').decision.code, 'AGENT_BUSY');
  assert.equal(claimOn(b, 'APP-3', 'c', { agent: 'claude-code/2' }).decision.code, 'GRANTED');
  const long = L.claim(L.emptyBoard(), { issueKey: 'APP-9', agent: 'x', paths: 'z', ttlMinutes: 9999 }, ctx({ issue: issue('APP-9') }));
  assert.equal(long.decision.lease.expiresAt, T0 + 120 * MIN);
  const custom = claimOn(L.emptyBoard(), 'APP-1', 'infra/x', { policy: { protectedPaths: [] } });
  assert.equal(custom.decision.code, 'GRANTED');
});

test('rejects bad input before touching state', () => {
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', '').decision.code, 'BAD_PATHS');
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', '../etc').decision.code, 'BAD_PATHS');
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', 'src', { agent: '  ' }).decision.code, 'BAD_REQUEST');
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', 'src', { accountId: null }).decision.code, 'BAD_REQUEST');
});

test('expired leases free their paths; heartbeats keep them', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  // 31 minutes later, with no heartbeat, the paths are free again
  const late = claimOn(a.board, 'APP-2', 'src/auth', { agent: 'codex', now: T0 + 31 * MIN });
  assert.equal(late.decision.code, 'GRANTED');
  assert.equal(late.expired.length, 1);
  // with a heartbeat at minute 20, the lease survives minute 31
  const hb = L.heartbeat(a.board, { leaseId: a.decision.lease.id, note: 'tests green' }, ctx({ now: T0 + 20 * MIN }));
  assert.equal(hb.decision.code, 'RENEWED');
  assert.equal(hb.decision.lease.notes[0].text, 'tests green');
  const blocked = claimOn(hb.board, 'APP-2', 'src/auth', { agent: 'codex', now: T0 + 31 * MIN });
  assert.equal(blocked.decision.code, 'PATH_COLLISION');
});

test('heartbeat: only the owner, widening is collision-checked', () => {
  let b = claimOn(L.emptyBoard(), 'APP-1', 'src/auth').board;
  const g2 = claimOn(b, 'APP-2', 'src/billing', { agent: 'codex', accountId: 'mei' });
  b = g2.board;
  const id1 = Object.values(b.leases).find((l) => l.issueKey === 'APP-1').id;
  assert.equal(L.heartbeat(b, { leaseId: id1 }, ctx({ accountId: 'mei' })).decision.code, 'NOT_YOURS');
  const widen = L.heartbeat(b, { leaseId: id1, addPaths: 'src/billing/invoice.ts' }, ctx());
  assert.equal(widen.decision.code, 'PATH_COLLISION');
  const ok = L.heartbeat(b, { leaseId: id1, addPaths: 'tests/auth' }, ctx());
  assert.deepEqual(ok.decision.lease.paths, ['src/auth', 'tests/auth']);
  assert.equal(L.heartbeat(b, { leaseId: 'nope' }, ctx()).decision.code, 'LEASE_GONE');
});

test('release and revoke end the lease and keep a record', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  const id = a.decision.lease.id;
  const r = L.release(a.board, { leaseId: id, outcome: 'done', prUrl: 'https://x/pr/1', summary: 'fixed' }, ctx({ now: T0 + 5 * MIN }));
  assert.equal(r.decision.code, 'RELEASED');
  assert.equal(r.decision.lease.outcome, 'done');
  // a done PR keeps its files reserved for review (here: the one changed file is unknown, so the lease paths)
  assert.equal(Object.values(r.board.leases)[0].kind, 'review');
  const noHold = L.release(a.board, { leaseId: id, outcome: 'done', prUrl: 'https://x/pr/1' }, ctx({ now: T0 + 5 * MIN, policy: { holdUntilMerged: false } }));
  assert.equal(Object.keys(noHold.board.leases).length, 0);
  assert.equal(Object.keys(L.release(a.board, { leaseId: id, outcome: 'blocked' }, ctx()).board.leases).length, 0);
  const v = L.revoke(a.board, { leaseId: id, reason: 'mine' }, ctx({ accountId: 'mei', actorName: 'Mei' }));
  assert.equal(v.decision.lease.outcome, 'revoked');
  assert.equal(v.decision.lease.revokedByName, 'Mei');
  // after revoke, the agent's heartbeat is told to stop
  assert.equal(L.heartbeat(v.board, { leaseId: id }, ctx()).decision.code, 'LEASE_GONE');
});

test('closing the work item in Jira ends its lease', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  const r = L.releaseIssue(a.board, 'APP-1', { now: T0 + MIN });
  assert.equal(r.ended.length, 1);
  assert.equal(r.ended[0].outcome, 'closed-in-jira');
});

test('whoHolds answers for paths', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth/**');
  assert.equal(L.whoHolds(a.board, { paths: 'src/auth/x.ts' }, T0).holders[0].issueKey, 'APP-1');
  assert.equal(L.whoHolds(a.board, { paths: 'src/ui' }, T0).holders.length, 0);
});

// ---- concurrency through the real store code and a fake KVS --------------

test('store: many agents racing for overlapping paths -> exactly one wins', async () => {
  const fake = makeFakeKvs();
  const store = makeStore({ ...fake, sleep: () => new Promise((r) => setImmediate(r)) });
  const agents = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
  const results = await Promise.all(
    agents.map((agent, i) =>
      store.update((board) =>
        L.claim(board, { issueKey: `APP-${i + 1}`, agent, paths: `src/auth/file${i}.ts, src/shared/**` }, { now: T0, accountId: `p${i}`, issue: issue(`APP-${i + 1}`), policy: null, newId: `R${i}` })
      )
    )
  );
  const granted = results.filter((r) => r.decision.granted);
  assert.equal(granted.length, 1, 'exactly one claim on src/shared/** may win');
  assert.ok(results.filter((r) => r.decision.code === 'PATH_COLLISION').length === 11);
  const board = await store.readBoard();
  assert.equal(Object.keys(board.leases).length, 1);
  assert.ok(fake.stats.conflicts > 0, 'the race actually happened (some writes were rejected and retried)');
});

test('store: racing agents on disjoint paths all win, none lost', async () => {
  const fake = makeFakeKvs();
  const store = makeStore({ ...fake, sleep: () => new Promise((r) => setImmediate(r)) });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      store.update((board) =>
        L.claim(board, { issueKey: `APP-${i + 1}`, agent: `a${i}`, paths: `pkg${i}/**` }, { now: T0, accountId: `p${i}`, issue: issue(`APP-${i + 1}`), policy: null, newId: `D${i}` })
      )
    )
  );
  assert.equal(results.filter((r) => r.decision.granted).length, 6);
  assert.equal(Object.keys((await store.readBoard()).leases).length, 6, 'no update was lost to a lost write');
});

test('store: history and events come back newest first', async () => {
  const fake = makeFakeKvs();
  const store = makeStore(fake);
  await store.logEvent({ type: 'granted', at: T0 });
  await store.logEvent({ type: 'denied', at: T0 + MIN });
  await store.saveHistory({ id: 'A', endedAt: T0 });
  const ev = await store.listPrefix('evt:');
  assert.deepEqual(ev.map((e) => e.type), ['denied', 'granted']);
  assert.equal((await store.listPrefix('evt:', { since: T0 + 30000 })).length, 1);
  assert.equal((await store.listPrefix('hist:'))[0].id, 'A');
});

test('granted folder claims list the protected paths the agent must not touch', () => {
  const r = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  assert.equal(r.decision.code, 'GRANTED');
  assert.deepEqual(r.decision.lease.excluded, ['**/migrations/**']);
  assert.deepEqual(L.publicLease(r.decision.lease).mustNotTouch, ['**/migrations/**']);
});

test('repository names: https, ssh and scp forms are the same repo', () => {
  for (const r of ['acme/web', 'https://github.com/acme/web.git', 'git@github.com:acme/web.git', 'ssh://git@bitbucket.org/acme/web', 'ACME/Web/'])
    assert.equal(L.normalizeRepo(r), 'acme/web', r);
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src', { repo: 'git@github.com:acme/web.git' });
  assert.equal(claimOn(a.board, 'APP-2', 'src/x', { agent: 'codex', repo: 'https://github.com/acme/web' }).decision.code, 'PATH_COLLISION');
});

test('a person reserves paths; agents on other work items are kept out', () => {
  const r = L.reserve(L.emptyBoard(), { issueKey: 'APP-7', paths: 'src/auth', repo: 'acme/web' }, ctx({ accountId: 'sam', ownerName: 'Sam', issue: issue('APP-7', { labels: [] }) }));
  assert.equal(r.decision.code, 'RESERVED');
  assert.equal(r.decision.lease.kind, 'person');
  assert.equal(r.decision.lease.expiresAt, T0 + 8 * 60 * MIN);
  const agent = claimOn(r.board, 'APP-1', 'src/auth/login.ts', { repo: 'acme/web' });
  assert.equal(agent.decision.code, 'PATH_COLLISION');
  assert.match(agent.decision.reasons[0], /Sam \(a person, working by hand\)/);
  // agents cannot claim the person's work item either
  assert.equal(claimOn(r.board, 'APP-7', 'docs', { policy: { requireLabel: false } }).decision.code, 'ISSUE_LEASED');
  // the person can update their reservation
  const upd = L.reserve(r.board, { issueKey: 'APP-7', paths: 'src/auth, src/session', repo: 'acme/web' }, ctx({ accountId: 'sam', ownerName: 'Sam', issue: issue('APP-7') }));
  assert.equal(upd.decision.code, 'RESERVATION_UPDATED');
  assert.equal(Object.keys(upd.board.leases).length, 1);
  // nobody can name their agent "person"
  assert.equal(claimOn(L.emptyBoard(), 'APP-1', 'src', { agent: 'person' }).decision.code, 'BAD_REQUEST');
});

test('a person cannot reserve over an agent, and is told to take it back', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  const r = L.reserve(a.board, { issueKey: 'APP-1', paths: 'src/auth' }, ctx({ accountId: 'sam', issue: issue('APP-1') }));
  assert.equal(r.decision.code, 'ISSUE_LEASED');
  const other = L.reserve(a.board, { issueKey: 'APP-9', paths: 'src/auth/x.ts' }, ctx({ accountId: 'sam', issue: issue('APP-9') }));
  assert.equal(other.decision.code, 'PATH_COLLISION');
});

test('release checks the changed files against the lease', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth');
  const ok = L.release(a.board, { leaseId: a.decision.lease.id, changedFiles: 'src/auth/login.ts, src/auth/limit.ts' }, ctx());
  assert.deepEqual(ok.decision.lease.scopeCheck, { checked: 2, outside: [], protectedTouched: [], clean: true });
  const bad = L.release(a.board, { leaseId: a.decision.lease.id, changedFiles: 'src/auth/login.ts\nsrc/billing/x.ts\nsrc/auth/migrations/001.sql' }, ctx());
  const sc = bad.decision.lease.scopeCheck;
  assert.equal(sc.clean, false);
  assert.deepEqual(sc.outside, ['src/billing/x.ts']);
  assert.deepEqual(sc.protectedTouched, ['src/auth/migrations/001.sql']);
  assert.equal(L.release(a.board, { leaseId: a.decision.lease.id }, ctx()).decision.lease.scopeCheck, null);
});

test('site-wide cap keeps the lease record small', () => {
  let b = L.emptyBoard();
  for (let i = 0; i < L.MAX_ACTIVE_PER_SITE; i++) b = claimOn(b, `APP-${i + 1}`, `pkg${i}`, { agent: `a${i}` }).board;
  assert.equal(Object.keys(b.leases).length, L.MAX_ACTIVE_PER_SITE);
  assert.ok(JSON.stringify(b).length < 120 * 1024, 'stays well under the Custom Entity value limit');
  assert.equal(claimOn(b, 'APP-999', 'other', { agent: 'late' }).decision.code, 'SITE_FULL');
});

test('shared files (package.json, barrel index.ts) never block, but are flagged', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth/**, package.json', { repo: 'acme/web' });
  assert.equal(a.decision.code, 'GRANTED');
  const b = claimOn(a.board, 'APP-2', 'src/ui/**, package.json, src/auth/index.ts', { agent: 'codex', repo: 'acme/web' });
  assert.equal(b.decision.code, 'GRANTED', JSON.stringify(b.decision));
  assert.match(b.decision.reasons.join(' '), /keep your changes additive/);
  // a real file in the other lease still collides
  assert.equal(claimOn(b.board, 'APP-3', 'src/auth/session.ts', { agent: 'cursor', repo: 'acme/web' }).decision.code, 'PATH_COLLISION');
  // a glob over shared names is not a shared claim
  assert.equal(L.isSharedClaim('src/**/index.ts', L.resolvePolicy()), false);
  assert.equal(L.isSharedClaim('apps/web/package.json', L.resolvePolicy()), true);
  const who = L.whoHolds(b.board, { paths: 'package.json', repo: 'acme/web' }, T0);
  assert.equal(who.holders.length, 0);
  assert.equal(who.shared.length, 2);
});

test('project default repository is used when an agent omits it', () => {
  const pol = { defaultRepo: 'https://github.com/acme/web.git' };
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth', { policy: pol });
  assert.equal(a.decision.lease.repo, 'acme/web');
  assert.equal(claimOn(a.board, 'APP-2', 'src/auth/x.ts', { agent: 'codex', repo: 'acme/web', policy: pol }).decision.code, 'PATH_COLLISION');
});

test('done work with a PR keeps its changed files reserved until merged', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth', { repo: 'acme/web' });
  const id = a.decision.lease.id;
  const r = L.release(a.board, { leaseId: id, outcome: 'done', prUrl: 'https://github.com/acme/web/pull/88', changedFiles: 'src/auth/login.ts, src/auth/limit.ts' }, ctx({ now: T0 + 10 * MIN }));
  assert.deepEqual(r.decision.lease.heldForReview.paths, ['src/auth/login.ts', 'src/auth/limit.ts']);
  const hold = Object.values(r.board.leases)[0];
  assert.equal(hold.expiresAt, T0 + 10 * MIN + 72 * 60 * MIN);
  // another agent: the changed file is reserved, the rest of the folder is free
  const b = claimOn(r.board, 'APP-2', 'src/auth/login.ts', { agent: 'codex', accountId: 'mei', repo: 'acme/web', now: T0 + 11 * MIN });
  assert.equal(b.decision.code, 'PATH_COLLISION');
  assert.match(b.decision.reasons[0], /awaiting review \(https:\/\/github.com\/acme\/web\/pull\/88\)/);
  assert.ok(b.decision.suggestions.some((x) => /build on top of/.test(x)));
  assert.equal(claimOn(r.board, 'APP-2', 'src/auth/session.ts', { agent: 'codex', accountId: 'mei', repo: 'acme/web', now: T0 + 11 * MIN }).decision.code, 'GRANTED');
  // the old lease id is gone for heartbeats
  assert.equal(L.heartbeat(r.board, { leaseId: id }, ctx({ now: T0 + 12 * MIN })).decision.code, 'LEASE_GONE');
  // the same person's agent can come back for review comments
  const back = claimOn(r.board, 'APP-1', 'src/auth', { repo: 'acme/web', now: T0 + 60 * MIN });
  assert.equal(back.decision.code, 'GRANTED');
  assert.equal(Object.values(back.board.leases).filter((l) => l.issueKey === 'APP-1').length, 1);
  // review holds do not count against the agent's concurrency limit
  let bb = r.board;
  bb = claimOn(bb, 'APP-5', 'x', { repo: 'acme/web' }).board;
  assert.equal(claimOn(bb, 'APP-6', 'y', { repo: 'acme/web' }).decision.code, 'GRANTED');
  // closing the work item ends the hold
  assert.equal(L.releaseIssue(r.board, 'APP-1', { now: T0 + 2 * 60 * MIN }).ended.length, 1);
});

test('holders of a shared file hear about the other change on their next heartbeat', () => {
  const a = claimOn(L.emptyBoard(), 'APP-1', 'src/auth/**, package.json', { repo: 'acme/web' });
  const b = claimOn(a.board, 'APP-2', 'src/ui, package.json', { agent: 'codex', accountId: 'mei', ownerName: 'Mei', repo: 'acme/web' });
  const hb = L.heartbeat(b.board, { leaseId: a.decision.lease.id }, ctx({ now: T0 + MIN }));
  assert.match(hb.decision.reasons[0], /codex \(for Mei\) also changes shared file\(s\) "package.json" for APP-2/);
  const hb2 = L.heartbeat(hb.board, { leaseId: a.decision.lease.id }, ctx({ now: T0 + 2 * MIN }));
  assert.equal(hb2.decision.reasons.length, 0, 'told once');
});
