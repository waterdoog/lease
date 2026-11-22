#!/usr/bin/env node
// Lease PR check: fail a pull request that changes files outside the Lease of
// its Jira work item. Works for cloud agents that have no local hooks.
//
// Env:
//   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN   (read access to the work item)
//   ISSUE_KEY        optional; otherwise taken from PR_TITLE / HEAD_REF (e.g. "APP-42 Fix ...")
//   PR_TITLE, HEAD_REF, BASE_REF (default origin/main)
//   CHANGED_FILES    optional newline/comma list instead of `git diff`
//   REPOSITORY       e.g. "acme/web" (GITHUB_REPOSITORY / BITBUCKET_REPO_FULL_NAME work too)
//   LEASE_REQUIRED=1 fail when the work item has no Lease at all (default: warn)
//   LEASE_PROPERTY_FILE  read the lease from a JSON file instead of Jira (offline/testing)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathMatches, parsePathList } from '../hooks/lease-paths.mjs';

const env = process.env;
const out = [];
const say = (line) => {
  out.push(line);
  console.log(line);
};
const finish = (code) => {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Lease scope check\n\n${out.join('\n\n')}\n`);
  process.exit(code);
};

const normalizeRepo = (r) =>
  String(r || '').trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\//, '').replace(/^[^@/\s]+@[^:/\s]+:/, '') || 'default';

const key = (env.ISSUE_KEY || `${env.PR_TITLE || ''} ${env.HEAD_REF || env.GITHUB_HEAD_REF || env.BITBUCKET_BRANCH || ''}`.match(/\b[A-Z][A-Z0-9_]{0,19}-\d+\b/)?.[0] || '').trim();
if (!key) {
  say('No Jira work item key found in the pull request title or branch name; nothing to check.');
  finish(env.LEASE_REQUIRED === '1' ? 1 : 0);
}

async function readLease() {
  if (env.LEASE_PROPERTY_FILE) {
    try {
      return JSON.parse(fs.readFileSync(env.LEASE_PROPERTY_FILE, 'utf8'));
    } catch {
      return null;
    }
  }
  const base = String(env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) throw new Error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN (as CI secrets).');
  const res = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/properties/lease`, {
    headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Jira answered ${res.status} for ${key}`);
  return (await res.json()).value;
}

const changed = env.CHANGED_FILES
  ? parsePathList(env.CHANGED_FILES).patterns
  : execFileSync('git', ['diff', '--name-only', `${env.BASE_REF || 'origin/main'}...HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);

const lease = await readLease().catch((e) => {
  say(`Could not read the Lease for ${key}: ${e.message}`);
  finish(1);
});
if (!lease) {
  say(`${key} has no Lease. ${env.LEASE_REQUIRED === '1' ? 'This repository requires agents to claim work in Lease first.' : 'Skipping (set LEASE_REQUIRED=1 to enforce).'}`);
  finish(env.LEASE_REQUIRED === '1' ? 1 : 0);
}

const repo = normalizeRepo(env.REPOSITORY || env.GITHUB_REPOSITORY || env.BITBUCKET_REPO_FULL_NAME);
if (lease.repo && lease.repo !== 'default' && repo !== 'default' && lease.repo !== repo) {
  say(`${key}'s Lease is for ${lease.repo}, not ${repo}; nothing to check here.`);
  finish(0);
}
if (lease.state === 'revoked') {
  say(`**${key} was taken back from ${lease.agent}** (${lease.endedAt}). A person must decide whether this pull request continues.`);
  finish(1);
}

const outside = changed.filter((f) => !(lease.paths || []).some((p) => pathMatches(p, f)));
const banned = changed.filter((f) => (lease.mustNotTouch || []).some((p) => pathMatches(p, f)));
say(`${key}: ${lease.kind === 'person' ? lease.owner : lease.agent} leased ${(lease.paths || []).join(', ')}${lease.state !== 'held' ? ` (lease ${lease.state})` : ''}. ${changed.length} changed ${changed.length === 1 ? "file" : "files"}.`);
if (outside.length) say(`Outside the lease:\n${outside.slice(0, 50).map((f) => `- ${f}`).join('\n')}`);
if (banned.length) say(`In paths only people may change:\n${banned.slice(0, 50).map((f) => `- ${f}`).join('\n')}`);
if (!outside.length && !banned.length) say('All changed files are inside the lease.');
finish(outside.length || banned.length ? 1 : 0);
