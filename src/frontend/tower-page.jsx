import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Code,
  DynamicTable,
  EmptyState,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  Textfield,
  Toggle,
  User,
  xcss,
} from '@forge/react';
import { invoke, router } from '@forge/bridge';
import { ago, until } from './format';
import { PolicyEditor } from './policy-editor';

const REPO_URL = 'https://github.com/waterdoog/lease';

const tile = xcss({
  paddingBlock: 'space.150',
  paddingInline: 'space.200',
  borderRadius: 'border.radius.200',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderColor: 'color.border',
  backgroundColor: 'elevation.surface',
  minWidth: '150px',
});

function Stat({ label, value, warn }) {
  return (
    <Box xcss={tile}>
      <Stack space="space.050">
        <Text size="small" color="color.text.subtle">{label}</Text>
        <Inline space="space.100" alignBlock="center">
          <Heading size="large">{String(value)}</Heading>
          {warn && value ? <Lozenge appearance="moved">needs a look</Lozenge> : null}
        </Inline>
      </Stack>
    </Box>
  );
}

const issueLink = (key) => key === '(hidden)' ? <Text color="color.text.subtle">a work item you cannot see</Text> : <Link href={`/browse/${key}`}>{key}</Link>;

const workItem = (key, summary) => (
  <Stack space="space.025">
    {issueLink(key)}
    {summary ? <Text size="small" color="color.text.subtle" maxLines={1}>{summary}</Text> : null}
  </Stack>
);

const forPerson = (l) => l.ownerAccountId ? <User accountId={l.ownerAccountId} /> : <Text>{l.owner || ''}</Text>;

function LiveTable({ leases, now }) {
  if (!leases.length) return <EmptyState header="No agent holds any work right now" description="When a coding agent claims a work item through the Lease MCP tools, it shows up here." />;
  return (
    <DynamicTable
      head={{
        cells: [
          { key: 'issue', content: 'Work item' },
          { key: 'agent', content: 'Agent' },
          { key: 'who', content: 'Working for' },
          { key: 'paths', content: 'Files' },
          { key: 'hb', content: 'Status' },
          { key: 'exp', content: 'Last heartbeat' },
        ],
      }}
      rows={leases.map((l) => {
        const hb = Date.parse(l.lastHeartbeat);
        const stale = now - hb > 10 * 60000;
        return {
          key: l.leaseId,
          cells: [
            { key: 'issue', content: workItem(l.issueKey, l.summary) },
            { key: 'agent', content: l.kind === 'person' ? <Lozenge appearance="new">by hand</Lozenge> : <Inline space="space.075" alignBlock="center"><Strong>{l.agent}</Strong>{l.kind === 'review' ? <Lozenge appearance="moved">awaiting merge</Lozenge> : null}</Inline> },
            { key: 'who', content: forPerson(l) },
            { key: 'paths', content: <Inline space="space.050" shouldWrap>{l.paths.map((p) => <Code key={p}>{p}</Code>)}</Inline> },
            { key: 'hb', content: l.kind === 'person' ? <Lozenge>reserved</Lozenge> : l.kind === 'review' ? <Lozenge appearance="moved">in review</Lozenge> : <Lozenge appearance={stale ? 'moved' : 'success'}>{stale ? 'silent' : 'active'}</Lozenge> },
            { key: 'exp', content: <Text size="small" color="color.text.subtle">{ago(hb, now)} · ends {until(Date.parse(l.expiresAt), now)}</Text> },
          ],
        };
      })}
    />
  );
}

