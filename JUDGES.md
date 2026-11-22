# Testing Lease (2 minutes without an agent, 10 with one)

**Installation link:** [install Lease in Jira](https://developer.atlassian.com/console/install/253f3343-f9f7-49af-adf0-e4b3358cc935?signature=AYABePqoefu01K3IyZghurxeDgEAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucB0JYRBV%2FWh8n2I2GZOgGLWgAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDOplSAoacgWWbBaCUwIBEIA73hHrbW4GRpgWY%2FJ5S%2BmdYWcMYlE1NTUx0dH1jAJPmkuCFIQRxCk3KjJHCjcHX%2Fv5gD38fFxouqqsp2gAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgE2FTEb9dh0t5H6j6r%2FEksFAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMaVE3wyngK%2FWHgwJGAgEQgDvnaCKYcM3ZZeQFl2U%2FTLaePXiwuNFyT4oZDt62%2BtUKjhREol9YaZgdKJ9RRt77UKoWWygjxhFBnqInqQAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAS%2F8V5FOdE4KEMBTDuguTnwAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAzAFtHTLeCOkFbuYIICARCAO1hhbpKYNpoA0VEd7J49LE8r4ONOwCw8OMcD73jj4Pev5MpIi470Q15i3JIzPoVxqqnYsqOb5ruFgSebAgAAAAAMAAAQAAAAAAAAAAAAAAAAANcKmrsLd497fVeE395uOW7%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLtEwAoMniNIp%2Bg0f6woffhljc5%2BnWB4q65qFun3j7pk59fUGYy5n0lmfSpEVkGgLpNk4cvKWun3mpm%2Fdc3ZBaR65Y%3D&product=jira) (Jira; installs the production version)

You need a Jira Cloud site where you are an administrator, with one software or business
project (we use the key `APP` below).

## 1. Install and add sample work (2 min)

1. Open the installation link, pick your site, accept.
2. In Jira, open **Apps → Lease — agent control tower**, tab **Connect & try**.
3. Under *Sample work items*, enter your project key and click **Add sample work items**.
   Lease creates six work items: five labelled `agent-ok` (safe for agents), one kept for people.

## 2. See the rules without connecting an agent (2 min)

Still on **Connect & try → Would this claim be granted?**:

* Work item: one of the new `agent-ok` items, paths `src/auth/**` → **would be granted**,
  with `**/migrations/**` listed as *must not touch*.
* Paths `db/migrations/0042.sql` → **refused: PROTECTED_PATH**.
* The dark-mode item (no `agent-ok` label) → **refused: NOT_AGENT_READY**.
* Assign one item to a colleague and move it to *In Progress* → claims by anyone else's
  agent are **refused: HUMAN_WORKING** (work you have in progress yourself stays open to your
  own agents).

**Simulate two agents.** Same tab, same project key → **Simulate two agents**. Two simulated
agents working for you go through the real claim code: `sim-claude` claims the rate-limiting item
for `src/auth/**`; `sim-codex` asks for `src/auth/session.ts` on the refresh-token item and is
**refused (PATH_COLLISION)**, then takes the invoice item for `src/billing/**`; a migration is
checked and **refused (PROTECTED_PATH)**; and you reserve `src/http` by hand for an hour, after
which an agent asking for `src/http/cache.ts` is **refused with your name** (a person, working
by hand). Open the **Live** tab and the work items: the leases,
panels and comments are real (they expire in 30 minutes). On the rate-limiting item, click
**Take back from agent**: the lease ends and the panel says the agent was told to stop (with a
real agent, it shows *Stopping…* until the agent's next call; a simulated agent never calls
again, so Lease marks the notice as heard at once).

**Reserve by hand.** Open the dark-mode item (people only), enter `src/auth/ui` under *Working on
this by hand?* and click **Reserve**. A claim on `src/auth/**` by any agent for another item is now
refused with your name (try it in *Would this claim be granted?*).

## 3. Connect a real coding agent (5 min)

1. Atlassian Administration → **Apps → Sites → your site → Connected apps → Lease** →
   turn on the Lease tools for external MCP clients.
2. In a terminal with Claude Code (any MCP client works):
   ```bash
   claude mcp add --transport http lease https://mcp.atlassian.com/forge/253f3343-f9f7-49af-adf0-e4b3358cc935
   ```
   Approve the OAuth screen and pick your site.
3. Ask the agent:
   > Use the lease tools. Find work in project APP and claim the rate-limiting work item for
   > paths src/auth/** in repo acme/web, then send a heartbeat saying "middleware drafted".
4. Open that work item in Jira: the **Lease** panel shows the agent, its paths, the progress
   note and the countdown. The control tower page lists it live.
5. In a second terminal (or a second agent such as Codex), ask it to claim the
   *refresh tokens* work item for `src/auth/session.ts` in the same repo:
   it is **refused with PATH_COLLISION**, naming the first agent, its person and when the
   lease ends. Ask it to claim `src/billing/**` for the invoice item instead: granted.
6. In the Lease panel click **Take back from agent**. Ask the first agent to send another
   heartbeat: it gets **LEASE_GONE** and stops.
7. Ask the second agent to release its work as `done` with a pull request URL and the changed
   files: the outcome, summary, link and a scope check appear as a comment on the work item.
8. Optional, local enforcement: in any git repository run `sh skill/install.sh` from the Lease
   repository. Claude Code's edits outside its lease are now blocked by a hook, and commits
   outside it by a pre-commit hook.

Leases that receive no heartbeat for 30 minutes are reclaimed automatically (the scheduled
sweep runs every 5 minutes) and the work item gets a comment.

## 4. Ask the Rovo agent (1 min)

In Rovo chat choose **Lease Tower** and ask *"What did the agents do in the last 2 hours?"*
or *"What can I safely hand to agents in APP?"*.

## Notes

* Everything runs on Forge. No external calls, no API keys, nothing to configure besides
  enabling the MCP tools for external clients.
* MCP tools act with the connecting person's own Jira permissions.
* Source and tests: https://github.com/waterdoog/lease (`npm test` runs 75 offline tests).
