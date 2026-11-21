// The lease table: pure functions over a board object. No I/O here, so every
// rule can be tested offline and the same code decides for the MCP tools, the
// Rovo agent, the Jira panel and the triggers.
//
// board = { rev: number, leases: { [id]: Lease } }
// Lease = { id, issueKey, projectKey, summary, repo, paths[], agent, ownerAccountId,
//           ownerName, intent, createdAt, heartbeatAt, expiresAt, notes[], humanOverlapNotified? }

import { parsePathList, overlaps, isWholeRepo, claimEntersProtected } from './paths.js';

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
});

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
  return p;
}

export const emptyBoard = () => ({ rev: 0, leases: {} });

const MIN = 60 * 1000;
const clone = (b) => ({ rev: b.rev, leases: { ...b.leases } });
const fmtTime = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

export function normalizeAgent(agent) {
  const a = String(agent ?? '').trim().toLowerCase().replace(/[^a-z0-9._@/-]+/g, '-').replace(/^-+|-+$/g, '');
  return a.slice(0, 60);
}

export function normalizeRepo(repo) {
  const r = String(repo ?? '').trim().toLowerCase().replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '');
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

function collisionsWith(board, { repo, patterns, excludeId }, now) {
  const hits = [];
  for (const l of activeLeases(board, now)) {
    if (l.id === excludeId || l.repo !== repo) continue;
    const pairs = overlaps(patterns, l.paths);
    if (pairs.length) hits.push({ lease: l, pairs });
  }
  return hits;
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
  return `${l.agent}${l.ownerName ? ` (for ${l.ownerName})` : ''}`;
}

function deny(code, reasons, extra = {}) {
  return { granted: false, code, reasons, ...extra };
}

// Decide a claim. `issue` is what Jira says right now about the work item:
// { key, projectKey, summary, labels[], statusCategory: 'new'|'indeterminate'|'done',
//   statusName, assigneeAccountId, assigneeName }
export function claim(board0, req, ctx) {
  const { now, accountId, ownerName = null, issue, policy: rawPolicy, newId } = ctx;
  const policy = resolvePolicy(rawPolicy);
  const { board, expired } = sweep(board0, now);
  const agent = normalizeAgent(req.agent);
  const repo = normalizeRepo(req.repo);
  const { patterns, errors } = parsePathList(req.paths);
  const done = (decision) => ({ board, expired, decision });

  if (!agent) return done(deny('BAD_REQUEST', ['Name the agent making the claim, for example "claude-code" or "codex".']));
  if (!accountId) return done(deny('BAD_REQUEST', ['No signed-in Atlassian user: an agent must act on behalf of a person.']));
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

  const existing = leaseForIssue(board, issue.key, now);
  if (existing) {
    if (existing.agent === agent && existing.ownerAccountId === accountId) {
      return done({ granted: true, code: 'ALREADY_HELD', lease: existing, reasons: ['You already hold this lease; send heartbeats to keep it.'] });
    }
    return done(
      deny('ISSUE_LEASED', [`${issue.key} is already leased to ${describeHolder(existing)} until ${fmtTime(existing.expiresAt)}.`], {
        retryAfter: existing.expiresAt,
        holder: publicLease(existing),
      })
    );
  }

  const mine = activeLeases(board, now).filter((l) => l.agent === agent && l.ownerAccountId === accountId);
  if (mine.length >= policy.maxActivePerAgent)
    return done(
      deny('AGENT_BUSY', [
        `${agent} already holds ${mine.length} lease(s) (${mine.map((l) => l.issueKey).join(', ')}); the limit is ${policy.maxActivePerAgent}. Release one first.`,
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

  const hits = collisionsWith(board, { repo, patterns }, now);
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
  };
  const next = clone(board);
  next.leases[lease.id] = lease;
  return { board: next, expired, decision: { granted: true, code: 'GRANTED', lease } };
}

function ownLease(board, leaseId, accountId, now) {
  const l = board.leases[leaseId];
  if (!l || l.expiresAt <= now) return { error: deny('LEASE_GONE', [`Lease ${leaseId} is not active (it expired, was released or was revoked). Claim the work again.`]) };
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
      const hits = collisionsWith(board, { repo: lease.repo, patterns: added, excludeId: lease.id }, now);
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

  const extendMs = ttlMs(req.extendMinutes, policy);
  const notes = req.note ? [...lease.notes, { at: now, text: String(req.note).slice(0, 500) }].slice(-20) : lease.notes;
  const updated = { ...lease, paths, excluded: excludedFor(paths, policy), notes, heartbeatAt: now, expiresAt: Math.max(lease.expiresAt, now + extendMs) };
  const next = clone(board);
  next.leases[lease.id] = updated;
  return done({ granted: true, code: 'RENEWED', lease: updated }, next);
}

export const OUTCOMES = ['done', 'handed-back', 'blocked', 'abandoned'];

export function release(board0, req, ctx) {
  const { now, accountId } = ctx;
  const { board, expired } = sweep(board0, now);
  const { lease, error } = ownLease(board, req.leaseId, accountId, now);
  if (error) return { board, expired, decision: error };
  const outcome = OUTCOMES.includes(req.outcome) ? req.outcome : 'done';
  const next = clone(board);
  delete next.leases[lease.id];
  const record = {
    ...lease,
    endedAt: now,
    outcome,
    prUrl: req.prUrl ? String(req.prUrl).slice(0, 500) : null,
    summaryOfWork: String(req.summary || '').slice(0, 2000),
  };
  return { board: next, expired, decision: { granted: true, code: 'RELEASED', lease: record } };
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
export function whoHolds(board, { paths, repo }, now) {
  const { patterns, errors } = parsePathList(paths);
  if (errors.length) return { errors, holders: [] };
  const hits = collisionsWith(board, { repo: normalizeRepo(repo), patterns }, now);
  return { errors: [], holders: hits.map((h) => ({ ...publicLease(h.lease), overlaps: h.pairs })) };
}

export function publicLease(l) {
  return {
    leaseId: l.id,
    issueKey: l.issueKey,
    summary: l.summary,
    agent: l.agent,
    owner: l.ownerName || null,
    repo: l.repo,
    paths: l.paths,
    mustNotTouch: l.excluded || [],
    intent: l.intent,
    since: fmtTime(l.createdAt),
    lastHeartbeat: fmtTime(l.heartbeatAt),
    expiresAt: fmtTime(l.expiresAt),
    notes: (l.notes || []).slice(-5).map((n) => ({ at: fmtTime(n.at), text: n.text })),
  };
}

export { fmtTime };
