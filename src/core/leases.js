// The lease table: pure functions over a board object. No I/O here, so every
// rule can be tested offline and the same code decides for the MCP tools, the
// Rovo agent, the Jira panel and the triggers.
//
// board = { rev: number, leases: { [id]: Lease } }
// Lease = { id, issueKey, projectKey, summary, repo, paths[], agent, ownerAccountId,
//           ownerName, intent, createdAt, heartbeatAt, expiresAt, notes[], humanOverlapNotified? }

import { parsePathList, overlaps, isWholeRepo, claimEntersProtected, pathMatches } from './paths.js';

/** "1 file", "3 files". */
export const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const DEFAULT_POLICY = Object.freeze({
  agentLabel: 'agent-ok',
  requireLabel: true,
  maxActivePerAgent: 2,
  defaultTtlMinutes: 30,
  maxTtlMinutes: 120,
  maxPathsPerLease: 20,
  allowWholeRepo: false,
  respectHumanInProgress: true,
  protectedPaths: ['**/migrations/**', 'infra/**', '.github/workflows/**'],
  personReserveHours: 8,
  // Files nearly every change touches. Claims on them never block each other:
  // they are granted with a note to keep changes additive and let git merge.
  sharedPaths: ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/index.ts', '**/index.js', '**/*.d.ts', '**/CHANGELOG.md'],
  defaultRepo: '',
  // After an agent hands off a pull request, keep its files reserved until the
  // work item is Done (merged), so the next agent doesn't rebuild the conflict.
  holdUntilMerged: true,
  reviewHoldHours: 24,
  // 'block': overlapping claims are refused. 'warn': they are granted with a
  // warning to both sides (a gentler way to start). People, protected paths
  // and work in progress are always enforced.
  collisionMode: 'block',
  // Statuses that mean "merged" before Done (e.g. "In QA", "Staging"): a pull
  // request hold ends when the work item reaches one of them.
  mergedStatuses: [],
  // A handed-off pull request's files: 'warn' tells the next agent (and grants),
  // 'block' refuses overlapping claims until the work item is Done.
  reviewHoldMode: 'warn',
  // Agents allowed to claim work in this project (empty means any agent).
  allowedAgents: [],
});

// One record holds every active lease on the site (that is what makes grants
// linearizable). Keep it well below the 240 KiB Custom Entity value limit.
export const MAX_BOARD_BYTES = 200 * 1024;
export const boardBytes = (board) => Buffer.byteLength(JSON.stringify(board.leases));
export const PERSON = 'person';
export const REVIEW = 'review';

export function resolvePolicy(stored) {
  const p = { ...DEFAULT_POLICY, ...(stored || {}) };
  const int = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
  p.maxActivePerAgent = int(p.maxActivePerAgent, 1, 50, DEFAULT_POLICY.maxActivePerAgent);
  p.maxTtlMinutes = int(p.maxTtlMinutes, 5, 24 * 60, DEFAULT_POLICY.maxTtlMinutes);
  p.defaultTtlMinutes = int(p.defaultTtlMinutes, 5, p.maxTtlMinutes, Math.min(DEFAULT_POLICY.defaultTtlMinutes, p.maxTtlMinutes));
  p.maxPathsPerLease = int(p.maxPathsPerLease, 1, 200, DEFAULT_POLICY.maxPathsPerLease);
  p.agentLabel = String(p.agentLabel || DEFAULT_POLICY.agentLabel).trim().replace(/\s+/g, '-');
  p.protectedPaths = parsePathList(p.protectedPaths || []).patterns;
  p.requireLabel = p.requireLabel !== false;
  p.allowWholeRepo = p.allowWholeRepo === true;
  p.respectHumanInProgress = p.respectHumanInProgress !== false;
  p.personReserveHours = int(p.personReserveHours, 1, 24, DEFAULT_POLICY.personReserveHours);
  p.sharedPaths = parsePathList(p.sharedPaths || []).patterns;
  p.defaultRepo = p.defaultRepo ? normalizeRepo(p.defaultRepo) : '';
  p.holdUntilMerged = p.holdUntilMerged !== false;
  p.reviewHoldHours = int(p.reviewHoldHours, 1, 336, DEFAULT_POLICY.reviewHoldHours);
  p.collisionMode = p.collisionMode === 'warn' ? 'warn' : 'block';
  p.reviewHoldMode = p.reviewHoldMode === 'block' ? 'block' : 'warn';
  p.mergedStatuses = (Array.isArray(p.mergedStatuses) ? p.mergedStatuses : String(p.mergedStatuses || '').split(','))
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 20);
  p.allowedAgents = [
    ...new Set(
      (Array.isArray(p.allowedAgents) ? p.allowedAgents : String(p.allowedAgents || '').split(','))
        .map((x) => normalizeAgent(x))
        .filter((x) => x && x !== PERSON)
    ),
  ].slice(0, 50);
  return p;
}

