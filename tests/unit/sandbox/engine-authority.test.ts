import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorityVersionArgs,
  captureSandboxAuthority,
  verifySandboxAuthority
} from '../../../lib/sandbox/engines/authority.ts';

function probeResult(stdout: string, status = 0): any {
  return { status, signal: null, stdout, stderr: '', pid: 1, output: [] };
}

test('authority capture stores only redacted route and hashed daemon identity', () => {
  const calls: string[][] = [];
  const evidence = captureSandboxAuthority('native', {
    env: { DOCKER_HOST: 'tcp://user:secret@example.test:2376?token=hidden' },
    probe: (_cmd, args) => {
      calls.push(args);
      return probeResult(JSON.stringify({ ID: 'daemon-secret-id', APIVersion: '1.50' }));
    }
  });

  assert.deepEqual(calls[0], authorityVersionArgs());
  assert.equal(evidence.normalizedEndpoint.includes('secret'), false);
  assert.equal(evidence.normalizedEndpoint.includes('hidden'), false);
  assert.equal(evidence.daemonIdentity.fingerprint.includes('daemon-secret-id'), false);
  assert.equal(evidence.apiVersion.major, 1);
  assert.equal(evidence.apiVersion.minor, 50);
});

test('authority verification rejects route or daemon drift', () => {
  const capture = (host: string) => captureSandboxAuthority('native', {
    env: { DOCKER_HOST: host },
    lockDomain: 'a'.repeat(64),
    probe: () => probeResult(JSON.stringify({ ID: 'daemon-id', APIVersion: '1.50' }))
  });
  const original = capture('unix:///run/user/1000/docker.sock');

  assert.deepEqual(verifySandboxAuthority(original, original), { state: 'verified' });
  assert.deepEqual(verifySandboxAuthority(original, capture('tcp://docker.example.test:2376')), {
    state: 'conflict',
    reason: 'SANDBOX_AUTHORITY_DRIFT'
  });
  assert.deepEqual(verifySandboxAuthority(null, original), {
    state: 'unknown',
    reason: 'SANDBOX_AUTHORITY_EVIDENCE_MISSING'
  });
});
