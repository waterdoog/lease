import React, { useEffect, useState, useCallback, useRef } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Code,
  Heading,
  Inline,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  Textfield,
  Toggle,
  Label,
  Link,
  useProductContext,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { ago, until, eventLine } from './format';

const card = xcss({ padding: 'space.150', borderRadius: 'border.radius.200', backgroundColor: 'color.background.neutral.subtle', borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width' });

// Server time, ticking locally once a second between refreshes.
function useClock(serverNow) {
  const skew = useRef(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (serverNow) skew.current = serverNow - Date.now();
  }, [serverNow]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Paths({ lease }) {
  return (
    <Stack space="space.050">
      <Text>
        <Strong>Paths{lease.repo && lease.repo !== 'default' ? ` in ${lease.repo}` : ''}</Strong>
      </Text>
      <Inline space="space.050" shouldWrap>
        {lease.paths.map((p) => (
          <Code key={p}>{p}</Code>
        ))}
      </Inline>
      {lease.mustNotTouch?.length ? (
        <Inline space="space.050" shouldWrap alignBlock="center">
          <Text>Must not touch (people only):</Text>
          {lease.mustNotTouch.map((p) => (
            <Lozenge key={p} appearance="removed">
              {p}
            </Lozenge>
          ))}
        </Inline>
      ) : null}
    </Stack>
  );
}

function LeaseCard({ lease, now, mine, onRevoke, onRelease }) {
  const exp = Date.parse(lease.expiresAt);
  const total = Math.max(1, exp - Date.parse(lease.lastHeartbeat));
  const left = Math.max(0, exp - now);
  const person = lease.kind === 'person';
  const review = lease.kind === 'review';
  if (review)
    return (
      <Box xcss={card}>
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance="moved" isBold>
              Awaiting merge
            </Lozenge>
            <Text>
              <Strong>{lease.agent}</Strong>
              {lease.owner ? ` for ${lease.owner}` : ''} handed off a pull request
            </Text>
          </Inline>
          {lease.prUrl ? <Link href={lease.prUrl} openNewTab>{lease.prUrl}</Link> : null}
          <Text>
            These files stay reserved until this work item is Done (or {until(exp, now)}), so other agents don't build conflicting changes.
          </Text>
          <Paths lease={lease} />
          <Inline>
            <Button onClick={onRevoke}>Free these paths now</Button>
          </Inline>
        </Stack>
      </Box>
    );
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance={person ? 'new' : 'inprogress'} isBold>
            {person ? 'Reserved by a person' : 'Agent at work'}
          </Lozenge>
          <Text>
            <Strong>{person ? lease.owner : lease.agent}</Strong>
            {!person && lease.owner ? ` for ${lease.owner}` : person ? ' is changing these files by hand' : ''}
          </Text>
        </Inline>
        <Text>
          Since {ago(Date.parse(lease.since), now)} · {person ? 'renewed' : 'last heartbeat'} {ago(Date.parse(lease.lastHeartbeat), now)} · ends {until(exp, now)}
        </Text>
        <ProgressBar value={Math.min(1, left / total)} appearance={left < 5 * 60000 ? 'warning' : 'default'} ariaLabel="Time left on the lease" />
        <Paths lease={lease} />
        {lease.intent ? (
          <Text>
            <Strong>Plan: </Strong>
            {lease.intent}
          </Text>
        ) : null}
        {lease.notes?.length ? (
          <Stack space="space.050">
            <Text>
              <Strong>Progress</Strong>
            </Text>
            {[...lease.notes].reverse().map((n, i) => (
              <Text key={i}>
                {ago(Date.parse(n.at), now)} — {n.text}
              </Text>
            ))}
          </Stack>
        ) : null}
        <Inline space="space.100">
          {mine ? (
            <Button onClick={onRelease}>{person ? 'Release my reservation' : 'End my agent’s lease'}</Button>
          ) : null}
          {!person ? (
            <Button appearance="warning" onClick={onRevoke}>
              Take back from agent
            </Button>
          ) : null}
        </Inline>
      </Stack>
    </Box>
  );
}

function ReserveForm({ onReserve, busy, defaultRepo }) {
  const [paths, setPaths] = useState('');
  const [repo, setRepo] = useState(defaultRepo || '');
  return (
    <Stack space="space.075">
      <Text>
        <Strong>Working on this by hand?</Strong> Reserve the folders you are changing, so agents on other work items stay out of them.
      </Text>
      <Inline space="space.100" alignBlock="end" shouldWrap>
        <Stack space="space.050">
          <Label labelFor="rp">Paths</Label>
          <Textfield id="rp" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="src/auth, tests/auth" />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="rr">Repository</Label>
          <Textfield id="rr" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/web" />
        </Stack>
        <Button isDisabled={busy || !paths.trim()} onClick={() => onReserve(paths, repo)}>
          Reserve for 8 hours
        </Button>
      </Inline>
    </Stack>
  );
}

function App() {
  const ctx = useProductContext();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await invoke('issueView'));
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh while someone is looking, so an agent's claim or heartbeat shows up within seconds.
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load();
    }, 8000);
    return () => clearInterval(t);
  }, [load]);

  const now = useClock(data?.now);

  if (error) return <SectionMessage appearance="error" title="Lease could not load">{error}</SectionMessage>;
  if (!data) return <Spinner label="Loading lease" />;

  const { lease, issue, policy, events, stops = [] } = data;
  const ready = !!issue?.labels?.includes(policy.agentLabel);
  const mine = !!lease && !!ctx?.accountId && lease.ownerAccountId === ctx.accountId;

  const act = async (fn) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && r.granted === false) setMessage({ ok: false, text: (r.reasons || []).join(' ') });
      else if (r && r.text) setMessage(r);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = () =>
    act(async () => {
      const r = await invoke('revoke', { leaseId: lease.leaseId, reason });
      setRevokeOpen(false);
      setReason('');
      return r.granted ? { ok: true, text: `Taken back from ${lease.agent}.` } : r;
    });

  const pending = stops.filter((s) => !s.acknowledgedAt);
  const acknowledged = stops.filter((s) => s.acknowledgedAt);

  return (
    <Stack space="space.200">
      {message ? (
        <SectionMessage appearance={message.ok ? 'success' : 'warning'}>
          <Text>{message.text}</Text>
        </SectionMessage>
      ) : null}

      {pending.map((s, i) => (
        <SectionMessage key={`p${i}`} appearance="warning" title={`Stopping ${s.agent}`}>
          <Text>
            {s.by || 'Someone'} took this back {ago(s.at, now)}. The agent has not checked in since, so it may still be editing locally. It is told to stop on its next heartbeat (at most 10 minutes); wait before pulling its branch.
          </Text>
        </SectionMessage>
      ))}
      {acknowledged.slice(0, 1).map((s, i) => (
        <SectionMessage key={`a${i}`} appearance="information">
          <Text>
            {s.agent} was told to stop {ago(s.acknowledgedAt, now)} and has been cut off from this work item.
          </Text>
        </SectionMessage>
      ))}

      {lease ? (
        <LeaseCard
          lease={lease}
          now={now}
          mine={mine}
          onRevoke={() => setRevokeOpen(true)}
          onRelease={() => act(() => invoke('releaseMine', { leaseId: lease.leaseId }).then((r) => (r.granted ? { ok: true, text: 'Released.' } : r)))}
        />
      ) : (
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={ready ? 'success' : 'default'}>{ready ? 'Open to agents' : 'People only'}</Lozenge>
            <Text>Nobody holds this work item in Lease.</Text>
          </Inline>
          {issue?.statusCategory === 'indeterminate' && issue?.assigneeName ? (
            <Text>{issue.assigneeName} has it in progress, so agents are refused for this work item.</Text>
          ) : null}
          <ReserveForm
            busy={busy}
            defaultRepo={policy.defaultRepo}
            onReserve={(paths, repo) =>
              act(() => invoke('reserve', { issueKey: data.issueKey, paths, repo }).then((r) => (r.granted ? { ok: true, text: 'Reserved. Agents on other work items will be refused for these paths.' } : r)))
            }
          />
        </Stack>
      )}

      <Inline space="space.100" alignBlock="center">
        <Toggle id="agent-ready" isChecked={ready} isDisabled={busy} onChange={() => act(() => invoke('setAgentReady', { issueKey: data.issueKey, ready: !ready }))} />
        <Label labelFor="agent-ready">Safe for AI coding agents (label "{policy.agentLabel}")</Label>
      </Inline>

      <Stack space="space.050">
        <Inline space="space.100" alignBlock="center">
          <Heading size="xsmall">Activity, last 7 days</Heading>
          {events.length > 3 ? (
            <Button appearance="subtle" spacing="compact" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show less' : `Show all ${events.length}`}
            </Button>
          ) : null}
        </Inline>
        {events.length ? (
          (showAll ? events : events.slice(0, 3)).map((e, i) => (
            <Inline key={i} space="space.100" alignBlock="start">
              <Lozenge appearance={e.type === 'denied' ? 'removed' : e.type === 'granted' || e.type === 'reserved' ? 'inprogress' : e.type === 'released' ? 'success' : 'moved'}>
                {e.type === 'denied' ? 'refused' : e.type}
              </Lozenge>
              <Text>
                {ago(e.at, now)} — {eventLine(e)}
              </Text>
            </Inline>
          ))
        ) : (
          <Text>No agent has tried to take this work item yet.</Text>
        )}
      </Stack>

      <ModalTransition>
        {revokeOpen ? (
          <Modal onClose={() => setRevokeOpen(false)}>
            <ModalHeader>
              <ModalTitle appearance="warning">{lease?.kind === 'review' ? 'Free the files reserved for this pull request?' : `Take this work item back from ${lease?.agent}?`}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>
                  {lease?.kind === 'review'
                    ? 'Other agents may then change these files while the pull request is still open.'
                    : 'The lease ends now and its paths are free. The agent is told to stop on its next heartbeat; until then it may still be editing on its own machine.'}
                </Text>
                <Label labelFor="reason">Reason (posted on the work item and sent to the agent)</Label>
                <Textfield id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="I'll take this one myself" />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setRevokeOpen(false)}>
                Cancel
              </Button>
              <Button appearance="warning" isDisabled={busy} onClick={doRevoke}>
                Take it back
              </Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
