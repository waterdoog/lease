// Everything Lease does, in one place. MCP tools, the Rovo agent, the Jira UI
// and the triggers all call these functions, so they cannot disagree.
import kvs, { Filter, FilterConditions, WhereConditions } from '@forge/kvs';
import * as core from './core/leases.js';
import { makeStore } from './core/store.js';
import * as jira from './jira.js';

export const store = makeStore({ kvs, Filter, FilterConditions, WhereConditions });

// One lease record per repository. Paths only collide within a repository, so
// every grant is still linearizable where it matters, unrelated repositories
// never contend for the same record, and each repository has its own size budget.
const shardStores = new Map();
function shardKeyOf(repo) {
  let h = 0;
  for (const c of repo) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `leases:${repo.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)}:${h.toString(36)}`;
}
export function shard(repo) {
  const key = shardKeyOf(core.normalizeRepo(repo));
  if (!shardStores.has(key)) shardStores.set(key, makeStore({ kvs, Filter, FilterConditions, WhereConditions, boardKey: key }));
  return shardStores.get(key);
}
async function remember(lease) {
  await quietly('shard', () => kvs.set(`shard:${shardKeyOf(lease.repo)}`, { repo: lease.repo }));
  await quietly('lease-map', () => kvs.set(`lease:${lease.id}`, { repo: lease.repo, issueKey: lease.issueKey }, { ttl: { unit: 'DAYS', value: 30 } }));
}
async function repos() {
  const rows = await store.listPrefix('shard:', { limit: 1000 });
  return [...new Set(rows.map((r) => r.repo).filter(Boolean))];
}
// Every active lease on the site, for pages and reports.
async function readAll() {
  const boards = await Promise.all((await repos()).map((r) => shard(r).readBoard()));
  return { rev: 0, leases: Object.assign({}, ...boards.map((b) => b.leases)) };
}
async function repoOfLease(id) {
  const m = await kvs.get(`lease:${id}`).catch(() => null);
  return (m && m.repo) || 'default';
}

