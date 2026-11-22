// Forge entry points: Rovo actions (also exposed as MCP tools), UI resolvers
// and triggers. They only translate inputs; the logic lives in service.js.
import Resolver from '@forge/resolver';
import { getAppContext } from '@forge/api';
import * as svc from './service.js';

function accountOf(payload, context) {
  // Never trust an accountId the model typed into an input: read it from context.
  return context?.accountId || context?.principal?.accountId || payload?.context?.accountId || null;
}

function issueKeyFrom(payload) {
  return payload.issueKey || payload?.context?.jira?.issueKey || null;
}

const wrap = (fn) => async (payload = {}, context = {}) => {
  // Shape only, never values: which identity fields does this invocation carry?
  console.log(`action context: keys=${Object.keys(context || {}).join(',')} accountId=${!!context?.accountId} principal=${!!context?.principal?.accountId} payloadContext=${!!payload?.context}`);
  try {
    return await svc.visibleOnly(await fn(payload, { accountId: accountOf(payload, context) }));
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.message };
  }
};

// ---- Rovo actions / MCP tools --------------------------------------------
export const findWork = wrap((p) => svc.findWork({ projectKey: p.projectKey || p?.context?.jira?.projectKey, limit: p.limit }));

export const claimWork = wrap((p, who) =>
  svc.claimWork(
    { issueKey: issueKeyFrom(p), agent: p.agent, paths: p.paths, intent: p.intent, ttlMinutes: p.ttlMinutes, repo: p.repo, force: p.force },
    who
  )
);

export const heartbeat = wrap((p, who) =>
  svc.heartbeatLease({ leaseId: p.leaseId, note: p.note, extendMinutes: p.extendMinutes, addPaths: p.addPaths }, who)
);

export const releaseWork = wrap((p, who) =>
  svc.releaseLease({ leaseId: p.leaseId, outcome: p.outcome, prUrl: p.prUrl, summary: p.summary, changedFiles: p.changedFiles }, who)
);

export const checkPaths = wrap((p) => svc.checkPaths({ paths: p.paths, repo: p.repo }));

// Rovo attaches the work item the person is looking at as context; only narrow
// to it when the question names no project (a project-wide question must not
// silently become a question about the open work item).
export const leaseStatus = wrap((p) => svc.status(p.issueKey || p.projectKey ? { issueKey: p.issueKey, projectKey: p.projectKey } : { issueKey: p?.context?.jira?.issueKey }));

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
  const stops = await svc.pendingStops(issueKey);
  return { issueKey, issue, lease: st.activeLeases[0] || null, policy, events, stops, now: Date.now() };
});

resolver.define('revoke', async ({ payload, context }) => svc.revokeLease({ leaseId: payload.leaseId, reason: payload.reason }, { accountId: context.accountId }));

resolver.define('messageAgent', async ({ payload, context }) =>
  svc.messageAgentLease({ leaseId: payload.leaseId, text: payload.text }, { accountId: context.accountId })
);

resolver.define('setAgentReady', async ({ payload, context }) => {
  const issueKey = payload.issueKey || context.extension?.issue?.key;
  return svc.markAgentReady(issueKey, !!payload.ready);
});

resolver.define('tower', async ({ payload }) => {
  const [st, rep] = await Promise.all([svc.status({ projectKey: payload?.projectKey }), svc.report({ hours: payload?.hours || 24, projectKey: payload?.projectKey })]);
  return svc.visibleOnly({ ...st, report: rep });
});

resolver.define('dryRun', async ({ payload, context }) =>
  svc.visibleOnly(await svc.dryRunClaim({ issueKey: payload.issueKey, agent: payload.agent, paths: payload.paths, repo: payload.repo, force: payload.force }, { accountId: context.accountId }))
);
resolver.define('createSampleWork', async ({ payload }) => svc.createSampleWork(payload.projectKey));

resolver.define('reserve', async ({ payload, context }) =>
  svc.reservePaths({ issueKey: payload.issueKey || context.extension?.issue?.key, paths: payload.paths, repo: payload.repo, hours: payload.hours }, { accountId: context.accountId })
);
resolver.define('releaseMine', async ({ payload, context }) => svc.releaseLease({ leaseId: payload.leaseId, outcome: 'handed-back', summary: 'Released by hand.' }, { accountId: context.accountId }));
resolver.define('simulate', async ({ payload, context }) => svc.simulateAgents(payload.projectKey, { accountId: context.accountId }));

resolver.define('appInfo', async () => {
  let appId = null;
  try {
    appId = getAppContext().appAri.appId;
  } catch (e) {
    console.warn(`app context: ${e.message}`);
  }
  return { appId, mcpUrl: appId ? `https://mcp.atlassian.com/forge/${appId}` : null };
});

resolver.define('getPolicy', async ({ payload }) => svc.getPolicy(payload.projectKey));
resolver.define('savePolicy', async ({ payload }) => svc.savePolicy(payload.projectKey, payload.policy));

export const resolverHandler = resolver.getDefinitions();

// ---- Workflow validator ("Lease gate") -------------------------------------
export async function leaseGate(args) {
  try {
    const key = args?.issue?.key;
    if (!key) return { result: true };
    return await svc.leaseGate(key);
  } catch (e) {
    console.error(e);
    return { result: true }; // never lock a workflow because Lease had an error
  }
}

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
