# Live run with real coding agents (2026-11-22, production app on one-atlas-zupd)

Two real Claude Code sessions (Sonnet 5.5), connected to `https://mcp.atlassian.com/forge/253f3343-f9f7-49af-adf0-e4b3358cc935`
with the person's own OAuth consent, in the demo repository `demo-repo` (origin set to acme/web, never pushed).
The Lease guard (Claude Code hooks + git pre-commit) was installed with `skill/install.sh`.

1. 04:33:57 agent A `claude-code` claim-work APP-1 `src/auth/**, tests/auth/**` → GRANTED (LMWRCDYTZCRUU); heartbeat → RENEWED.
2. Agent A writes `src/http/cors.ts` → **blocked by the PreToolUse hook** ("outside your Lease"); check-paths → clear;
   heartbeat addPaths `src/http/cors.ts` → RENEWED with paths `src/auth/**, tests/auth/**, src/http/cors.ts`; write succeeds.
3. 04:34 agent B `codex` claim-work APP-2 `src/auth/session.ts` → **PATH_COLLISION** ("APP-1 is leased to claude-code (for yu)
   and covers src/auth/**"); follows the suggestion and claims APP-3 `src/billing/**, package.json` → GRANTED (LMWRCEGRH24KU).
4. 04:34:59 a person clicks **Take back from agent** on APP-1 in Jira (reason "Security review first"); panel shows
   "Stopping claude-code". Agent A's next heartbeat → `{"granted":false,"result":"LEASE_GONE","reasons":["yu took APP-1 back at
   2026-11-22T04:34:59Z: \"Security review first\" Stop changing files for APP-1 now and do not push further commits for it."]}`;
   the agent stops.
5. Agent B fixes `src/billing/invoice.ts`, commits (pre-commit guard allows it: inside the lease), release-work done with
   changedFiles → RELEASED, scopeCheck `{"checked":1,"outside":[],"protectedTouched":[],"clean":true}`; Lease comments on APP-3:
   "Agent finished: done. codex held this work item for 1 min ... Scope check: all 1 changed files are inside the lease."
6. Earlier run (02:56): a lease left without heartbeats expired; the agent's next heartbeat returned LEASE_GONE and it stopped
   without re-claiming on its own.

Forge logs: every MCP invocation carried the user in `context.principal`.