const newId = () => `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const projectOf = (issueKey) => jira.cleanKey(issueKey).split('-')[0];

async function quietly(what, fn) {
  try {
    await fn();
  } catch (e) {
    console.warn(`${what}: ${e.message}`);
  }
}

async function policyFor(projectKey) {
  return core.resolvePolicy(await store.getPolicy(projectKey));
}

async function afterExpired(expired, now) {
  for (const l of expired) {
    await quietly('history', () => store.saveHistory({ ...l, endedAt: now, outcome: 'expired' }));
    await quietly('event', () => store.logEvent({ type: 'expired', issueKey: l.issueKey, agent: l.agent, owner: l.ownerName, at: now }));
    await quietly('property', () => jira.setLeaseProperty(l.issueKey, leaseProperty({ ...l, endedAt: now, outcome: 'expired' }, 'expired')));
    if (l.kind === core.REVIEW || l.kind === core.PERSON) {
      await quietly('comment', () =>
        jira.comment(l.issueKey, [
          l.kind === core.REVIEW
            ? `Lease: the review hold on ${l.paths.join(', ')} ended without this work item reaching Done; other agents may change these files again.`
            : `Lease: ${l.ownerName || 'the'} reservation on ${l.paths.join(', ')} ended.`,
        ])
      );
      continue;
    }
    await quietly('comment', () =>
      jira.comment(l.issueKey, [
        [{ text: 'Lease expired. ', strong: true }, `${l.agent}${l.ownerName ? ` (for ${l.ownerName})` : ''} stopped sending heartbeats, so this work item is back in the queue for people and agents.`],
        l.notes?.length ? `Last progress note: "${l.notes[l.notes.length - 1].text}"` : null,
      ].filter(Boolean))
    );
  }
}

// Mirrored onto the work item as the `lease` issue property. JQL can search it
// (issue.property[lease].held = true) and CI can check a pull request against
// it (skill/ci/lease-pr-check.mjs), including after the lease has ended.
function leaseProperty(l, state = 'held') {
  return {
    held: state === 'held',
    state,
    leaseId: l.id,
    kind: l.kind === core.PERSON ? 'person' : 'agent',
    agent: l.agent,
    owner: l.ownerName,
    repo: l.repo,
    paths: l.paths,
    mustNotTouch: l.excluded || [],
    expiresAt: core.fmtTime(l.expiresAt),
    ...(state !== 'held' ? { endedAt: core.fmtTime(l.endedAt || Date.now()), outcome: l.outcome || state, prUrl: l.prUrl || null } : {}),
    ...(l.scopeCheck ? { scopeCheck: { clean: l.scopeCheck.clean, outside: l.scopeCheck.outside.slice(0, 20), protectedTouched: l.scopeCheck.protectedTouched.slice(0, 20) } } : {}),
  };
}

export async function claimWork(input, { accountId }) {
  const now = Date.now();
  const issueKey = jira.cleanKey(input.issueKey);
  if (!jira.isIssueKey(issueKey)) return { granted: false, code: 'BAD_REQUEST', reasons: [`"${input.issueKey}" is not a work item key like PROJ-123.`] };
  const [issue, me, policy] = await Promise.all([
    jira.getIssue(issueKey),
    jira.myself().catch(() => ({ accountId, displayName: null })),
    policyFor(projectOf(issueKey)),
  ]);
  const repo = core.normalizeRepo(input.repo || policy.defaultRepo);
  // One holder per work item across repositories (a work item may span repositories
  // for the same person's agents).
  const elsewhere = core.leaseForIssue(await readAll(), issueKey, now);
  if (elsewhere && elsewhere.repo !== repo && elsewhere.ownerAccountId !== accountId)
    return present({ granted: false, code: 'ISSUE_LEASED', reasons: [`${issueKey} is already held in ${elsewhere.repo} by ${elsewhere.kind === core.PERSON ? elsewhere.ownerName || 'a person' : elsewhere.agent}.`], holder: core.publicLease(elsewhere), retryAfter: elsewhere.expiresAt });
  const id = newId();
  const result = await shard(repo).update((board) =>
    core.claim(board, { ...input, issueKey, repo }, { now, accountId, ownerName: me.displayName, issue, policy, newId: id })
  );
  await afterExpired(result.expired, now);
  const d = result.decision;
  await quietly('event', () =>
    store.logEvent({
      type: d.granted ? (d.code === 'ALREADY_HELD' ? 'renewed' : 'granted') : 'denied',
      code: d.code,
      issueKey,
      agent: core.normalizeAgent(input.agent),
      owner: me.displayName,
      reasons: d.reasons,
      blockedBy: d.collisions?.map((c) => `${c.issueKey}:${c.agent}`) || (d.holder ? [`${d.holder.issueKey}:${d.holder.agent}`] : []),
      at: now,
    })
  );
  if (d.granted && d.code === 'GRANTED') {
    const l = d.lease;
    await remember(l);
    await quietly('property', () => jira.setLeaseProperty(issueKey, leaseProperty(l)));
    await quietly('comment', () =>
      jira.comment(issueKey, [
        [{ text: 'Leased to an agent. ', strong: true }, `${l.agent}${l.ownerName ? `, working for ${l.ownerName},` : ''} holds this work item until ${core.fmtTime(l.expiresAt)} (renewed by heartbeats).`],
        `Paths: ${l.paths.join(', ')}${l.repo !== 'default' ? ` in ${l.repo}` : ''}`,
        l.intent ? `Plan: ${l.intent}` : null,
      ].filter(Boolean))
    );
  }
  return present(d);
}

// "Would this claim be granted?" without taking anything. Useful to plan agent
// work, and lets reviewers try the policy without connecting an agent.
export async function dryRunClaim(input, { accountId }) {
  const now = Date.now();
  const issueKey = jira.cleanKey(input.issueKey);
  if (!jira.isIssueKey(issueKey)) return { granted: false, result: 'BAD_REQUEST', reasons: [`"${input.issueKey}" is not a work item key like PROJ-123.`] };
  const [issue, policy] = await Promise.all([jira.getIssue(issueKey), policyFor(projectOf(issueKey))]);
  const repo = core.normalizeRepo(input.repo || policy.defaultRepo);
  const board = await shard(repo).readBoard();
  const { decision } = core.claim(board, { ...input, issueKey, repo }, { now, accountId, issue, policy, newId: 'DRY-RUN' });
  return { dryRun: true, ...present(decision) };
}

const SAMPLE_WORK = [
  ['Add rate limiting to the login endpoint', 'Five attempts per minute per IP; return 429 with Retry-After.', true],
  ['Refresh tokens should rotate on every use', 'Session refresh in src/auth/session.ts reuses the old token.', true],
  ['Fix rounding of invoice totals', 'Totals are off by one cent for some VAT rates (src/billing).', true],
  ['Rename billing columns to snake_case', 'Needs a database migration; a person should own the migration.', true],
  ['Add dark mode to the settings page', 'Design is not final yet: keep this one for people.', false],
  ['Cache headers for static assets', 'Long-lived immutable caching for hashed files (src/http).', true],
];

export async function createSampleWork(projectKey) {
  const pk = String(projectKey || '').trim().toUpperCase();
  if (!(await jira.isProjectAdmin(pk))) return { ok: false, reasons: [`Only administrators of ${pk} can add sample work items.`] };
  const policy = await policyFor(pk);
  const created = [];
  for (const [summary, description, forAgents] of SAMPLE_WORK) {
    created.push(await jira.createIssue(pk, { summary, description, labels: forAgents ? [policy.agentLabel, 'lease-sample'] : ['lease-sample'] }));
  }
  return { ok: true, created };
}

export async function heartbeatLease(input, { accountId }) {
  const now = Date.now();
  const box = shard(await repoOfLease(input.leaseId));
  const board0 = await box.readBoard();
  const l0 = board0.leases[input.leaseId];
  const policy = await policyFor(l0?.projectKey || 'NONE');
  const result = await box.update((board) => core.heartbeat(board, input, { now, accountId, policy }));
  await afterExpired(result.expired, now);
  const d = await explainGone(result.decision, input.leaseId, now);
  if (d.granted) await quietly('property', () => jira.setLeaseProperty(d.lease.issueKey, leaseProperty(d.lease)));
  if (!d.granted) await quietly('event', () => store.logEvent({ type: 'denied', code: d.code, issueKey: l0?.issueKey, agent: l0?.agent, reasons: d.reasons, at: now }));
  return present(d);
}

// If a person took the lease back, tell the agent who, when and why, and record
// that the agent has now been told (the Jira panel shows "stopping" until then).
async function explainGone(d, leaseId, now) {
  if (d.granted || d.code !== 'LEASE_GONE' || !leaseId) return d;
  const key = `revoked:${leaseId}`;
  const t = await kvs.get(key).catch(() => null);
  if (!t) return d;
  if (!t.acknowledgedAt) await quietly('tombstone', () => kvs.set(key, { ...t, acknowledgedAt: now }, { ttl: { unit: 'DAYS', value: 2 } }));
  return {
    ...d,
    code: 'LEASE_GONE',
    reasons: [
      `${t.byName || 'A person'} took ${t.issueKey} back at ${core.fmtTime(t.at)}${t.reason ? `: "${t.reason}"` : '.'} Stop changing files for ${t.issueKey} now and do not push further commits for it.`,
    ],
  };
}

export async function releaseLease(input, { accountId }) {
  const now = Date.now();
  const box = shard(await repoOfLease(input.leaseId));
  const board0 = await box.readBoard();
  const policy = await policyFor(board0.leases[input.leaseId]?.projectKey || 'NONE');
  const result = await box.update((board) => core.release(board, input, { now, accountId, policy }));
  await afterExpired(result.expired, now);
  const d = await explainGone(result.decision, input.leaseId, now);
  if (d.granted) {
    const l = d.lease;
    await quietly('history', () => store.saveHistory(l));
    await quietly('event', () => store.logEvent({ type: 'released', outcome: l.outcome, issueKey: l.issueKey, agent: l.agent, owner: l.ownerName, prUrl: l.prUrl, scopeClean: l.scopeCheck ? l.scopeCheck.clean : null, at: now }));
    await quietly('property', () =>
      jira.setLeaseProperty(l.issueKey, l.heldForReview ? { ...leaseProperty({ ...l, paths: l.heldForReview.paths, expiresAt: l.heldForReview.until }, 'awaiting-merge'), held: true } : leaseProperty(l, 'released'))
    );
    const mins = Math.max(1, Math.round((l.endedAt - l.createdAt) / 60000));
    await quietly('comment', () =>
      jira.comment(l.issueKey, [
        [{ text: `Agent finished: ${l.outcome}. `, strong: true }, `${l.agent} held this work item for ${mins} min and released it.`],
        l.summaryOfWork ? `What it did: ${l.summaryOfWork}` : null,
        l.prUrl ? ['Pull request: ', { text: l.prUrl, link: l.prUrl }] : null,
        l.scopeCheck
          ? l.scopeCheck.clean
            ? l.scopeCheck.checked === 1 ? 'Scope check: the changed file is inside the lease.' : `Scope check: all ${l.scopeCheck.checked} changed files are inside the lease.`
            : [
                { text: 'Scope check failed. ', strong: true },
                [
                  l.scopeCheck.outside.length ? `${core.count(l.scopeCheck.outside.length, 'changed file')} outside the lease: ${l.scopeCheck.outside.slice(0, 8).join(', ')}.` : '',
                  l.scopeCheck.protectedTouched.length ? ` Protected ${l.scopeCheck.protectedTouched.length === 1 ? 'path' : 'paths'} changed: ${l.scopeCheck.protectedTouched.slice(0, 8).join(', ')}.` : '',
                ].join(''),
              ]
          : null,
        l.outcome === 'done' ? 'A person should review the change before this work item is closed.' : null,
        l.heldForReview
          ? `Until this work item is Done, Lease keeps ${l.heldForReview.paths.join(', ')} reserved for this pull request (at most until ${core.fmtTime(l.heldForReview.until)}), so other agents don't build conflicting changes.`
          : null,
      ].filter(Boolean))
    );
  }
  return present(d);
}

