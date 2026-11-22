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
  xcss,
} from '@forge/react';
import { invoke, router } from '@forge/bridge';
import { ago, until } from './format';

// Filled in at release time: the MCP endpoint is https://mcp.atlassian.com/forge/<app UUID from manifest.yml>.
const MCP_URL = 'https://mcp.atlassian.com/forge/APP_UUID';
const REPO_URL = 'https://github.com/waterdoog/lease';

const tile = xcss({ padding: 'space.200', borderRadius: 'border.radius.200', backgroundColor: 'color.background.neutral.subtle', minWidth: '150px' });

function Stat({ label, value, tone }) {
  return (
    <Box xcss={tile}>
      <Stack space="space.050">
        <Text>{label}</Text>
        <Heading size="large">{String(value)}</Heading>
        {tone ? <Lozenge appearance={tone.appearance}>{tone.text}</Lozenge> : null}
      </Stack>
    </Box>
  );
}

const issueLink = (key) => (
  <Link href={`/browse/${key}`} openNewTab={false}>
    {key}
  </Link>
);

function LiveTable({ leases, now }) {
  if (!leases.length) return <EmptyState header="No agent holds any work right now" description="When a coding agent claims a work item through the Lease MCP tools, it shows up here." />;
  return (
    <DynamicTable
      head={{
        cells: [
          { key: 'issue', content: 'Work item' },
          { key: 'agent', content: 'Agent' },
          { key: 'paths', content: 'Paths' },
          { key: 'hb', content: 'Last heartbeat' },
          { key: 'exp', content: 'Expires' },
        ],
      }}
      rows={leases.map((l) => {
        const hb = Date.parse(l.lastHeartbeat);
        const stale = now - hb > 10 * 60000;
        return {
          key: l.leaseId,
          cells: [
            { key: 'issue', content: <Stack space="space.0">{issueLink(l.issueKey)}<Text>{l.summary}</Text></Stack> },
            { key: 'agent', content: l.kind === 'person' ? <Stack space="space.0"><Strong>{l.owner}</Strong><Lozenge appearance="new">person, by hand</Lozenge></Stack> : <Stack space="space.0"><Strong>{l.agent}</Strong><Text>{l.owner ? `for ${l.owner}` : ''}</Text></Stack> },
            { key: 'paths', content: <Inline space="space.050" shouldWrap>{l.paths.map((p) => <Code key={p}>{p}</Code>)}</Inline> },
            { key: 'hb', content: <Lozenge appearance={stale ? 'moved' : 'success'}>{ago(hb, now)}</Lozenge> },
            { key: 'exp', content: <Text>{until(Date.parse(l.expiresAt), now)}</Text> },
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
        <SectionMessage appearance="warning" title={`${report.needsAPerson.length} item(s) need a person`}>
          <Stack space="space.050">
            {report.needsAPerson.map((n, i) => (
              <Text key={i}>
                {issueLink(n.issueKey)} — {n.outcome}
                {n.lastNote ? `: ${n.lastNote}` : ''}
              </Text>
            ))}
          </Stack>
        </SectionMessage>
      ) : null}
      <Stack space="space.100">
        <Heading size="small">Finished by agents</Heading>
        {report.finishedWork.length ? (
          <DynamicTable
            head={{ cells: [{ key: 'i', content: 'Work item' }, { key: 'a', content: 'Agent' }, { key: 'o', content: 'Outcome' }, { key: 'w', content: 'What it did' }, { key: 'p', content: 'PR' }] }}
            rows={report.finishedWork.map((f, i) => ({
              key: `f${i}`,
              cells: [
                { key: 'i', content: issueLink(f.issueKey) },
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

function PolicyEditor() {
  const [projectKey, setProjectKey] = useState('');
  const [policy, setPolicy] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = async () => {
    if (!projectKey.trim()) return;
    setMsg(null);
    setPolicy(await invoke('getPolicy', { projectKey: projectKey.trim() }));
  };
  const save = async () => {
    const r = await invoke('savePolicy', { projectKey: projectKey.trim(), policy });
    setMsg(r.ok ? { ok: true, text: 'Saved. New claims follow this policy.' } : { ok: false, text: r.reasons.join(' ') });
    if (r.ok) setPolicy(r.policy);
  };
  const set = (k) => (e) => setPolicy({ ...policy, [k]: e.target.value });
  return (
    <Stack space="space.200">
      <Text>Each project decides what agents may take. Only project administrators can save.</Text>
      <Inline space="space.100" alignBlock="end">
        <Stack space="space.050">
          <Label labelFor="pk">Project key</Label>
          <Textfield id="pk" value={projectKey} onChange={(e) => setProjectKey(e.target.value.toUpperCase())} placeholder="APP" />
        </Stack>
        <Button onClick={load}>Load policy</Button>
      </Inline>
      {policy ? (
        <Stack space="space.150">
          <Inline space="space.200" shouldWrap>
            <Stack space="space.050">
              <Label labelFor="label">Label that marks work safe for agents</Label>
              <Textfield id="label" value={policy.agentLabel} onChange={set('agentLabel')} />
            </Stack>
            <Stack space="space.050">
              <Label labelFor="max">Leases per agent at once</Label>
              <Textfield id="max" type="number" value={String(policy.maxActivePerAgent)} onChange={set('maxActivePerAgent')} />
            </Stack>
            <Stack space="space.050">
              <Label labelFor="ttl">Lease minutes without heartbeat</Label>
              <Textfield id="ttl" type="number" value={String(policy.defaultTtlMinutes)} onChange={set('defaultTtlMinutes')} />
            </Stack>
            <Stack space="space.050">
              <Label labelFor="maxttl">Longest lease (minutes)</Label>
              <Textfield id="maxttl" type="number" value={String(policy.maxTtlMinutes)} onChange={set('maxTtlMinutes')} />
            </Stack>
          </Inline>
          <Stack space="space.050">
            <Label labelFor="prot">Protected paths: only people may change these (one per line)</Label>
            <TextArea id="prot" value={(policy.protectedPaths || []).join('\n')} onChange={(e) => setPolicy({ ...policy, protectedPaths: e.target.value.split('\n') })} />
          </Stack>
          <Inline space="space.100" alignBlock="center">
            <Toggle id="req" isChecked={policy.requireLabel} onChange={() => setPolicy({ ...policy, requireLabel: !policy.requireLabel })} />
            <Label labelFor="req">Agents may only take work items with the label</Label>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Toggle id="hum" isChecked={policy.respectHumanInProgress} onChange={() => setPolicy({ ...policy, respectHumanInProgress: !policy.respectHumanInProgress })} />
            <Label labelFor="hum">Refuse agents when a person has the work item in progress</Label>
          </Inline>
          <Inline>
            <Button appearance="primary" onClick={save}>Save policy</Button>
          </Inline>
          {msg ? <SectionMessage appearance={msg.ok ? 'success' : 'error'}><Text>{msg.text}</Text></SectionMessage> : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

function TryIt() {
  const [form, setForm] = useState({ issueKey: '', agent: 'claude-code', paths: 'src/auth/**', repo: 'acme/web' });
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
        <Code>{`claude mcp add --transport http lease ${MCP_URL}`}</Code>
        <Text>3. Give the agent the protocol, so it claims before it edits: add skill/SKILL.md from the Lease repository to its skills (or paste it into AGENTS.md / CLAUDE.md).</Text>
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
  const load = useCallback(async () => {
    try {
      setData({ ...(await invoke('tower', { hours: 24 })), now: Date.now() });
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <SectionMessage appearance="error" title="Lease could not load">{error}</SectionMessage>;
  if (!data) return <Spinner label="Loading the control tower" />;
  const t = data.report.totals;
  return (
    <Stack space="space.300">
      <Stack space="space.050">
        <Heading size="large">Agent control tower</Heading>
        <Text>Every AI coding agent working in this site claims its Jira work here first. Live, refreshed every 10 seconds.</Text>
      </Stack>
      <Inline space="space.200" shouldWrap>
        <Stat label="Agents at work" value={data.count} />
        <Stat label="Collisions prevented, 24 h" value={t.collisionsPrevented + t.humanWorkProtected} tone={t.collisionsPrevented + t.humanWorkProtected ? { appearance: 'success', text: 'nobody overwrote anybody' } : null} />
        <Stat label="Finished, 24 h" value={t.finished} />
        <Stat label="Needs a person" value={data.report.needsAPerson.length} tone={data.report.needsAPerson.length ? { appearance: 'moved', text: 'see Last 24 hours' } : null} />
      </Inline>
      <Tabs id="tower-tabs">
        <TabList>
          <Tab>Live</Tab>
          <Tab>Last 24 hours</Tab>
          <Tab>Policy</Tab>
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
            <PolicyEditor />
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
