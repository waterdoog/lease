import React, { useEffect, useState } from 'react';
import { Button, Inline, Label, SectionMessage, Stack, Text, TextArea, Textfield, Toggle } from '@forge/react';
import { invoke } from '@forge/bridge';

export function PolicyEditor({ projectKey: fixed }) {
  const [projectKey, setProjectKey] = useState(fixed || '');
  const [policy, setPolicy] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (fixed) load();
  }, [fixed]);
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
      {fixed ? null : <Inline space="space.100" alignBlock="end">
        <Stack space="space.050">
          <Label labelFor="pk">Project key</Label>
          <Textfield id="pk" value={projectKey} onChange={(e) => setProjectKey(e.target.value.toUpperCase())} placeholder="APP" />
        </Stack>
        <Button onClick={load}>Load policy</Button>
      </Inline>}
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
              <Label labelFor="repo">Default repository</Label>
              <Textfield id="repo" value={policy.defaultRepo || ''} onChange={set('defaultRepo')} placeholder="acme/web" />
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
          <Stack space="space.050">
            <Label labelFor="merged">Statuses that mean "merged" before Done (comma-separated, e.g. In QA, Staging)</Label>
            <Textfield id="merged" value={(policy.mergedStatuses || []).join(', ')} onChange={(e) => setPolicy({ ...policy, mergedStatuses: e.target.value.split(',') })} />
          </Stack>
          <Stack space="space.050">
            <Label labelFor="shared">Shared files: claims on these never block each other (one per line)</Label>
            <TextArea id="shared" value={(policy.sharedPaths || []).join('\n')} onChange={(e) => setPolicy({ ...policy, sharedPaths: e.target.value.split('\n') })} />
          </Stack>
          <Inline space="space.100" alignBlock="center">
            <Toggle id="req" isChecked={policy.requireLabel} onChange={() => setPolicy({ ...policy, requireLabel: !policy.requireLabel })} />
            <Label labelFor="req">Agents may only take work items with the label</Label>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Toggle id="hum" isChecked={policy.respectHumanInProgress} onChange={() => setPolicy({ ...policy, respectHumanInProgress: !policy.respectHumanInProgress })} />
            <Label labelFor="hum">Refuse agents when a person has the work item in progress</Label>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Toggle id="warn" isChecked={policy.collisionMode === 'warn'} onChange={() => setPolicy({ ...policy, collisionMode: policy.collisionMode === 'warn' ? 'block' : 'warn' })} />
            <Label labelFor="warn">Warn instead of refusing when two agents' paths overlap (people, protected paths and work in progress are always enforced)</Label>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Toggle id="hold" isChecked={policy.holdUntilMerged} onChange={() => setPolicy({ ...policy, holdUntilMerged: !policy.holdUntilMerged })} />
            <Label labelFor="hold">Keep a handed-off pull request's files reserved until the work item is Done (at most {policy.reviewHoldHours} hours)</Label>
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