export async function revokeLease(input, { accountId }) {
  const now = Date.now();
  const box = shard(await repoOfLease(input.leaseId));
  const board = await box.readBoard();
  const l = board.leases[input.leaseId];
  if (!l) return { granted: false, code: 'LEASE_GONE', reasons: ['That lease is no longer active.'] };
  const allowed = l.ownerAccountId === accountId || (await jira.canEditIssue(l.issueKey));
  if (!allowed) return { granted: false, code: 'FORBIDDEN', reasons: ['Only the agent’s person or someone who can edit the work item can take it back.'] };
  const me = await jira.myself().catch(() => ({ displayName: null }));
  const result = await box.update((b) => core.revoke(b, input, { now, accountId, actorName: me.displayName }));
  const d = result.decision;
  if (d.granted) {
    await quietly('history', () => store.saveHistory(d.lease));
    await quietly('event', () => store.logEvent({ type: 'revoked', issueKey: d.lease.issueKey, agent: d.lease.agent, by: me.displayName, at: now }));
    // Simulated agents (from "Simulate two agents") never call again, so they "hear" it at once.
    const simulated = d.lease.agent.startsWith('sim-');
    if (!d.lease.kind)
      await quietly('tombstone', () =>
        kvs.set(
          `revoked:${d.lease.id}`,
          { leaseId: d.lease.id, issueKey: d.lease.issueKey, agent: d.lease.agent, byName: me.displayName, reason: d.lease.reason, at: now, ...(simulated ? { acknowledgedAt: now } : {}) },
          { ttl: { unit: 'DAYS', value: 2 } }
        )
      );
    await quietly('property', () => jira.setLeaseProperty(d.lease.issueKey, leaseProperty(d.lease, 'revoked')));
    await quietly('comment', () =>
      jira.comment(d.lease.issueKey, [
        [{ text: 'Taken back from the agent. ', strong: true }, `${me.displayName || 'A person'} revoked ${d.lease.agent}'s lease${d.lease.reason ? `: ${d.lease.reason}` : '.'}`],
        'The agent will be told the next time it sends a heartbeat.',
      ])
    );
  }
  return present(d);
}

