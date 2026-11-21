# Lease — air-traffic control for AI coding agents in Jira

Teams now run several coding agents at once: Claude Code on one laptop, Codex in the
cloud, Cursor on another. They all read the same Jira backlog and push to the same
repository, and nothing stops two of them from rewriting the same files, or an agent from
picking up a ticket a person started this morning.

**Lease** is an Atlassian Forge app that makes every agent *claim* its Jira work item
before it writes code, and name the files it will change. A claim is refused when it would
collide with another agent, a person who already has the work in progress, or a path only
people may change. Claims expire unless the agent keeps sending heartbeats, so a crashed
agent never blocks the backlog. People see who holds what, take work back with one click,
and get a morning report of what the agents did.

```
 Claude Code ─┐                       ┌─ Jira issue panel: who holds this, paths, progress, take back
 Codex ───────┼─ Atlassian MCP ─ Lease ┼─ Control tower page: live leases, refusals, policy
 Cursor ──────┘   (rovo:mcp)     (Forge)└─ Rovo agent "Lease Tower": "what did agents do overnight?"
```

## What it does

| | |
|---|---|
| **Claim before code** | `claim-work` grants a lease on a work item for named paths (`src/auth/**, tests/auth`). |
| **No collisions** | Two claims collide when any file could match both path patterns. The check is exact for globs (`*`, `?`, `**`, folder prefixes) and scoped per repository. |
| **People first** | Agents only get work a person marked safe (label `agent-ok`), never work a person has *In Progress*, and never protected paths (`**/migrations/**`, `infra/**`, CI workflows by default). Folder claims are granted with the protected parts listed as `mustNotTouch`. |
| **Leases expire** | 30 minutes without a heartbeat (configurable) and the work returns to the queue, with a comment on the work item and the agent's last progress note. A scheduled trigger sweeps every 5 minutes; every read also ignores expired leases. |
| **Take it back** | Anyone who can edit the work item can revoke a lease from the Jira panel. The agent learns on its next heartbeat (`LEASE_GONE`) and stops. |
| **Jira stays the truth** | Moving a work item to Done ends its lease. A person starting leased work is flagged on the work item, once. The lease is mirrored to an issue property, so JQL works: `issue.property[lease].held = true`. |
| **Hand-off** | `release-work` posts the outcome, a summary and the pull request on the work item, and asks a person to review. |
| **Morning report** | `agent-report` and the Lease Tower Rovo agent: finished work with PRs, what needs a person (blocked, handed back, expired), collisions prevented. |
| **Per-project policy** | Project admins set the label, leases per agent, lease length, protected paths and whether in-progress human work is off limits. |

## How it is built

* **Forge, nothing else.** No external services, no API keys, no egress.
* **`rovo:mcp`** exposes 7 actions as MCP tools (`find-work`, `claim-work`, `heartbeat`,
  `release-work`, `check-paths`, `lease-status`, `agent-report`) at
  `https://mcp.atlassian.com/forge/<app id>`. Any MCP client connects with OAuth and acts
  with **its person's own Jira permissions** (all reads run `asUser`).
* **`rovo:agent`** "Lease Tower" for the people supervising agents (read-only actions).
* **UI Kit**: `jira:issuePanel` and `jira:globalPage` (live table, 24 h report, policy editor,
  "would this claim be granted?" checker, sample work items for a fresh site).
* **Triggers**: `scheduledTrigger` (every 5 minutes) reclaims silent leases;
  `avi:jira:updated:issue` keeps leases in step with Jira.
* **Linearizable lease table.** All active leases live in one Custom Entity record with a
  revision number. Each change reads it (strictly consistent), decides with pure functions
  (`src/core/leases.js`), and commits with a conditional transaction on the revision; if
  another agent committed first, it re-reads and decides again. The first write uses
  `FAIL_IF_EXISTS`. Two agents can never both be granted overlapping paths.
* **Skill for agents**: [`skill/SKILL.md`](skill/SKILL.md) teaches any coding agent the
  protocol (claim, stay inside, heartbeat, stop on `LEASE_GONE`, release with PR).

## Tests

```bash
npm install
npm test          # 36 tests, offline
```

* `test/paths.test.js`: glob overlap, including a brute-force oracle over 600 random pattern pairs.
* `test/leases.test.js`: every policy rule, expiry, heartbeats, revoke, and **12 agents racing
  for the same paths through the real store code: exactly one wins**; 6 racing on disjoint paths: all win, no lost update.
* `test/e2e.test.js`: the deployed entry points (`src/index.js`) against an in-memory Jira and
  KVS: two people's agents collide, a person's in-progress work and a migration are protected,
  an agent goes silent and its work is reclaimed, a person takes work back, a PR is handed off,
  the report adds up, closing in Jira ends a lease.

Mutation check: removing the revision condition, the collision check, the human-in-progress
rule, expiry, glob matching or the owner check each turns tests red.

## Install and try

See [JUDGES.md](JUDGES.md) for the installation link and a 10-minute walkthrough.

```bash
# developers
npm install -g @forge/cli
forge register && forge deploy && forge install --product jira
```

Connect an agent (after a site admin enables the Lease tools under Atlassian Administration →
Apps → Sites → *site* → Connected apps):

```bash
claude mcp add --transport http lease https://mcp.atlassian.com/forge/<app id>
```

Then add [`skill/SKILL.md`](skill/SKILL.md) to the agent's skills.

## Privacy

Lease stores, in Forge storage on your site: active leases (work item key and summary, agent
name, the person's account ID and display name, paths, plan, progress notes), finished-lease
history for 90 days and events for 30 days. It makes no external calls.

## License

MIT
