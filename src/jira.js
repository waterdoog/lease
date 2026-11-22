// Thin Jira REST layer. Reads run as the person (asUser) so an agent only
// ever sees work its person can see; comments are written as the app so the
// work item history says clearly that Lease wrote them.
import api, { route } from '@forge/api';

const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
export const isIssueKey = (k) => ISSUE_KEY.test(String(k || '').trim().toUpperCase());
export const cleanKey = (k) => String(k || '').trim().toUpperCase();

async function json(res, what) {
  if (res.ok) return res.status === 204 ? null : res.json();
  const body = await res.text().catch(() => '');
  const err = new Error(`${what} failed: ${res.status} ${body.slice(0, 200)}`);
  err.status = res.status;
  throw err;
}

const asUser = () => api.asUser();
const asApp = () => api.asApp();

export function toIssueFacts(raw) {
  if (!raw) return null;
  const f = raw.fields || {};
  return {
    key: raw.key,
    id: raw.id,
    projectKey: f.project?.key || raw.key.split('-')[0],
    summary: f.summary || '',
    labels: f.labels || [],
    statusName: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.key || 'new',
    assigneeAccountId: f.assignee?.accountId || null,
    assigneeName: f.assignee?.displayName || null,
  };
}

const FIELDS = 'summary,labels,status,assignee,project';

export async function getIssue(issueKey, { as = 'user' } = {}) {
  const who = as === 'app' ? asApp() : asUser();
  const res = await who.requestJira(route`/rest/api/3/issue/${cleanKey(issueKey)}?fields=${FIELDS}`);
  if (res.status === 404 || res.status === 403) return null;
  return toIssueFacts(await json(res, 'Reading the work item'));
}

export async function searchIssues(jql, { max = 50, as = 'user' } = {}) {
  const who = as === 'app' ? asApp() : asUser();
  const res = await who.requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jql, maxResults: max, fields: FIELDS.split(',') }),
  });
  const data = await json(res, 'Searching Jira');
  return (data.issues || []).map(toIssueFacts);
}

export async function myself() {
  const res = await asUser().requestJira(route`/rest/api/3/myself`);
  const d = await json(res, 'Reading the current user');
  return { accountId: d.accountId, displayName: d.displayName };
}

export async function canEditIssue(issueKey) {
  const res = await asUser().requestJira(
    route`/rest/api/3/mypermissions?issueKey=${cleanKey(issueKey)}&permissions=EDIT_ISSUES`
  );
  if (!res.ok) return false;
  const d = await res.json();
  return !!d?.permissions?.EDIT_ISSUES?.havePermission;
}

// Project administrators, and Jira administrators (who can administer every project).
export async function isProjectAdmin(projectKey) {
  const res = await asUser().requestJira(
    route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS,ADMINISTER`
  );
  if (!res.ok) return false;
  const d = await res.json();
  return !!(d?.permissions?.ADMINISTER_PROJECTS?.havePermission || d?.permissions?.ADMINISTER?.havePermission);
}

export async function addLabel(issueKey, label) {
  const res = await asUser().requestJira(route`/rest/api/3/issue/${cleanKey(issueKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update: { labels: [{ add: label }] } }),
  });
  await json(res, 'Adding the label');
}

export async function removeLabel(issueKey, label) {
  const res = await asUser().requestJira(route`/rest/api/3/issue/${cleanKey(issueKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update: { labels: [{ remove: label }] } }),
  });
  await json(res, 'Removing the label');
}

// Minimal Atlassian Document Format builder for comments.
export function adf(paragraphs) {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: (Array.isArray(p) ? p : [p]).filter(Boolean).map((part) =>
        typeof part === 'string'
          ? { type: 'text', text: part }
          : part.link
            ? { type: 'text', text: part.text, marks: [{ type: 'link', attrs: { href: part.link } }] }
            : { type: 'text', text: part.text, marks: part.strong ? [{ type: 'strong' }] : [] }
      ),
    })),
  };
}

export async function comment(issueKey, paragraphs) {
  const res = await asApp().requestJira(route`/rest/api/3/issue/${cleanKey(issueKey)}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body: adf(paragraphs) }),
  });
  await json(res, 'Commenting on the work item');
}

// Mirror the lease onto the work item so JQL can find agent-held work:
//   issue.property[lease].held = true
export async function setLeaseProperty(issueKey, value) {
  const key = cleanKey(issueKey);
  const res = value
    ? await asApp().requestJira(route`/rest/api/3/issue/${key}/properties/lease`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      })
    : await asApp().requestJira(route`/rest/api/3/issue/${key}/properties/lease`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) await json(res, 'Updating the lease property');
}

export async function createIssue(projectKey, { summary, description, labels }) {
  const typesRes = await asUser().requestJira(route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`);
  const types = await json(typesRes, 'Reading work types');
  const list = types.issueTypes || types.values || [];
  const type = list.find((t) => !t.subtask && /task/i.test(t.name)) || list.find((t) => !t.subtask);
  if (!type) throw new Error(`No work type available in ${projectKey}`);
  const res = await asUser().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      fields: { project: { key: projectKey }, issuetype: { id: type.id }, summary, labels, description: adf([description]) },
    }),
  });
  return (await json(res, 'Creating the work item')).key;
}

// Which of these work items can the current person see? (bulkfetch reports
// the ones they cannot as errors instead of failing.)
export async function visibleKeys(keys) {
  const unique = [...new Set(keys.map(cleanKey))].filter(isIssueKey);
  const seen = new Set();
  for (let i = 0; i < unique.length; i += 100) {
    const res = await asUser().requestJira(route`/rest/api/3/issue/bulkfetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ issueIdsOrKeys: unique.slice(i, i + 100), fields: ['summary'] }),
    });
    const d = await json(res, 'Checking visibility');
    for (const it of d.issues || []) seen.add(it.key);
  }
  return seen;
}