export async function reservePaths(input, { accountId }) {
  const now = Date.now();
  const issueKey = jira.cleanKey(input.issueKey);
  const [issue, me, policy] = await Promise.all([jira.getIssue(issueKey), jira.myself().catch(() => ({ displayName: null })), policyFor(projectOf(issueKey))]);
  const id = newId();
  const repo = core.normalizeRepo(input.repo || policy.defaultRepo);
  const result = await shard(repo).update((board) => core.reserve(board, { ...input, issueKey, repo }, { now, accountId, ownerName: me.displayName, issue, policy, newId: id }));
  await afterExpired(result.expired, now);
  const d = result.decision;
  if (d.granted) await remember(d.lease);
  await quietly('event', () =>
    store.logEvent({ type: d.granted ? 'reserved' : 'denied', code: d.code, issueKey, agent: core.PERSON, owner: me.displayName, reasons: d.reasons, at: now })
  );
  if (d.granted) await quietly('property', () => jira.setLeaseProperty(issueKey, leaseProperty(d.lease)));
  return present(d);
}

// Revocations the agent has not yet heard about (it learns on its next call).
export async function pendingStops(issueKey) {
  const all = await store.listPrefix('revoked:', { limit: 200 });
  return all.filter((t) => t.issueKey === issueKey).map((t) => ({ agent: t.agent, by: t.byName, at: t.at, acknowledgedAt: t.acknowledgedAt || null }));
}