function ReportView({ report }) {
  const t = report.totals;
  return (
    <Stack space="space.300">
      {report.needsAPerson.length ? (
        <SectionMessage appearance="warning" title={report.needsAPerson.length === 1 ? 'One work item needs a person' : `${report.needsAPerson.length} work items need a person`}>
          <Text>An agent stopped on these without finishing. Pick them up or hand them to another agent.</Text>
        </SectionMessage>
      ) : null}
      {report.needsAPerson.length ? (
        <DynamicTable
          head={{ cells: [{ key: 'i', content: 'Work item' }, { key: 'a', content: 'Agent' }, { key: 'o', content: 'What happened' }, { key: 'n', content: 'Last note' }] }}
          rows={report.needsAPerson.map((n) => ({
            key: n.issueKey,
            cells: [
              { key: 'i', content: workItem(n.issueKey, n.summary) },
              { key: 'a', content: <Text>{n.agent || '—'}</Text> },
              { key: 'o', content: <Lozenge appearance={n.outcome === 'expired' ? 'moved' : 'removed'}>{n.outcome === 'expired' ? 'went silent' : n.outcome}</Lozenge> },
              { key: 'n', content: <Text size="small" color="color.text.subtle">{n.lastNote || '—'}</Text> },
            ],
          }))}
        />
      ) : null}
      <Stack space="space.100">
        <Heading size="small">Finished by agents</Heading>
        {report.awaitingMerge.length ? <Text>Awaiting merge: {report.awaitingMerge.map((l) => l.issueKey).join(', ')}. The next agent that touches their files is pointed at the pull request.</Text> : null}
        {report.finishedWork.length ? (
          <DynamicTable
            head={{ cells: [{ key: 'i', content: 'Work item' }, { key: 'a', content: 'Agent' }, { key: 'o', content: 'Outcome' }, { key: 'w', content: 'What it did' }, { key: 'p', content: 'PR' }] }}
            rows={report.finishedWork.map((f, i) => ({
              key: `f${i}`,
              cells: [
                { key: 'i', content: workItem(f.issueKey, f.summary) },
                { key: 'a', content: <Text>{f.agent} · {f.minutes} min</Text> },
                { key: 'o', content: <Lozenge appearance={f.outcome === 'done' ? 'success' : f.outcome === 'revoked' ? 'removed' : 'moved'}>{f.outcome}</Lozenge> },
                { key: 'w', content: <Text>{f.whatItDid || '—'}</Text> },
                { key: 'p', content: f.pr ? <Link href={f.pr} openNewTab>pull request</Link> : <Text>—</Text> },
              ],
            }))}
          />
        ) : (
          <Text>No agent finished work in this window.</Text>
        )}
      </Stack>
      <Stack space="space.100">
        <Heading size="small">Refused claims</Heading>
        <Text>
          {t.collisionsPrevented} collisions with other agents, {t.humanWorkProtected} times a person was already on it, {t.protectedPathsBlocked} protected paths.
        </Text>
        {report.recentDenials.map((d, i) => (
          <Text key={i}>
            {d.agent} on {issueLink(d.issueKey)}: {d.why}
          </Text>
        ))}
      </Stack>
    </Stack>
  );
}

