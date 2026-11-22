// Fake @forge/api backed by an in-memory Jira, for the end-to-end simulation.
export const jiraState = (globalThis.__jira ||= { issues: {}, comments: {}, props: {}, users: {}, currentUser: null, admins: new Set(), calls: [] });

export function route(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (i < vals.length ? encodeURIComponent(vals[i]).replace(/%2F/g, '/').replace(/%3D/g, '=').replace(/%26/g, '&') : ''), '');
}

const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body ?? '') });

function raw(issue) {
  const u = issue.assignee ? jiraState.users[issue.assignee] : null;
  return {
    key: issue.key,
    id: issue.key,
    fields: {
      summary: issue.summary,
      labels: issue.labels,
      status: { name: issue.status, statusCategory: { key: issue.cat } },
      assignee: u ? { accountId: issue.assignee, displayName: u } : null,
      project: { key: issue.key.split('-')[0] },
    },
  };
}

function handle(who, path, opts = {}) {
  jiraState.calls.push(`${who} ${opts.method || 'GET'} ${path.split('?')[0]}`);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  let m;
  if (path === '/rest/api/3/myself') {
    const id = jiraState.currentUser;
    return res(200, { accountId: id, displayName: jiraState.users[id] });
  }
  if (path === '/rest/api/3/issue/bulkfetch') {
    const hidden = jiraState.hiddenFrom?.[jiraState.currentUser] || new Set();
    const keys = body.issueIdsOrKeys;
    return res(200, {
      issues: keys.filter((k) => jiraState.issues[k] && !(who === 'user' && hidden.has(k))).map((k) => ({ key: k, fields: { summary: jiraState.issues[k].summary } })),
      issueErrors: keys.filter((k) => !jiraState.issues[k] || (who === 'user' && hidden.has(k))).map((k) => ({ issueIdOrKey: k })),
    });
  }
  if ((m = path.match(/^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes/))) {
    return res(200, { issueTypes: [{ id: '10001', name: 'Sub-task', subtask: true }, { id: '10002', name: 'Task', subtask: false }] });
  }
  if (path === '/rest/api/3/issue' && method === 'POST') {
    const pk = body.fields.project.key;
    const n = Object.keys(jiraState.issues).filter((k) => k.startsWith(pk + '-')).length + 900;
    const key = `${pk}-${n}`;
    jiraState.issues[key] = { key, summary: body.fields.summary, labels: body.fields.labels, status: 'To Do', cat: 'new', assignee: null, type: body.fields.issuetype.id };
    return res(201, { key });
  }
  if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)\/comment$/))) {
    (jiraState.comments[m[1]] ||= []).push({ who, text: JSON.stringify(body.body) });
    return res(201, {});
  }
  if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)\/properties\/lease$/))) {
    if (method === 'DELETE') delete jiraState.props[m[1]];
    else jiraState.props[m[1]] = body;
    return res(204, null);
  }
  if ((m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)/))) {
    const issue = jiraState.issues[m[1]];
    if (!issue) return res(404, {});
    if (method === 'PUT') {
      for (const op of body.update.labels) {
        if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add);
        if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove);
      }
      return res(204, null);
    }
    return res(200, raw(issue));
  }
  if (path === '/rest/api/3/search/jql') {
    const label = (body.jql.match(/labels = "([^"]+)"/) || [])[1];
    const proj = (body.jql.match(/project = "([^"]+)"/) || [])[1];
    const out = Object.values(jiraState.issues).filter((i) => i.cat !== 'done' && (!label || i.labels.includes(label)) && (!proj || i.key.startsWith(proj + '-')));
    return res(200, { issues: out.map(raw) });
  }
  if (path.startsWith('/rest/api/3/mypermissions')) {
    const me = jiraState.currentUser;
    return res(200, { permissions: { EDIT_ISSUES: { havePermission: true }, ADMINISTER_PROJECTS: { havePermission: jiraState.admins.has(me) }, ADMINISTER: { havePermission: (jiraState.jiraAdmins || new Set()).has(me) } } });
  }
  return res(404, { path });
}

const client = (who) => ({ requestJira: async (path, opts) => handle(who, path, opts) });
export default { asUser: () => client('user'), asApp: () => client('app') };

export const getAppContext = () => ({ appAri: { appId: '11111111-2222-3333-4444-555555555555' }, appVersion: '1.0.0' });
