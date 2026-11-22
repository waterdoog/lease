# Lease privacy policy

Lease is an Atlassian Forge app. It runs entirely on Atlassian's Forge platform and makes no
external calls: no data leaves your Atlassian site.

## What Lease stores

In Forge storage on your site only:

- Active leases: work item key and summary, agent name, the Atlassian account ID and display
  name of the person the agent works for, repository, paths, plan, progress notes, and
  timestamps. Deleted when the lease ends.
- Finished-lease history: the same fields plus outcome, summary and pull request link.
  Deleted automatically after 90 days.
- Events (granted, refused, expired, released): kept 30 days.
- Revocation notices: kept 2 days.
- Per-project policy set by project administrators.
- On each leased work item, an issue property `lease` mirroring the current or last lease.

The optional local guard keeps `.lease/active.json` in your own git checkout. The optional CI
check reads the issue property with credentials you configure in your CI system.

## Who can see it

Every answer is filtered by the asking person's Jira permissions: people (and their agents)
never see the key, summary, plan or pull request of work items they cannot open.

## Removing data

Uninstalling Lease from a site removes its Forge storage for that site. Issue properties named
`lease` can be removed with the Jira REST API.

## Contact

Open an issue at https://github.com/waterdoog/lease/issues.
