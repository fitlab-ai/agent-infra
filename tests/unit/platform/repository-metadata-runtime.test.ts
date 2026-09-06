import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearProviderSessions } from '../../../lib/platform/provider-loader.ts';
import { initializeLabels } from '../../../lib/platform/repository-metadata.ts';

function fixtureRoot(metadataFailure = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-metadata-runtime-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({
    labels: { in: { docs: ['docs/'], core: ['lib/'] } },
    platform: {
      type: 'fixture',
      providers: {
        fixture: {
          source: path.resolve('tests/fixtures/platform-providers/security-metadata-provider.mjs'),
          ...(metadataFailure ? { config: { metadataFailure: 'partial' } } : {})
        }
      }
    }
  }));
  return root;
}

test('label initialization passes configuration and cleanup intent to the provider', async () => {
  const root = fixtureRoot();
  try {
    clearProviderSessions();
    const result = await initializeLabels({ cleanupStaleIn: true }, { cwd: root });
    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
    assert.deepEqual(result.labels.removed, ['in: stale']);
    assert.equal(result.labels.inCount, 2);
  } finally {
    clearProviderSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('label initialization projects confirmed provider results when reconciliation fails', async () => {
  const root = fixtureRoot(true);
  try {
    clearProviderSessions();
    const result = await initializeLabels({}, { cwd: root });
    assert.equal(result.status, 'failed');
    assert.equal(result.changed, true);
    assert.deepEqual(result.labels.created, ['in: partial']);
    assert.deepEqual(result.labels.updated, []);
    assert.equal(result.error?.code, 'PERMISSION_DENIED');
  } finally {
    clearProviderSessions();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