export const emptyBoard = () => ({ rev: 0, leases: {} });

const MIN = 60 * 1000;
const clone = (b) => ({ rev: b.rev, leases: { ...b.leases } });
const fmtTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function normalizeAgent(agent) {
  const a = String(agent ?? '').trim().toLowerCase().replace(/[^a-z0-9._@/-]+/g, '-').replace(/^-+|-+$/g, '');
  return a.slice(0, 60);
}

// "acme/web", "https://github.com/acme/web.git", "git@github.com:acme/web.git"
// and "ssh://git@bitbucket.org/acme/web" all name the same repository.
export function normalizeRepo(repo) {
  const r = String(repo ?? '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\//, '') // scheme://[user@]host/
    .replace(/^[^@/\s]+@[^:/\s]+:/, ''); // scp-style user@host:
  return r || 'default';
}

function ttlMs(requested, policy) {
  const m = Number.isFinite(+requested) && +requested > 0 ? +requested : policy.defaultTtlMinutes;
  return Math.min(Math.max(5, Math.round(m)), policy.maxTtlMinutes) * MIN;
}

// Drop leases whose time ran out. Returns the expired ones so callers can log
// them and tell the issue that its work went back to the queue.
export function sweep(board, now) {
  const next = clone(board);
  const expired = [];
  for (const [id, l] of Object.entries(next.leases)) {
    if (l.expiresAt <= now) {
      expired.push(l);
      delete next.leases[id];
    }
  }
  return { board: next, expired };
}

export function activeLeases(board, now) {
  return Object.values(board.leases).filter((l) => l.expiresAt > now);
}

export function leaseForIssue(board, issueKey, now) {
  return activeLeases(board, now).find((l) => l.issueKey === issueKey) || null;
}

// A claim on one concrete shared file (package.json, a barrel index.ts...).
// (A single-segment wildcard before the file name is fine: "packages/*/package.json".)
export function isSharedClaim(pattern, policy) {
  const segs = pattern.split('/');
  if (segs.includes('**') || /[*?]/.test(segs[segs.length - 1])) return false;
  return (policy?.sharedPaths || []).some((sp) => pathMatches(sp, pattern));
}

// Overlaps with other active leases in the same repository. Pairs where either
// side is a shared-file claim do not block; they are returned as `shared`.
function collisionsWith(board, { repo, patterns, excludeId }, now, policy) {
  const hits = [];
  const shared = [];
  for (const l of activeLeases(board, now)) {
    if (l.id === excludeId || l.repo !== repo) continue;
    const all = overlaps(patterns, l.paths);
    // Shared files are only shared between agents: a person's reservation is never bypassed.
    const blocking = l.kind === PERSON ? all : all.filter((p) => !isSharedClaim(p.mine, policy) && !isSharedClaim(p.theirs, policy));
    if (blocking.length && l.kind === REVIEW && policy?.reviewHoldMode !== 'block') shared.push({ lease: l, pairs: all, reviewWarn: true });
    else if (blocking.length) hits.push({ lease: l, pairs: blocking });
    else if (all.length) shared.push({ lease: l, pairs: all });
  }
  hits.shared = shared;
  return hits;
}

// Tell the other holder too: they learn it on their next heartbeat.
function alertSharers(next, hits, lease) {
  for (const h of hits.shared || []) {
    const other = next.leases[h.lease.id];
    if (!other) continue;
    const msg = h.warnOnly
      ? `${describeHolder(lease)} now also works on ${h.pairs.map((p) => `"${p.mine}"`).join(', ')} for ${lease.issueKey}, overlapping your lease. Coordinate before changing the same lines.`
      : `${describeHolder(lease)} also changes shared ${h.pairs.length === 1 ? 'file' : 'files'} ${h.pairs.map((p) => `"${p.mine}"`).join(', ')} for ${lease.issueKey}: keep your changes to ${h.pairs.length === 1 ? 'it' : 'them'} additive.`;
    next.leases[other.id] = { ...other, alerts: [...(other.alerts || []), msg].slice(-5) };
  }
}

function sharedNotes(hits) {
  return (hits.shared || []).map((h) =>
    h.reviewWarn
      ? `Heads-up: ${h.pairs.map((p) => `"${p.mine}"`).join(', ')} overlaps files in a pull request awaiting review for ${h.lease.issueKey}${h.lease.prUrl ? ` (${h.lease.prUrl})` : ''}. Build on that branch, or expect to resolve a merge conflict.`
      : h.warnOnly
      ? `Warning: ${h.pairs.map((p) => `"${p.mine}"`).join(', ')} overlaps ${h.lease.issueKey} (${describeHolder(h.lease)}). This project warns instead of refusing; coordinate before changing the same lines.`
      : `Shared ${h.pairs.length === 1 ? 'file' : 'files'} ${h.pairs.map((p) => `"${p.mine}"`).join(', ')} also in ${h.lease.issueKey} (${describeHolder(h.lease)}): keep your changes additive so git can merge them.`
  );
}

function protectedHits(patterns, policy) {
  const hits = [];
  for (const mine of patterns) for (const theirs of policy.protectedPaths) if (claimEntersProtected(mine, theirs)) hits.push({ mine, theirs });
  return hits;
}

// Protected patterns that could still fall under a granted claim: the agent is
// told not to touch them.
function excludedFor(patterns, policy) {
  return [...new Set(overlaps(patterns, policy.protectedPaths).map((p) => p.theirs))];
}

function describeHolder(l) {
  if (l.kind === PERSON) return `${l.ownerName || 'a person'} (a person, working by hand)`;
  if (l.kind === REVIEW) return `${l.agent}'s change awaiting review${l.prUrl ? ` (${l.prUrl})` : ''}`;
  return `${l.agent}${l.ownerName ? ` (for ${l.ownerName})` : ''}`;
}

function deny(code, reasons, extra = {}) {
  return { granted: false, code, reasons, ...extra };
}

// Keys of unresolved inward "is blocked by" issue links.
export function openBlockers(issue) {
  return (issue?.blockedBy || []).filter((b) => b && b.key && !b.done).map((b) => b.key);
}

// Decide a claim. `issue` is what Jira says right now about the work item:
// { key, projectKey, summary, labels[], statusCategory: 'new'|'indeterminate'|'done',
//   statusName, assigneeAccountId, assigneeName, blockedBy?: [{ key, done }] }
export function claim(board0, req, ctx) {
  const { now, accountId, ownerName = null, issue, policy: rawPolicy, newId } = ctx;
  const policy = resolvePolicy(rawPolicy);
  const { board, expired } = sweep(board0, now);
  const agent = normalizeAgent(req.agent);
  const repo = normalizeRepo(req.repo || policy.defaultRepo);
  const { patterns, errors } = parsePathList(req.paths);
  const done = (decision) => ({ board, expired, decision });

  if (!agent || agent === PERSON) return done(deny('BAD_REQUEST', ['Name the agent making the claim, for example "claude-code" or "codex".']));
  if (!accountId) return done(deny('BAD_REQUEST', ['No signed-in Atlassian user: an agent must act on behalf of a person.']));
  if (policy.allowedAgents.length && !policy.allowedAgents.some((a) => a.toLowerCase() === String(agent).toLowerCase()))
    return done(
      deny('AGENT_NOT_ALLOWED', [
        `${agent} is not allowed to claim work in this project. Allowed agents: ${policy.allowedAgents.join(', ')}.`,
      ])
    );
  if (errors.length) return done(deny('BAD_PATHS', errors));
  if (!patterns.length)
    return done(deny('BAD_PATHS', ['Declare the files or folders you will change, for example "src/auth/**".']));
  if (patterns.length > policy.maxPathsPerLease)
    return done(deny('TOO_BROAD', [`A lease can name at most ${policy.maxPathsPerLease} paths; this claim named ${patterns.length}.`]));
  if (!policy.allowWholeRepo && patterns.some(isWholeRepo))
    return done(
      deny('TOO_BROAD', ['Claiming the whole repository blocks every other agent. Name the folders you will change.'])
    );

  if (!issue) return done(deny('NOT_FOUND', [`Work item ${req.issueKey} was not found or you cannot see it.`]));
  if (issue.statusCategory === 'done') return done(deny('ISSUE_DONE', [`${issue.key} is already ${issue.statusName || 'done'}.`]));
  if (policy.requireLabel && !(issue.labels || []).includes(policy.agentLabel))
    return done(
      deny('NOT_AGENT_READY', [
        `${issue.key} is not marked safe for agents. A person can add the "${policy.agentLabel}" label to hand it over.`,
      ])
    );
  const blockers = openBlockers(issue);
  if (blockers.length && req.force !== true)
    return done(
      deny('BLOCKED_BY', [
        `${issue.key} is blocked by ${blockers.join(', ')}. Finish ${blockers.length === 1 ? 'that work item' : 'those work items'} first, or pick unblocked work.`,
      ])
    );
  if (
    policy.respectHumanInProgress &&
    issue.statusCategory === 'indeterminate' &&
    issue.assigneeAccountId &&
    issue.assigneeAccountId !== accountId
  )
    return done(
      deny('HUMAN_WORKING', [
        `${issue.assigneeName || 'Someone'} is working on ${issue.key} (${issue.statusName || 'In Progress'}). Agents do not take work a person has in progress.`,
      ])
    );

  let existing = leaseForIssue(board, issue.key, now);
  // The same person's agent comes back to address review comments: the review
  // hold turns back into a working lease.
  if (existing && existing.kind === REVIEW && existing.ownerAccountId === accountId) {
    board.leases = { ...board.leases };
    delete board.leases[existing.id];
    existing = null;
  }
  if (existing) {
    if (existing.agent === agent && existing.ownerAccountId === accountId && !existing.kind) {
      return done({ granted: true, code: 'ALREADY_HELD', lease: existing, reasons: ['You already hold this lease; send heartbeats to keep it.'] });
    }
    return done(
      deny('ISSUE_LEASED', [`${issue.key} is already leased to ${describeHolder(existing)} until ${fmtTime(existing.expiresAt)}.`], {
        retryAfter: existing.expiresAt,
        holder: publicLease(existing),
      })
    );
  }


  const mine = activeLeases(board, now).filter((l) => !l.kind && l.agent === agent && l.ownerAccountId === accountId);
  if (mine.length >= policy.maxActivePerAgent)
    return done(
      deny('AGENT_BUSY', [
        `${agent} already holds ${count(mine.length, 'lease')} (${mine.map((l) => l.issueKey).join(', ')}); the limit is ${policy.maxActivePerAgent}. Release one first.`,
      ])
    );

  const prot = protectedHits(patterns, policy);
  if (prot.length)
    return done(
      deny(
        'PROTECTED_PATH',
        prot.map((p) => `"${p.mine}" touches protected path "${p.theirs}"; a person must make that change.`)
      )
    );

  const hits = collisionsWith(board, { repo, patterns }, now, policy);
  // Warn mode: agent-vs-agent overlaps are allowed with a warning to both sides.
  if (hits.length && policy.collisionMode === 'warn' && hits.every((h) => h.lease.kind !== PERSON)) {
    hits.shared = [...(hits.shared || []), ...hits.splice(0).map((h) => ({ ...h, warnOnly: true }))];
  }
  if (hits.length) {
    const retryAfter = Math.min(...hits.map((h) => h.lease.expiresAt));
    return done(
      deny(
        'PATH_COLLISION',
        hits.map(
          (h) =>
            `${h.lease.issueKey} is leased to ${describeHolder(h.lease)} and covers ${h.pairs
              .map((p) => `"${p.theirs}"`)
              .join(', ')}, which overlaps your ${h.pairs.map((p) => `"${p.mine}"`).join(', ')}.`
        ),
        {
          retryAfter,
          collisions: hits.map((h) => ({ ...publicLease(h.lease), overlaps: h.pairs })),
          suggestions: [
            'Narrow your paths to files the other lease does not cover, or',
            `pick other work (find-work), or retry after ${fmtTime(retryAfter)}.`,
            ...hits.filter((h) => h.lease.kind === REVIEW && h.lease.prUrl).map((h) => `Or build on top of ${h.lease.prUrl} (branch from it) once its author agrees.`),
          ],
        }
      )
    );
  }

  const lease = {
    id: newId,
    issueKey: issue.key,
    projectKey: issue.projectKey,
    summary: (issue.summary || '').slice(0, 200),
    repo,
    paths: patterns,
    excluded: excludedFor(patterns, policy),
    agent,
    ownerAccountId: accountId,
    ownerName,
    intent: String(req.intent || '').slice(0, 500),
    createdAt: now,
    heartbeatAt: now,
    expiresAt: now + ttlMs(req.ttlMinutes, policy),
    notes: [],
    inbox: [],
  };
  const next = clone(board);
  next.leases[lease.id] = lease;
  alertSharers(next, hits, lease);
  if (boardBytes(next) > MAX_BOARD_BYTES)
    return done(deny('SITE_FULL', ['This site has too many active leases for Lease to track safely. Release finished work, or free paths held for merged pull requests.']));
  return { board: next, expired, decision: { granted: true, code: 'GRANTED', lease, reasons: sharedNotes(hits) } };
}

// A person reserves the paths they are changing by hand for a work item, so
// agents working on OTHER work items stay out of those files.
export function reserve(board0, req, ctx) {
  const { now, accountId, ownerName = null, issue, policy: rawPolicy, newId } = ctx;
  const policy = resolvePolicy(rawPolicy);
  const { board, expired } = sweep(board0, now);
  const done = (decision, b = board) => ({ board: b, expired, decision });
  const repo = normalizeRepo(req.repo || policy.defaultRepo);
  const { patterns, errors } = parsePathList(req.paths);
  if (!accountId) return done(deny('BAD_REQUEST', ['Sign in to reserve paths.']));
  if (errors.length) return done(deny('BAD_PATHS', errors));
  if (!patterns.length) return done(deny('BAD_PATHS', ['Name the folders or files you are changing, for example "src/auth".']));
  if (patterns.length > policy.maxPathsPerLease) return done(deny('TOO_BROAD', [`At most ${policy.maxPathsPerLease} paths.`]));
  if (patterns.some(isWholeRepo)) return done(deny('TOO_BROAD', ['Reserving the whole repository blocks every agent. Name the folders you are changing.']));
  if (!issue) return done(deny('NOT_FOUND', ['Work item not found.']));
  if (issue.statusCategory === 'done') return done(deny('ISSUE_DONE', [`${issue.key} is already done.`]));

  const existing = leaseForIssue(board, issue.key, now);
  if (existing && !(existing.kind === PERSON && existing.ownerAccountId === accountId))
    return done(deny('ISSUE_LEASED', [`${describeHolder(existing)} holds ${issue.key}. Take it back first if you want to work on it yourself.`], { holder: publicLease(existing) }));

  const hits = collisionsWith(board, { repo, patterns, excludeId: existing?.id }, now, policy);
  if (hits.length)
    return done(
      deny(
        'PATH_COLLISION',
        hits.map((h) => `${h.lease.issueKey} (${describeHolder(h.lease)}) already covers ${h.pairs.map((p) => `"${p.theirs}"`).join(', ')}.`),
        { collisions: hits.map((h) => ({ ...publicLease(h.lease), overlaps: h.pairs })), retryAfter: Math.min(...hits.map((h) => h.lease.expiresAt)) }
      )
    );

  const hours = Math.min(policy.personReserveHours, Math.max(1, Math.round(+req.hours || policy.personReserveHours)));
  const lease = {
    id: existing?.id || newId,
    kind: PERSON,
    issueKey: issue.key,
    projectKey: issue.projectKey,
    summary: (issue.summary || '').slice(0, 200),
    repo,
    paths: patterns,
    excluded: [],
    agent: PERSON,
    ownerAccountId: accountId,
    ownerName,
    intent: String(req.intent || '').slice(0, 500),
    createdAt: existing?.createdAt || now,
    heartbeatAt: now,
    expiresAt: now + hours * 60 * MIN,
    notes: existing?.notes || [],
  };
  const next = clone(board);
  next.leases[lease.id] = lease;
  alertSharers(next, hits, lease);
  return done({ granted: true, code: existing ? 'RESERVATION_UPDATED' : 'RESERVED', lease, reasons: sharedNotes(hits) }, next);
}

function ownLease(board, leaseId, accountId, now) {
  const l = board.leases[leaseId];
  if (!l || l.expiresAt <= now) return { error: deny('LEASE_GONE', [`Lease ${leaseId} is not active (it expired, was released or was revoked). Claim the work again.`]) };
  if (l.kind === REVIEW)
    return { error: deny('LEASE_GONE', [`You already released ${l.issueKey}; its files stay reserved while the pull request awaits review. Claim it again to address review comments.`]) };
  if (l.ownerAccountId !== accountId)
    return { error: deny('NOT_YOURS', [`Lease ${leaseId} belongs to ${describeHolder(l)}.`]) };
  return { lease: l };
}

// Keep a lease alive, report progress, and optionally widen its paths
// (widening is checked for collisions exactly like a new claim).
export function heartbeat(board0, req, ctx) {
  const { now, accountId, policy: rawPolicy } = ctx;
  const policy = resolvePolicy(rawPolicy);
  const { board, expired } = sweep(board0, now);
  const done = (decision, b = board) => ({ board: b, expired, decision });
  const { lease, error } = ownLease(board, req.leaseId, accountId, now);
  if (error) return done(error);

  let paths = lease.paths;
  if (req.addPaths) {
    const { patterns, errors } = parsePathList(req.addPaths);
    if (errors.length) return done(deny('BAD_PATHS', errors));
    const added = patterns.filter((p) => !paths.includes(p));
    if (added.length) {
      if (paths.length + added.length > policy.maxPathsPerLease)
        return done(deny('TOO_BROAD', [`A lease can name at most ${policy.maxPathsPerLease} paths.`]));
      if (!policy.allowWholeRepo && added.some(isWholeRepo))
        return done(deny('TOO_BROAD', ['Widening to the whole repository is not allowed.']));
      const prot = protectedHits(added, policy);
      if (prot.length)
        return done(deny('PROTECTED_PATH', prot.map((p) => `"${p.mine}" touches protected path "${p.theirs}".`)));
      const hits = collisionsWith(board, { repo: lease.repo, patterns: added, excludeId: lease.id }, now, policy);
      if (hits.length)
        return done(
          deny(
            'PATH_COLLISION',
            hits.map((h) => `${h.lease.issueKey} (${describeHolder(h.lease)}) already covers ${h.pairs.map((p) => `"${p.theirs}"`).join(', ')}.`),
            { collisions: hits.map((h) => ({ ...publicLease(h.lease), overlaps: h.pairs })), retryAfter: Math.min(...hits.map((h) => h.lease.expiresAt)) }
          )
        );
      paths = [...paths, ...added];
    }
  }

  const extendMs =
    lease.kind === PERSON
      ? Math.min(policy.personReserveHours * 60, Math.max(5, +req.extendMinutes || policy.personReserveHours * 60)) * MIN
      : ttlMs(req.extendMinutes, policy);
  const notes = req.note ? [...lease.notes, { at: now, text: String(req.note).slice(0, 500) }].slice(-20) : lease.notes;
  const alerts = lease.alerts || [];
  const inbox0 = lease.inbox || [];
  const undelivered = inbox0.filter((m) => !m.deliveredAt);
  const inbox = undelivered.length ? inbox0.map((m) => (m.deliveredAt ? m : { ...m, deliveredAt: now })) : inbox0;
  const messages = undelivered.map((m) => ({ at: fmtTime(m.at), from: m.from, text: m.text }));
  const updated = { ...lease, paths, excluded: excludedFor(paths, policy), notes, inbox, alerts: [], heartbeatAt: now, expiresAt: Math.max(lease.expiresAt, now + extendMs) };
  const next = clone(board);
  next.leases[lease.id] = updated;
  return done({ granted: true, code: 'RENEWED', lease: updated, reasons: alerts, messages }, next);
}

// A person sends a message to a working agent without taking the lease back.
// Permission is checked by the caller (same rule as revoke).
export function messageAgent(board0, req, ctx) {
  const { now, actorName } = ctx;
  const { board, expired } = sweep(board0, now);
  const l = board.leases[req.leaseId];
  if (!l || l.expiresAt <= now) return { board, expired, decision: deny('LEASE_GONE', ['That lease is no longer active.']) };
  if (l.kind) return { board, expired, decision: deny('BAD_REQUEST', ['Only an active agent lease can receive messages.']) };
  const text = String(req.text ?? '').trim().slice(0, 500);
  if (!text) return { board, expired, decision: deny('BAD_REQUEST', ['Write a message for the agent.']) };
  const msg = { at: now, from: actorName || 'A person', text };
  // Keep every undelivered message; drop the oldest delivered ones first. Refuse once 10 are waiting.
  const waiting = (l.inbox || []).filter((m) => !m.deliveredAt);
  if (waiting.length >= 10) return { board, expired, decision: deny('INBOX_FULL', ['The agent has 10 unread messages. Wait for its next heartbeat, or take the work back.']) };
  const delivered = (l.inbox || []).filter((m) => m.deliveredAt);
  const inbox = [...delivered.slice(-(9 - waiting.length)), ...waiting, msg];
  const updated = { ...l, inbox };
  const next = clone(board);
  next.leases[l.id] = updated;
  return { board: next, expired, decision: { granted: true, code: 'MESSAGED', lease: updated, message: msg } };
}

export const OUTCOMES = ['done', 'handed-back', 'blocked', 'abandoned'];

export function release(board0, req, ctx) {
  const { now, accountId } = ctx;
  const { board, expired } = sweep(board0, now);
  const { lease, error } = ownLease(board, req.leaseId, accountId, now);
  if (error) return { board, expired, decision: error };
  const outcome = OUTCOMES.includes(req.outcome) ? req.outcome : 'done';
  const policy = resolvePolicy(ctx.policy);
  const next = clone(board);
  delete next.leases[lease.id];
  const record = {
    ...lease,
    endedAt: now,
    outcome,
    prUrl: req.prUrl ? String(req.prUrl).slice(0, 500) : null,
    summaryOfWork: String(req.summary || '').slice(0, 2000),
    scopeCheck: req.changedFiles ? checkScope(lease, req.changedFiles, policy) : null,
  };
  if (outcome === 'done' && record.prUrl && policy.holdUntilMerged) {
    // Hold what the pull request changed (or the whole lease if unknown) until
    // the work item is Done. No heartbeats needed; it ends on Done, when a
    // person frees it, or after reviewHoldHours.
    const changed = record.scopeCheck ? parsePathList(req.changedFiles).patterns.filter((f) => lease.paths.some((p) => pathMatches(p, f))) : [];
    const hold = {
      ...lease,
      intent: '',
      notes: [],
      inbox: [],
      excluded: [],
      kind: REVIEW,
      paths: changed.length ? changed.slice(0, 200) : lease.paths,
      prUrl: record.prUrl,
      heartbeatAt: now,
      expiresAt: now + policy.reviewHoldHours * 60 * MIN,
      alerts: [],
    };
    next.leases[lease.id] = hold;
    record.heldForReview = { paths: hold.paths, until: hold.expiresAt };
  }
  return { board: next, expired, decision: { granted: true, code: 'RELEASED', lease: record } };
}

// Did the agent stay inside its lease? Compares the files its change touched
// (e.g. `git diff --name-only main...HEAD`) with the leased paths.
export function checkScope(lease, changedFiles, policy) {
  const files = parsePathList(changedFiles).patterns.slice(0, 2000);
  const forbidden = [...new Set([...(lease.excluded || []), ...(policy?.protectedPaths || [])])];
  const outside = files.filter((f) => !lease.paths.some((p) => pathMatches(p, f)));
  const protectedTouched = files.filter((f) => forbidden.some((p) => pathMatches(p, f)));
  return { checked: files.length, outside: outside.slice(0, 50), protectedTouched: protectedTouched.slice(0, 50), clean: !outside.length && !protectedTouched.length };
}

// A person takes the work back from an agent. Permission is decided by the
// caller (can this person edit the work item?); this only records it.
export function revoke(board0, req, ctx) {
  const { now, accountId, actorName } = ctx;
  const { board, expired } = sweep(board0, now);
  const l = board.leases[req.leaseId];
  if (!l) return { board, expired, decision: deny('LEASE_GONE', ['That lease is no longer active.']) };
  const next = clone(board);
  delete next.leases[l.id];
  return {
    board: next,
    expired,
    decision: {
      granted: true,
      code: 'REVOKED',
      lease: { ...l, endedAt: now, outcome: 'revoked', revokedBy: accountId, revokedByName: actorName || null, reason: String(req.reason || '').slice(0, 300) },
    },
  };
}

// Release every lease on a work item, for example when a person moves it to Done.
export function releaseIssue(board0, issueKey, ctx) {
  const { now, outcome = 'closed-in-jira' } = ctx;
  const { board, expired } = sweep(board0, now);
  const next = clone(board);
  const ended = [];
  for (const l of Object.values(next.leases)) {
    if (l.issueKey === issueKey) {
      ended.push({ ...l, endedAt: now, outcome });
      delete next.leases[l.id];
    }
  }
  return { board: next, expired, ended };
}

export function markHumanOverlap(board, leaseId) {
  const next = clone(board);
  if (next.leases[leaseId]) next.leases[leaseId] = { ...next.leases[leaseId], humanOverlapNotified: true };
  return next;
}

// Who holds anything overlapping these paths right now?
export function whoHolds(board, { paths, repo }, now, rawPolicy) {
  const policy = resolvePolicy(rawPolicy);
  const { patterns, errors } = parsePathList(paths);
  if (errors.length) return { errors, holders: [], shared: [] };
  const hits = collisionsWith(board, { repo: normalizeRepo(repo || policy.defaultRepo), patterns }, now, policy);
  return {
    errors: [],
    holders: hits.map((h) => ({ ...publicLease(h.lease), overlaps: h.pairs })),
    shared: hits.shared.map((h) => ({ ...publicLease(h.lease), overlaps: h.pairs })),
  };
}

export function publicLease(l) {
  return {
    leaseId: l.id,
    kind: l.kind === PERSON ? PERSON : l.kind === REVIEW ? REVIEW : 'agent',
    issueKey: l.issueKey,
    summary: l.summary,
    agent: l.agent,
    owner: l.ownerName || null,
    ownerAccountId: l.ownerAccountId || null,
    prUrl: l.prUrl || null,
    repo: l.repo,
    paths: l.paths,
    mustNotTouch: l.excluded || [],
    intent: l.intent,
    since: fmtTime(l.createdAt),
    lastHeartbeat: fmtTime(l.heartbeatAt),
    expiresAt: fmtTime(l.expiresAt),
    notes: (l.notes || []).slice(-5).map((n) => ({ at: fmtTime(n.at), text: n.text })),
    inbox: (l.inbox || []).map((m) => ({
      at: fmtTime(m.at),
      from: m.from,
      text: m.text,
      deliveredAt: m.deliveredAt ? fmtTime(m.deliveredAt) : null,
    })),
  };
}

export { fmtTime };

// Jira workflow validator ("Lease gate"): may this work item move on (e.g. to Done)?
// `prop` is the work item's `lease` issue property, `labels` its labels.
export const REVIEWED_LABEL = 'lease-reviewed';
export function gate(prop, labels = [], now = Date.now()) {
  if (!prop) return { result: true };
  const reviewed = (labels || []).includes(REVIEWED_LABEL);
  if (prop.held && prop.kind === 'agent' && prop.state === 'held' && Date.parse(prop.expiresAt) > now)
    return {
      result: false,
      errorMessage: `Lease: ${prop.agent}${prop.owner ? ` (for ${prop.owner})` : ''} is still working on this work item. Take it back from the Lease panel, or wait for the agent to hand it off.`,
    };
  const sc = prop.scopeCheck;
  if (sc && sc.clean === false && !reviewed) {
    const what = [
      sc.outside?.length ? `${count(sc.outside.length, 'file')} outside its lease (${sc.outside.slice(0, 3).join(', ')}${sc.outside.length > 3 ? ', ...' : ''})` : '',
      sc.protectedTouched?.length ? `protected ${sc.protectedTouched.length === 1 ? 'path' : 'paths'} ${sc.protectedTouched.slice(0, 3).join(', ')}` : '',
    ].filter(Boolean).join(' and ');
    return {
      result: false,
      errorMessage: `Lease: ${prop.agent}'s change touched ${what}. A person must review it, then add the "${REVIEWED_LABEL}" label to close this work item.`,
    };
  }
  return { result: true };
}
