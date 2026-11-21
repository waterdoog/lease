---
name: lease
description: Claim Jira work through Lease before changing code, so parallel AI coding agents and people never edit the same files at once. Use whenever you start, continue or finish a Jira work item in a shared repository.
---

# Lease: claim before you code

Your team runs several coding agents (and people) against the same repository. Lease is
the Jira app that hands out work so nobody overwrites anybody. It is connected to you as
an MCP server named `lease` (tools: `find-work`, `claim-work`, `heartbeat`,
`release-work`, `check-paths`, `lease-status`, `agent-report`).

## The protocol

1. **Pick work.** If you were not given a work item, call `find-work` (with `projectKey`
   if you know it). Only take items listed under `available`.

2. **Claim before the first edit.** Call `claim-work` with:
   - `issueKey`: the work item, e.g. `APP-42`
   - `agent`: your name, e.g. `claude-code` (add `/2`, `/3` if your person runs several of you)
   - `repo`: the repository, e.g. `acme/web` (from `git remote get-url origin`)
   - `paths`: the smallest set of folders or globs you expect to change, comma-separated,
     e.g. `src/auth/**, tests/auth/**`. A path without wildcards covers everything under it.
   - `intent`: one sentence on your plan.

   If `granted` is false, **do not edit anything**. Read `result` and `reasons`:
   - `PATH_COLLISION`: another agent holds overlapping paths. Narrow your paths to files it
     does not cover, choose other work, or wait until `retryAfter`.
   - `HUMAN_WORKING`, `ISSUE_LEASED`: someone else is on it. Choose other work.
   - `PROTECTED_PATH`: a person must make that change. Tell your person.
   - `NOT_AGENT_READY`: the work item is not handed to agents. Tell your person.

3. **Stay inside your lease.** Only change files under `paths`, and never under
   `mustNotTouch`. Before touching anything else, call `check-paths`, then
   `heartbeat` with `addPaths`. If that is refused, stop and tell your person.

4. **Heartbeat at least every 10 minutes** with a one-line `note` on progress. A lease
   expires without heartbeats and the work goes back to the queue.
   If a heartbeat returns `LEASE_GONE`, **stop immediately**: a person took the work
   back or the lease expired. Commit nothing further for that work item.

5. **Release when you stop.** Call `release-work` with `outcome` (`done`, `handed-back`,
   `blocked` or `abandoned`), a short `summary` of what you changed or what a person needs
   to decide, and `prUrl` if you opened a pull request. People read this on the work item.

## Example

```
find-work {projectKey: "APP"}
claim-work {issueKey: "APP-101", agent: "claude-code", repo: "acme/web",
            paths: "src/auth/**, tests/auth/**", intent: "Token-bucket rate limit on /login"}
  -> granted, leaseId L5K2..., expires in 30 min
heartbeat {leaseId: "L5K2...", note: "Middleware done, 6 tests passing"}
release-work {leaseId: "L5K2...", outcome: "done", prUrl: "https://github.com/acme/web/pull/88",
              summary: "Rate limit 5/min per IP on /login, 429 with Retry-After; tests added."}
```
