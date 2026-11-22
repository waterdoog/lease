import React from 'react';
import ForgeReconciler, { Heading, Spinner, Stack, Text, useProductContext } from '@forge/react';
import { PolicyEditor } from './policy-editor';

function App() {
  const ctx = useProductContext();
  const key = ctx?.extension?.project?.key;
  if (!key) return <Spinner label="Loading" />;
  return (
    <Stack space="space.200">
      <Heading size="medium">Lease: AI coding agents in {key}</Heading>
      <Text>Decide which work agents may take in this project, how long a lease lasts, which paths only people may change, and which shared files never block.</Text>
      <PolicyEditor projectKey={key} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
