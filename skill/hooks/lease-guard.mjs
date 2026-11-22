#!/usr/bin/env node
// Lease guard: local enforcement for the Lease protocol. No network, no tokens.
//
//   post       Claude Code PostToolUse hook for mcp__lease__* tools: remembers
//              granted leases in .lease/active.json and forgets ended ones.
//   pre        Claude Code PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit:
//              blocks edits to files no active lease covers (exit 2 = blocked).
//   precommit  git pre-commit hook: refuses commits that touch files outside
//              the active leases. Works for Codex, Cursor and people.
//   record     For clients without hooks: pipe the claim-work result JSON on stdin.
//   status     Print the active leases this checkout knows about.
//
// Set LEASE_GUARD=off to bypass (e.g. a person committing by hand).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathMatches } from './lease-paths.mjs';

const mode = process.argv[2];
const root = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
})();
const stateFile = path.join(root, '.lease', 'active.json');

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { leases: {} };
  }
};
const save = (st) => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
};
const readStdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

// Find Lease's JSON answer inside whatever shape the client wraps it in.
function findResult(x, depth = 0) {
  if (x == null || depth > 6) return null;
  if (typeof x === 'string') {
    const t = x.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return findResult(JSON.parse(t), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (Array.isArray(x)) {
    for (const v of x) {
      const r = findResult(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof x === 'object') {
    if ('granted' in x && ('result' in x || 'lease' in x)) return x;
    for (const v of Object.values(x)) {
      const r = findResult(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function remember(result, leaseIdHint) {
  const st = load();
  const l = result?.lease;
  if (result?.granted && l?.leaseId && !['RELEASED', 'REVOKED'].includes(result.result) && l.kind !== 'person') {
    st.leases[l.leaseId] = { leaseId: l.leaseId, issueKey: l.issueKey, repo: l.repo, paths: l.paths, mustNotTouch: l.mustNotTouch || [], expiresAt: l.expiresAt };
  } else if (result?.granted && l?.leaseId) {
    delete st.leases[l.leaseId];
  } else if (result?.result === 'LEASE_GONE' && leaseIdHint) {
    delete st.leases[leaseIdHint];
  }
  save(st);
  return st;
}

function active(now = Date.now()) {
  return Object.values(load().leases).filter((l) => Date.parse(l.expiresAt) > now);
}

// Resolve symlinks (macOS /var -> /private/var) even for files not created yet.
function real(p) {
  let cur = p;
  const rest = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
    rest.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  try {
    return path.join(fs.realpathSync(cur), ...rest);
  } catch {
    return p;
  }
}

function relative(file) {
  const abs = real(path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd(), file));
  const rel = path.relative(real(root), abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside the repository
  return rel;
}

// null = allowed; otherwise the reason it is not.
function verdict(rel) {
  if (rel === null || rel.startsWith('.lease/') || rel.startsWith('.git/')) return null;
  const leases = active();
  const expired = Object.values(load().leases).filter((l) => Date.parse(l.expiresAt) <= Date.now());
  const cover = leases.find((l) => l.paths.some((p) => pathMatches(p, rel)));
  if (!cover) {
    if (expired.some((l) => l.paths.some((p) => pathMatches(p, rel))))
      return `Your Lease on this path has expired. Call claim-work again before changing ${rel}.`;
    return leases.length
      ? `${rel} is outside your Lease (${leases.map((l) => `${l.issueKey}: ${l.paths.join(', ')}`).join('; ')}). Call check-paths, then heartbeat with addPaths "${rel}" before editing it.`
      : `No Lease covers ${rel}. Claim the Jira work item with claim-work (naming the paths you will change) before editing.`;
  }
  const banned = cover.mustNotTouch.find((p) => pathMatches(p, rel));
  if (banned) return `${rel} is under "${banned}", which only people may change. Tell your person instead.`;
  return null;
}

const off = String(process.env.LEASE_GUARD || '').toLowerCase() === 'off';

if (mode === 'post') {
  const ev = JSON.parse(readStdin() || '{}');
  if (/mcp__lease__/.test(ev.tool_name || '')) remember(findResult(ev.tool_response), ev.tool_input?.leaseId);
  process.exit(0);
} else if (mode === 'record') {
  const st = remember(findResult(process.argv[3] || readStdin()), process.argv[4]);
  console.log(`Lease guard: ${Object.keys(st.leases).length} active lease(s) recorded.`);
} else if (mode === 'pre') {
  if (off) process.exit(0);
  const ev = JSON.parse(readStdin() || '{}');
  const file = ev.tool_input?.file_path || ev.tool_input?.notebook_path || ev.tool_input?.path;
  if (!file) process.exit(0);
  const why = verdict(relative(file));
  if (why) {
    process.stderr.write(`Lease guard blocked this edit. ${why}\n`);
    process.exit(2);
  }
  process.exit(0);
} else if (mode === 'precommit') {
  if (off) process.exit(0);
  // People committing by hand are not blocked unless this checkout holds a lease
  // or the commit comes from an agent session.
  const agentSession = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_HOME', 'CURSOR_TRACE_ID', 'CURSOR_AGENT', 'LEASE_AGENT'].some((k) => process.env[k]);
  if (!agentSession && !Object.keys(load().leases).length) process.exit(0);
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const problems = staged.map((f) => [f, verdict(f)]).filter(([, w]) => w);
  if (problems.length) {
    console.error('Lease guard: this commit changes files outside your active Lease:');
    for (const [f, w] of problems.slice(0, 20)) console.error(`  ${f}: ${w}`);
    console.error('Claim or widen the lease first, or commit with LEASE_GUARD=off if a person is committing by hand.');
    process.exit(1);
  }
  process.exit(0);
} else if (mode === 'status') {
  const now = Date.now();
  for (const l of Object.values(load().leases))
    console.log(`${l.issueKey}  ${l.leaseId}  ${Date.parse(l.expiresAt) > now ? `until ${l.expiresAt}` : 'EXPIRED'}  ${l.paths.join(', ')}`);
} else {
  console.error('usage: lease-guard.mjs post|pre|precommit|record|status');
  process.exit(64);
}
