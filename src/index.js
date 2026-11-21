// Forge entry points: Rovo actions (also exposed as MCP tools), UI resolvers
// and triggers. They only translate inputs; the logic lives in service.js.
import Resolver from '@forge/resolver';
import * as svc from './service.js';

function accountOf(payload, context) {
  // Never trust an accountId the model typed into an input: read it from context.
  return context?.accountId || context?.principal?.accountId || payload?.context?.accountId || null;
}

function issueKeyFrom(payload) {
  return payload.issueKey || payload?.context?.jira?.issueKey || null;
}

const wrap = (fn) => async (payload = {}, context = {}) => {
  try {
    return await fn(payload, { accountId: accountOf(payload, context) });
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.message };
  }
};

// ---- Rovo actions / MCP tools --------------------------------------------
export const findWork = wrap((p) => svc.findWork({ projectKey: p.projectKey || p?.context?.jira?.projectKey, limit: p.limit }));

export const claimWork = wrap((p, who) =>
  svc.claimWork(
    { issueKey: issueKeyFrom(p), agent: p.agent, paths: p.paths, intent: p.intent, ttlMinutes: p.ttlMinutes, repo: p.repo },
    who
  )
);

export const heartbeat = wrap((p, who) =>
  svc.heartbeatLease({ leaseId: p.leaseId, note: p.note, extendMinutes: p.extendMinutes, addPaths: p.addPaths }, who)
);

export const releaseWork = wrap((p, who) =>
  svc.releaseLease({ leaseId: p.leaseId, outcome: p.outcome, prUrl: p.prUrl, summary: p.summary }, who)
);

export const checkPaths = wrap((p) => svc.checkPaths({ paths: p.paths, repo: p.repo }));

export const leaseStatus = wrap((p) => svc.status({ issueKey: issueKeyFrom(p), projectKey: p.projectKey }));

export const agentReport = wrap((p) => svc.report({ hours: p.hours, projectKey: p.projectKey || p?.context?.jira?.projectKey }));

// ---- UI resolvers ----------------------------------------------------------
const resolver = new Resolver();

resolver.define('issueView', async ({ context }) => {
  const issueKey = context.extension?.issue?.key;
  const [st, policy, issue] = await Promise.all([
    svc.status({ issueKey }),
    svc.getPolicy(issueKey.split('-')[0]),
    svc.issueFacts(issueKey),
  ]);
  const events = (await svc.store.listPrefix('evt:', { since: Date.now() - 7 * 864e5, limit: 300 }))
    .filter((e) => e.issueKey === issueKey)
    .slice(0, 12);
  return { issueKey, issue, lease: st.activeLeases[0] || null, policy, events, now: Date.now() };
});

resolver.define('revoke', async ({ payload, context }) => svc.revokeLease({ leaseId: payload.leaseId, reason: payload.reason }, { accountId: context.accountId }));

resolver.define('setAgentReady', async ({ payload, context }) => {
  const issueKey = payload.issueKey || context.extension?.issue?.key;
  return svc.markAgentReady(issueKey, !!payload.ready);
});

resolver.define('tower', async ({ payload }) => {
  const [st, rep] = await Promise.all([svc.status({ projectKey: payload?.projectKey }), svc.report({ hours: payload?.hours || 24, projectKey: payload?.projectKey })]);
  return { ...st, report: rep };
});

resolver.define('dryRun', async ({ payload, context }) =>
  svc.dryRunClaim({ issueKey: payload.issueKey, agent: payload.agent, paths: payload.paths, repo: payload.repo }, { accountId: context.accountId })
);
resolver.define('createSampleWork', async ({ payload }) => svc.createSampleWork(payload.projectKey));

resolver.define('getPolicy', async ({ payload }) => svc.getPolicy(payload.projectKey));
resolver.define('savePolicy', async ({ payload }) => svc.savePolicy(payload.projectKey, payload.policy));

export const resolverHandler = resolver.getDefinitions();

// ---- Triggers --------------------------------------------------------------
export async function sweep() {
  const n = await svc.sweepExpired();
  console.log(`sweep: ${n} expired lease(s) returned to the queue`);
}

export async function onIssueUpdated(event) {
  const key = event?.issue?.key;
  if (!key) return;
  const r = await svc.onIssueChanged(key);
  console.log(`issue ${key}: ${r}`);
}
