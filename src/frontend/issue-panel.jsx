import React, { useEffect, useState, useCallback } from 'react';
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
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { ago, until, eventLine } from './format';

const card = xcss({ padding: 'space.150', borderRadius: 'border.radius.200', backgroundColor: 'color.background.neutral.subtle', borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width' });

function LeaseCard({ lease, now, onRevoke }) {
  const exp = Date.parse(lease.expiresAt);
  const since = Date.parse(lease.since);
  const total = Math.max(1, exp - Date.parse(lease.lastHeartbeat));
  const left = Math.max(0, exp - now);
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance="inprogress" isBold>Agent at work</Lozenge>
          <Text>
            <Strong>{lease.agent}</Strong>
            {lease.owner ? ` for ${lease.owner}` : ''}
          </Text>
        </Inline>
        <Text>
          Since {ago(since, now)} · last heartbeat {ago(Date.parse(lease.lastHeartbeat), now)} · expires {until(exp, now)}
        </Text>
        <ProgressBar value={Math.min(1, left / total)} appearance={left < 5 * 60000 ? 'warning' : 'default'} ariaLabel="Time left on the lease" />
        <Stack space="space.050">
          <Text>
            <Strong>Paths{lease.repo && lease.repo !== 'default' ? ` in ${lease.repo}` : ''}</Strong>
          </Text>
          <Inline space="space.050" shouldWrap>
            {lease.paths.map((p) => (
              <Code key={p}>{p}</Code>
            ))}
          </Inline>
        </Stack>
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
        <Inline>
          <Button appearance="warning" onClick={onRevoke}>
            Take back from agent
          </Button>
        </Inline>
      </Stack>
    </Box>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState(null);

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
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <SectionMessage appearance="error" title="Lease could not load">{error}</SectionMessage>;
  if (!data) return <Spinner label="Loading lease" />;

  const { lease, issue, policy, events, now } = data;
  const ready = !!issue?.labels?.includes(policy.agentLabel);

  const toggleReady = async () => {
    setBusy(true);
    try {
      await invoke('setAgentReady', { issueKey: data.issueKey, ready: !ready });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async () => {
    setBusy(true);
    try {
      const r = await invoke('revoke', { leaseId: lease.leaseId, reason });
      setMessage(r.granted ? { ok: true, text: `Taken back from ${lease.agent}. It will be told on its next heartbeat.` } : { ok: false, text: r.reasons?.join(' ') || 'Could not take it back.' });
      setRevokeOpen(false);
      setReason('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack space="space.200">
      {message ? (
        <SectionMessage appearance={message.ok ? 'success' : 'warning'}>
          <Text>{message.text}</Text>
        </SectionMessage>
      ) : null}

      {lease ? (
        <LeaseCard lease={lease} now={now} onRevoke={() => setRevokeOpen(true)} />
      ) : (
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={ready ? 'success' : 'default'}>{ready ? 'Open to agents' : 'People only'}</Lozenge>
            <Text>No agent holds this work item.</Text>
          </Inline>
          {issue?.statusCategory === 'indeterminate' && issue?.assigneeName ? (
            <Text>
              {issue.assigneeName} has it in progress, so agents will be refused while that is true.
            </Text>
          ) : null}
        </Stack>
      )}

      <Inline space="space.100" alignBlock="center">
        <Toggle id="agent-ready" isChecked={ready} isDisabled={busy} onChange={toggleReady} />
        <Label labelFor="agent-ready">
          Safe for AI coding agents (label "{policy.agentLabel}")
        </Label>
      </Inline>

      <Stack space="space.050">
        <Heading size="xsmall">Agent activity, last 7 days</Heading>
        {events.length ? (
          events.map((e, i) => (
            <Inline key={i} space="space.100" alignBlock="start">
              <Lozenge appearance={e.type === 'denied' ? 'removed' : e.type === 'granted' ? 'inprogress' : e.type === 'released' ? 'success' : 'moved'}>
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
              <ModalTitle appearance="warning">Take this work item back from {lease?.agent}?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>The lease ends now. The agent is told on its next heartbeat and must stop changing these paths.</Text>
                <Label labelFor="reason">Reason (posted on the work item)</Label>
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