// Try Lease without connecting an agent: two simulated agents, working for the
// person who clicks, go through the real claim/heartbeat code on sample work.
const SIM_REPO = 'lease-demo/sample-app';

export async function simulateAgents(projectKey, { accountId }) {
  const pk = String(projectKey || '').trim().toUpperCase();
  const found = await findWork({ projectKey: pk, limit: 25 });
  const pick = (re) => found.available.find((a) => re.test(a.summary));
  // The script only makes sense on the sample work items it was written for; never borrow unrelated ones.
  const a = pick(/rate limit/i);
  const b = pick(/refresh token/i);
  const c = pick(/invoice|rounding/i);
  if (!a || !b || !c) {
    const busy = found.unavailable.filter((u) => /rate limit|refresh token|invoice|rounding/i.test(u.summary));
    return {
      ok: false,
      reasons: busy.length
        ? [`The simulator uses the sample work items, and some are taken right now: ${busy.map((u) => `${u.issueKey} (${u.heldBy})`).join(', ')}. Try again when they are free.`]
        : [`The simulator needs the sample work items in ${pk}. Add them first.`],
    };
  }
  const steps = [];
  const log = (who, what, r) => steps.push({ who, what, granted: r.granted, result: r.result, says: (r.reasons || [])[0] || (r.lease ? `lease ${r.lease.leaseId} until ${r.lease.expiresAt}` : '') });
  const r1 = await claimWork({ issueKey: a.issueKey, agent: 'sim-claude', repo: SIM_REPO, paths: 'src/auth/**, tests/auth/**', intent: 'Rate limit on /login (simulated agent)' }, { accountId });
  log('sim-claude', `claims ${a.issueKey} for src/auth/**`, r1);
  if (r1.granted) log('sim-claude', 'sends a heartbeat', await heartbeatLease({ leaseId: r1.lease.leaseId, note: 'Limiter middleware drafted (simulated)' }, { accountId }));
  log('sim-codex', `claims ${b.issueKey} for src/auth/session.ts`, await claimWork({ issueKey: b.issueKey, agent: 'sim-codex', repo: SIM_REPO, paths: 'src/auth/session.ts', intent: 'Rotate refresh tokens (simulated agent)' }, { accountId }));
  log('sim-codex', `claims ${c.issueKey} for src/billing/** instead`, await claimWork({ issueKey: c.issueKey, agent: 'sim-codex', repo: SIM_REPO, paths: 'src/billing/**', intent: 'Fix invoice rounding (simulated agent)' }, { accountId }));
  const e = pick(/cache|header/i);
  if (e) {
    const me = await reservePaths({ issueKey: e.issueKey, paths: 'src/http', repo: SIM_REPO, hours: 1 }, { accountId });
    log('you (by hand)', `reserve src/http for ${e.issueKey} for 1 hour`, me);
    log('sim-cursor', `would claim ${b.issueKey} for src/http/cache.ts (checked, not taken)`, await dryRunClaim({ issueKey: b.issueKey, agent: 'sim-cursor', repo: SIM_REPO, paths: 'src/http/cache.ts' }, { accountId }));
  }
  const d = pick(/rename|column|migration/i);
  if (d) log('sim-cursor', `would claim ${d.issueKey} for db/migrations/0042.sql (checked, not taken)`, await dryRunClaim({ issueKey: d.issueKey, agent: 'sim-cursor', repo: SIM_REPO, paths: 'db/migrations/0042.sql' }, { accountId }));
  return { ok: true, steps };
}