function TryIt() {
  const [form, setForm] = useState({ issueKey: '', agent: 'claude-code', paths: 'src/auth/**', repo: 'acme/web' });
  const [mcpUrl, setMcpUrl] = useState(null);
  useEffect(() => {
    invoke('appInfo').then((i) => setMcpUrl(i.mcpUrl)).catch(() => null);
  }, []);
  const [result, setResult] = useState(null);
  const [sampleKey, setSampleKey] = useState('');
  const [sample, setSample] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const run = async () => setResult(await invoke('dryRun', form));
  const seed = async () => setSample(await invoke('createSampleWork', { projectKey: sampleKey }));
  const [sim, setSim] = useState(null);
  const simulate = async () => setSim(await invoke('simulate', { projectKey: sampleKey }));
  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading size="small">Connect a coding agent</Heading>
        <Text>Lease's tools are served by Atlassian's MCP server, so any MCP client can use them with its person's own Jira permissions.</Text>
        <Text>1. A site admin turns the Lease tools on: Atlassian Administration → Apps → Sites → this site → Connected apps → Lease.</Text>
        <Text>2. Add the server to the agent. In Claude Code:</Text>
        <Code>{`claude mcp add --transport http lease ${mcpUrl || 'https://mcp.atlassian.com/forge/<app id>'}`}</Code>
        <Text>3. In each repository, install the guard: it adds the skill, Claude Code hooks and a pre-commit hook, so edits and commits outside the lease are blocked.</Text>
        <Code>sh lease/skill/install.sh</Code>
        <Text>4. For cloud agents, add the pull request check (skill/ci) to GitHub Actions or Bitbucket Pipelines: it fails pull requests that change files outside their lease.</Text>
        <Inline>
          <Button onClick={() => router.open(REPO_URL)}>Open the Lease repository</Button>
        </Inline>
      </Stack>
      <Stack space="space.100">
        <Heading size="small">Would this claim be granted?</Heading>
        <Text>Checks a claim against live leases and the project policy without taking anything.</Text>
        <Inline space="space.100" shouldWrap alignBlock="end">
          <Stack space="space.050"><Label labelFor="dk">Work item</Label><Textfield id="dk" value={form.issueKey} onChange={set('issueKey')} placeholder="APP-12" /></Stack>
          <Stack space="space.050"><Label labelFor="da">Agent</Label><Textfield id="da" value={form.agent} onChange={set('agent')} /></Stack>
          <Stack space="space.050"><Label labelFor="dp">Paths</Label><Textfield id="dp" value={form.paths} onChange={set('paths')} /></Stack>
          <Stack space="space.050"><Label labelFor="dr">Repository</Label><Textfield id="dr" value={form.repo} onChange={set('repo')} /></Stack>
          <Button appearance="primary" onClick={run}>Check</Button>
        </Inline>
        {result ? (
          <SectionMessage appearance={result.granted ? 'success' : 'warning'} title={result.granted ? 'Would be granted' : `Would be refused: ${result.result}`}>
            <Stack space="space.050">
              {(result.reasons || []).map((r, i) => <Text key={i}>{r}</Text>)}
              {result.granted && result.lease?.mustNotTouch?.length ? <Text>Must not touch: {result.lease.mustNotTouch.join(', ')}</Text> : null}
              {result.retryAfter ? <Text>Free again at {result.retryAfter} unless renewed.</Text> : null}
            </Stack>
          </SectionMessage>
        ) : null}
      </Stack>
      <Stack space="space.100">
        <Heading size="small">Sample work items</Heading>
        <Text>Adds six realistic work items (five marked safe for agents, one kept for people) so you can try Lease on a fresh site. Project administrators only.</Text>
        <Inline space="space.100" alignBlock="end">
          <Stack space="space.050"><Label labelFor="sk">Project key</Label><Textfield id="sk" value={sampleKey} onChange={(e) => setSampleKey(e.target.value.toUpperCase())} placeholder="APP" /></Stack>
          <Button onClick={seed}>Add sample work items</Button>
        </Inline>
        {sample ? <SectionMessage appearance={sample.ok ? 'success' : 'error'}><Text>{sample.ok ? `Created ${sample.created.join(', ')}.` : sample.reasons.join(' ')}</Text></SectionMessage> : null}
      </Stack>
      <Stack space="space.100">
        <Heading size="small">No agent connected yet? Simulate two</Heading>
        <Text>Runs two simulated agents (sim-claude and sim-codex, working for you) through the real claim and heartbeat code on the project above: one claims src/auth, the other collides and moves to billing work, and a migration is checked. Their leases are real, expire in 30 minutes, and show up in the Live tab and on the work items.</Text>
        <Inline>
          <Button onClick={simulate}>Simulate two agents</Button>
        </Inline>
        {sim ? (
          sim.ok ? (
            <DynamicTable
              head={{ cells: [{ key: 'w', content: 'Agent' }, { key: 'd', content: 'Does' }, { key: 'r', content: 'Lease answers' }] }}
              rows={sim.steps.map((s, i) => ({
                key: `s${i}`,
                cells: [
                  { key: 'w', content: <Strong>{s.who}</Strong> },
                  { key: 'd', content: <Text>{s.what}</Text> },
                  { key: 'r', content: <Stack space="space.050"><Lozenge appearance={s.granted ? 'success' : 'removed'}>{s.granted ? 'granted' : s.result}</Lozenge><Text>{s.says}</Text></Stack> },
                ],
              }))}
            />
          ) : (
            <SectionMessage appearance="warning"><Text>{sim.reasons.join(' ')}</Text></SectionMessage>
          )
        ) : null}
      </Stack>
    </Stack>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [project, setProject] = useState('');
  const load = useCallback(async () => {
    try {
      setData({ ...(await invoke('tower', { hours: 24, projectKey: project.trim() || undefined })), now: Date.now() });
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, [project]);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load();
    }, 8000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <SectionMessage appearance="error" title="Lease could not load">{error}</SectionMessage>;
  if (!data) return <Spinner label="Loading the control tower" />;
  const t = data.report.totals;
  return (
    <Stack space="space.300">
      <Inline spread="space-between" alignBlock="end" shouldWrap space="space.200">
        <Text color="color.text.subtle">Every AI coding agent on this site claims its work item and files here before it writes code.</Text>
        <Box xcss={xcss({ width: '220px' })}>
          <Textfield id="pf" aria-label="Filter by project" value={project} onChange={(e) => setProject(e.target.value.toUpperCase())} placeholder="Filter by project key" />
        </Box>
      </Inline>
      <Inline space="space.200" shouldWrap>
        <Stat label="Agents at work" value={data.count} />
        {data.report.awaitingMerge.length ? <Stat label="Awaiting merge" value={data.report.awaitingMerge.length} /> : null}
        <Stat label="Collisions prevented · 24 h" value={t.collisionsPrevented + t.humanWorkProtected} />
        <Stat label="Finished · 24 h" value={t.finished} />
        <Stat label="Needs a person" value={data.report.needsAPerson.length} warn />
      </Inline>
      <Tabs id="tower-tabs">
        <TabList>
          <Tab>Live</Tab>
          <Tab>Last 24 hours</Tab>
          <Tab>Policies</Tab>
          <Tab>Connect & try</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.200', width: '100%' })}>
            <LiveTable leases={data.activeLeases} now={data.now} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.200', width: '100%' })}>
            <ReportView report={data.report} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.200', width: '100%' })}>
            <PolicyEditor projectKey={project.trim()} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.200', width: '100%' })}>
            <TryIt />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
