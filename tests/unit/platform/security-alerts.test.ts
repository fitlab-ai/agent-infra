import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearProviderSessions } from '../../../lib/platform/provider-loader.ts';
import { dismissSecurityAlert, readSecurityAlert } from '../../../lib/platform/security-alerts.ts';

function fixtureRoot(config: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-alert-runtime-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    platform: { type: 'fixture', providers: { fixture: { source: path.resolve('tests/fixtures/platform-providers/security-metadata-provider.mjs'), config } } }
  }));
  return root;
}

test('security runtime reads provider data and closes an open alert', async () => {
  const root = fixtureRoot({ state: 'open' });
  try {
    clearProviderSessions();
    const read = await readSecurityAlert({ kind: 'dependabot', number: 7 }, { cwd: root });
    assert.equal(read.status, 'applied');
    assert.equal(read.changed, false);
    assert.equal((read.data as { state: string }).state, 'open');

    const dismissed = await dismissSecurityAlert({ kind: 'dependabot', number: 7, reason: 'not_used', comment: 'handled' }, { cwd: root });
    assert.equal(dismissed.status, 'applied');
    assert.equal(dismissed.changed, true);
  } finally {
    clearProviderSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('security runtime no-ops closed alerts and degrades without a capability', async () => {
  const closedRoot = fixtureRoot({ state: 'dismissed' });
  try {
    clearProviderSessions();
    const result = await dismissSecurityAlert({ kind: 'code-scanning', number: 3, reason: 'false_positive', comment: 'handled' }, { cwd: closedRoot });
    assert.equal(result.status, 'no-op');
    assert.equal(result.changed, false);
  } finally {
    clearProviderSessions();
    fs.rmSync(closedRoot, { recursive: true, force: true });
  }

  const noneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'security-alert-none-'));
  try {
    const result = await readSecurityAlert({ kind: 'dependabot', number: 3 }, { cwd: noneRoot, platformType: 'none' });
    assert.equal(result.status, 'degraded');
    assert.equal(result.error?.code, 'PLATFORM_CAPABILITY_UNSUPPORTED');
  } finally {
    fs.rmSync(noneRoot, { recursive: true, force: true });
  }
});