export async function checkPaths(input) {
  const board = await shard(input.repo).readBoard();
  const res = core.whoHolds(board, input, Date.now(), null);
  if (res.errors.length) return { ok: false, reasons: res.errors };
  return {
    ok: true,
    clear: res.holders.length === 0,
    holders: res.holders,
    sharedWith: res.shared,
    advice: res.holders.length
      ? 'Do not edit files under these paths: another agent holds them. Ask its person, or wait for the lease to end.'
      : 'Nobody holds these paths. If you are about to change them, widen your own lease first (heartbeat with addPaths).',
  };
}

export async function findWork({ projectKey, limit = 10 }) {
  const now = Date.now();
  const pk = String(projectKey || '').trim().toUpperCase();
  const policy = await policyFor(pk || 'NONE');
  const scope = pk ? `project = "${pk}" AND ` : '';
  const labelClause = policy.requireLabel ? `labels = "${policy.agentLabel}" AND ` : '';
  const issues = await jira.searchIssues(`${scope}${labelClause}statusCategory != Done ORDER BY priority DESC, updated DESC`, { max: 50 });
  const board = await readAll();
  const free = [];
  const taken = [];
  for (const i of issues) {
    const held = core.leaseForIssue(board, i.key, now);
    if (held) taken.push({ issueKey: i.key, summary: i.summary, heldBy: held.agent, until: core.fmtTime(held.expiresAt) });
    else if (policy.respectHumanInProgress && i.statusCategory === 'indeterminate' && i.assigneeAccountId)
      taken.push({ issueKey: i.key, summary: i.summary, heldBy: i.assigneeName, until: 'a person is working on it' });
    else free.push({ issueKey: i.key, summary: i.summary, status: i.statusName });
  }
  const busyPaths = core.activeLeases(board, now).map((l) => ({ issueKey: l.issueKey, agent: l.agent, repo: l.repo, paths: l.paths }));
  return {
    available: free.slice(0, Math.max(1, Math.min(25, +limit || 10))),
    unavailable: taken,
    pathsAlreadyLeased: busyPaths,
    howToClaim: 'Call claim-work with the issueKey, your agent name and the paths you will change.',
  };
}

export async function status({ issueKey, projectKey } = {}) {
  const now = Date.now();
  const board = await readAll();
  let leases = core.activeLeases(board, now);
  if (issueKey) leases = leases.filter((l) => l.issueKey === jira.cleanKey(issueKey));
  else if (projectKey) leases = leases.filter((l) => l.projectKey === String(projectKey).toUpperCase());
  return { activeLeases: leases.map(core.publicLease), count: leases.filter((l) => !l.kind).length, at: core.fmtTime(now) };
}

