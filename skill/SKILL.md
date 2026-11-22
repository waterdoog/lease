---
name: lease
description: Claim Jira work through Lease before changing code, so parallel AI coding agents and people never edit the same files at once. Use whenever you start, continue or finish a Jira work item in a shared repository.
---

# Lease: claim before you write

Your team runs several coding agents (and people) against the same repository. Lease is
the Jira app that hands out work so nobody overwrites anybody. It is connected to you as
an MCP server named `lease` (tools: `find-work`, `claim-work`, `heartbeat`,
`release-work`, `check-paths`, `lease-status`, `agent-report`).

If this repository has the Lease guard installed (`.lease/hooks/`), edits and commits
outside your lease are blocked locally. Follow the protocol and you will never hit it.

## The protocol

1. **Pick work.** If you were not given a work item, call `find-work` (with `projectKey`
   if you know it). Only take items listed under `available`.

2. **Explore read-only, then claim before the first write.** Reading is free: find the
   files the change needs first. Then call `claim-work` with:
   - `issueKey`: the work item, e.g. `APP-42`
   - `agent`: your name, e.g. `claude-code` (add `/2`, `/3` if your person runs several of you)
   - `repo`: the repository, e.g. `acme/web` (any form of `git remote get-url origin` works)
   - `paths`: the smallest set of folders or globs you will change, comma-separated,
     e.g. `src/auth/**, tests/auth/**`. A path without wildcards covers everything under it.
   - `intent`: one sentence on your plan.

   If `granted` is false, **do not edit anything**. Read `result` and `reasons`:
   - `PATH_COLLISION`: another agent, a person working by hand, or a pull request awaiting
     merge holds overlapping paths. Narrow your paths to files they do not cover, choose other
     work, or wait until `retryAfter`. If it is a pull request, you may build on its branch.
   - A granted claim can carry `reasons` about shared files (`package.json`, `index.ts`):
     keep your changes to those additive. Heartbeats may bring the same note when another
     agent starts changing a shared file you hold.
   - `HUMAN_WORKING`, `ISSUE_LEASED`: someone else is on it. Choose other work.
   - `PROTECTED_PATH`: a person must make that change. Tell your person.
   - `NOT_AGENT_READY`: the work item is not handed to agents. Tell your person.

   Clients without hooks (Codex, Cursor): after a granted claim, record it so the pre-commit
   guard knows your lease (stdin avoids quoting problems):
   ```bash
   node .lease/hooks/lease-guard.mjs record <<'JSON'
   <the claim-work result, verbatim>
   JSON
   ```

3. **Stay inside your lease.** Only change files under `paths`, and never under
   `mustNotTouch`. If you discover you need another file, call `check-paths`, then
   `heartbeat` with `addPaths`. If that is refused, stop and tell your person.

4. **Heartbeat at every step.** Call `heartbeat` with a one-line `note` when you finish a
   step (plan made, code written, tests run) and at least every 10 minutes of work. A lease
   without heartbeats expires (30 minutes by default) and the work goes back to the queue.
   - If you waited for your person and the lease expired, call `claim-work` again before
     writing anything.
   - If a heartbeat returns `LEASE_GONE`, **stop immediately**: a person took the work
     back (the reason says who and why) or the lease expired. Do not commit or push
     anything further for that work item.

5. **Release when you stop.** Call `release-work` with `outcome` (`done`, `handed-back`,
   `blocked` or `abandoned`), a short `summary` of what you changed or what a person needs
   to decide, `prUrl` if you opened a pull request, and `changedFiles` (from
   `git diff --name-only <base>...HEAD`). Lease posts this on the work item and checks the
   change stayed inside the lease. With `outcome: done` and a `prUrl`, the files you changed
   stay reserved for your pull request until the work item is Done; to address review
   comments later, call `claim-work` on the same work item again.

## Example

```
find-work {projectKey: "APP"}
claim-work {issueKey: "APP-101", agent: "claude-code", repo: "acme/web",
            paths: "src/auth/**, tests/auth/**", intent: "Token-bucket rate limit on /login"}
  -> granted, leaseId L5K2..., mustNotTouch ["**/migrations/**"], expires in 30 min
heartbeat {leaseId: "L5K2...", note: "Middleware done, 6 tests passing"}
release-work {leaseId: "L5K2...", outcome: "done", prUrl: "https://github.com/acme/web/pull/88",
              summary: "Rate limit 5/min per IP on /login, 429 with Retry-After; tests added.",
              changedFiles: "src/auth/rateLimit.ts, src/auth/login.ts, tests/auth/rateLimit.test.ts"}
```

## Install the guard (once per repository)

```bash
sh /path/to/lease/skill/install.sh
```

It copies the guard to `.lease/hooks/`, adds the Claude Code hooks
(`.claude/settings.local.json`), installs this skill, and adds a git pre-commit hook.
People committing by hand can bypass it with `LEASE_GUARD=off git commit ...`.