export async function report({ hours = 12, projectKey } = {}) {
  const now = Date.now();
  const since = now - Math.min(24 * 14, Math.max(1, +hours || 12)) * 3600 * 1000;
  const [history, events, board] = await Promise.all([
    store.listPrefix('hist:', { since, limit: 300 }),
    store.listPrefix('evt:', { since, limit: 500 }),
    readAll(),
  ]);
  const pk = projectKey ? String(projectKey).toUpperCase() : null;
  const inProject = (k) => !pk || String(k || '').startsWith(`${pk}-`);
  const finished = history.filter((h) => inProject(h.issueKey));
  const ev = events.filter((e) => inProject(e.issueKey));
  const count = (t, extra = () => true) => ev.filter((e) => e.type === t && extra(e)).length;
  const activeKeys = new Set(core.activeLeases(board, now).map((l) => l.issueKey));
  return {
    window: { from: core.fmtTime(since), to: core.fmtTime(now) },
    totals: {
      claimsGranted: count('granted'),
      claimsDenied: count('denied'),
      collisionsPrevented: count('denied', (e) => e.code === 'PATH_COLLISION' || e.code === 'ISSUE_LEASED'),
      humanWorkProtected: count('denied', (e) => e.code === 'HUMAN_WORKING'),
      protectedPathsBlocked: count('denied', (e) => e.code === 'PROTECTED_PATH'),
      finished: finished.filter((h) => h.outcome === 'done').length,
      handedBackOrBlocked: finished.filter((h) => ['handed-back', 'blocked', 'abandoned'].includes(h.outcome)).length,
      expired: finished.filter((h) => h.outcome === 'expired').length,
      revokedByPeople: finished.filter((h) => h.outcome === 'revoked').length,
    },
    finishedWork: finished.slice(0, 50).map((h) => ({
      issueKey: h.issueKey,
      summary: h.summary,
      agent: h.agent,
      owner: h.ownerName,
      outcome: h.outcome,
      pr: h.prUrl,
      whatItDid: h.summaryOfWork || (h.notes?.length ? h.notes[h.notes.length - 1].text : ''),
      minutes: Math.max(1, Math.round((h.endedAt - h.createdAt) / 60000)),
    })),
    // One row per work item: its newest outcome, and only if nobody has picked it up again since.
    needsAPerson: [...new Map(finished.map((h) => [h.issueKey, h]).reverse()).values()].reverse()
      .filter((h) => ['blocked', 'handed-back', 'expired'].includes(h.outcome) && !activeKeys.has(h.issueKey))
      .map((h) => ({ issueKey: h.issueKey, summary: h.summary, agent: h.agent, outcome: h.outcome, at: core.fmtTime(h.endedAt), lastNote: h.summaryOfWork || h.notes?.[h.notes.length - 1]?.text || '' })),
    stillRunning: core.activeLeases(board, now).filter((l) => inProject(l.issueKey) && !l.kind).map(core.publicLease),
    awaitingMerge: core.activeLeases(board, now).filter((l) => inProject(l.issueKey) && l.kind === core.REVIEW).map(core.publicLease),
    reservedByPeople: core.activeLeases(board, now).filter((l) => inProject(l.issueKey) && l.kind === core.PERSON).map(core.publicLease),
    recentDenials: ev.filter((e) => e.type === 'denied').slice(0, 15).map((e) => ({ at: core.fmtTime(e.at), issueKey: e.issueKey, agent: e.agent, code: e.code, why: e.reasons?.[0] })),
  };
}

export async function markAgentReady(issueKey, ready) {
  const key = jira.cleanKey(issueKey);
  const policy = await policyFor(projectOf(key));
  if (ready) await jira.addLabel(key, policy.agentLabel);
  else await jira.removeLabel(key, policy.agentLabel);
  return { ok: true, label: policy.agentLabel, ready };
}

export async function issueFacts(issueKey) {
  return jira.getIssue(issueKey).catch(() => null);
}

export async function getPolicy(projectKey) {
  return policyFor(String(projectKey || '').toUpperCase());
}

export async function savePolicy(projectKey, patch) {
  const pk = String(projectKey || '').toUpperCase();
  if (!(await jira.isProjectAdmin(pk))) return { ok: false, reasons: [`Only administrators of ${pk} can change its agent policy.`] };
  const merged = core.resolvePolicy({ ...(await store.getPolicy(pk)), ...patch });
  await store.setPolicy(pk, merged);
  return { ok: true, policy: merged };
}

// Scheduled every five minutes: reclaim work from agents that went silent.
// Jira workflow validator: blocks a transition while an agent still holds the
// work item, or after its hand-off left the lease until a person marks it reviewed.
export async function leaseGate(issueKey) {
  const facts = await jira.getLeaseFacts(issueKey);
  if (!facts) return { result: true };
  return core.gate(facts.lease, facts.labels);
}

export async function sweepExpired() {
  const now = Date.now();
  let n = 0;
  for (const r of await repos()) {
    const result = await shard(r).update((board) => core.sweep(board, now));
    await afterExpired(result.expired, now);
    n += result.expired.length;
  }
  return n;
}

// Jira changed a work item. If a person closed it, end its lease; if a person
// started working on it while an agent holds it, say so once.
export async function onIssueChanged(issueKey) {
  const now = Date.now();
  const board = await readAll();
  const lease = core.leaseForIssue(board, issueKey, now);
  if (!lease) return 'no lease';
  const box = shard(lease.repo);
  const issue = await jira.getIssue(issueKey, { as: 'app' });
  if (!issue) return 'issue gone';
  const policy = await policyFor(projectOf(issueKey));
  const mergedStatus = lease.kind === core.REVIEW && policy.mergedStatuses.some((s) => s.toLowerCase() === String(issue.statusName).toLowerCase());
  if (issue.statusCategory === 'done' || mergedStatus) {
    const result = { ended: [] };
    for (const r of new Set(core.activeLeases(board, now).filter((l) => l.issueKey === issueKey).map((l) => l.repo))) {
      const one = await shard(r).update((b) => core.releaseIssue(b, issueKey, { now, outcome: mergedStatus ? 'merged' : 'closed-in-jira' }));
      result.ended.push(...one.ended);
    }
    for (const l of result.ended) {
      await quietly('history', () => store.saveHistory(l));
      await quietly('event', () => store.logEvent({ type: 'released', outcome: l.outcome, issueKey, agent: l.agent, at: now }));
    }
    for (const l of result.ended) await quietly('property', () => jira.setLeaseProperty(issueKey, leaseProperty(l, 'released')));
    return 'released';
  }
  const humanStarted =
    !lease.kind && issue.statusCategory === 'indeterminate' && issue.assigneeAccountId && issue.assigneeAccountId !== lease.ownerAccountId;
  if (humanStarted && !lease.humanOverlapNotified) {
    await box.update((b) => ({ board: core.markHumanOverlap(b, lease.id) }));
    await quietly('event', () => store.logEvent({ type: 'human-overlap', issueKey, agent: lease.agent, owner: issue.assigneeName, at: now }));
    await quietly('comment', () =>
      jira.comment(issueKey, [
        [{ text: 'Two people on one task. ', strong: true }, `${issue.assigneeName} started this work item while ${lease.agent}${lease.ownerName ? ` (for ${lease.ownerName})` : ''} still holds a lease until ${core.fmtTime(lease.expiresAt)}.`],
        'Agree who continues: take the lease back from the Lease panel, or unassign.',
      ])
    );
    return 'flagged';
  }
  return 'ok';
}

// Leases are stored app-wide, but people (and their agents) must only learn
// about work items they can see. Everything a tool or page returns goes through
// here: for hidden work items the key, summary, plan, notes and PR are removed;
// the paths stay, because that is what keeps agents from colliding.
const KEY_RE = /\b[A-Z][A-Z0-9_]{0,19}-\d{1,9}\b/g;
const HIDDEN = 'a work item you cannot see';

export async function visibleOnly(output) {
  if (!output || typeof output !== 'object') return output;
  const keys = [...new Set(JSON.stringify(output).match(KEY_RE) || [])];
  if (!keys.length) return output;
  let visible;
  try {
    visible = await jira.visibleKeys(keys);
  } catch (e) {
    console.warn(`visibility check failed, hiding all: ${e.message}`);
    visible = new Set();
  }
  const hidden = new Set(keys.filter((k) => !visible.has(k)));
  if (!hidden.size) return output;
  const fixText = (t) => t.replace(KEY_RE, (k) => (hidden.has(k) ? HIDDEN : k));
  const walk = (v) => {
    if (typeof v === 'string') return fixText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (typeof v.issueKey === 'string' && hidden.has(v.issueKey)) {
        const { summary, intent, notes, prUrl, pr, whatItDid, lastNote, why, ...rest } = v;
        return walk({ ...rest, issueKey: '(hidden)', hidden: true });
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(output);
}

// Turn a decision into what tools and agents should see: short and actionable.
export function present(d) {
  if (d.granted) {
    const out = { granted: true, result: d.code, lease: core.publicLease(d.lease), reasons: d.reasons || [] };
    if (d.code === 'GRANTED' || d.code === 'ALREADY_HELD')
      out.next = `Work only inside the leased paths. Call heartbeat with leaseId ${d.lease.id} at least every 10 minutes, and release it with the pull request link when done.`;
    if (d.code === 'RELEASED' || d.code === 'REVOKED') out.lease = { ...core.publicLease(d.lease), outcome: d.lease.outcome, prUrl: d.lease.prUrl || null };
    if (d.lease.heldForReview)
      out.next = `Released. Your changed files stay reserved for this pull request until the work item is Done. To address review comments later, claim ${d.lease.issueKey} again.`;
    if (d.lease.scopeCheck) out.scopeCheck = d.lease.scopeCheck;
    return out;
  }
  return {
    granted: false,
    result: d.code,
    reasons: d.reasons,
    ...(d.collisions ? { collisions: d.collisions } : {}),
    ...(d.holder ? { heldBy: d.holder } : {}),
    ...(d.retryAfter ? { retryAfter: core.fmtTime(d.retryAfter) } : {}),
    ...(d.suggestions ? { suggestions: d.suggestions } : {}),
  };
}
