import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';
import {
  appendCriticalAudit,
  appendDiagnosticAudit,
  createSandboxControlAuditContext,
  readSandboxControlTransition,
  writeSandboxControlTransition
} from '../../../lib/sandbox/control/audit.ts';
import { onPlatforms } from '../../helpers.ts';

function fixture(): { root: string; manifest: SandboxControlManifest } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-control-audit-'));
  const manifest = {
    engine: 'docker', repoRoot: root, worktreeRoot: root, project: 'project', container: 'container',
    containerIdentity: { id: 'container-id', labels: {} }, authorityEvidence: {}, branch: 'feature',
    mode: 'task-bound' as const, taskId: 'TASK-20260904-002407', token: 'private-token',
    generation: 'generation-1', controlRootId: 'a'.repeat(96), channelDir: path.join(root, 'channel'),
    publicStatusDir: path.join(root, 'public'), processingDir: path.join(root, 'processing'), runtimeDir: path.join(root, 'runtime')
  } as SandboxControlManifest;
  for (const directory of [manifest.channelDir, manifest.publicStatusDir, manifest.processingDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return { root, manifest };
}

test('audit context filters sensitive fields and transitions are immutable', onPlatforms('linux', 'darwin'), () => {
  const { root, manifest } = fixture();
  const requestId = 'a'.repeat(32);
  try {
    const context = createSandboxControlAuditContext(manifest, {
      requestId, family: 'task-lifecycle', operation: 'complete', phase: 'validated', outcome: 'in-progress'
    });
    appendCriticalAudit(manifest, context, {
      token: manifest.token, requestPath: '/private/root', stdout: 'secret-output', safeCount: 1
    });
    appendDiagnosticAudit(manifest, 'diagnostic', { stderr: 'private', safeState: 'healthy' });
    const lines = fs.readFileSync(path.join(root, 'audit.ndjson'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines.every((line) => !line.includes(manifest.token) && !line.includes('private')), true);
    const transition = writeSandboxControlTransition(manifest, {
      requestId, phase: 'started-committed', now: 10
    });
    assert.deepEqual(readSandboxControlTransition(manifest, requestId, 'started-committed'), transition);
    assert.throws(
      () => writeSandboxControlTransition(manifest, { requestId, phase: 'started-committed', now: 11 }),
      /SANDBOX_CONTROL_TRANSITION_CONFLICT/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('audit rotation is deferred while a request has no terminal transition', onPlatforms('linux', 'darwin'), () => {
  const { root, manifest } = fixture();
  const requestId = 'b'.repeat(32);
  try {
    fs.mkdirSync(path.join(manifest.processingDir, requestId), { recursive: true });
    fs.writeFileSync(path.join(root, 'audit.ndjson'), 'x'.repeat(1024 * 1024));
    appendDiagnosticAudit(manifest, 'still-active', { safeState: 'busy' });
    assert.equal(fs.existsSync(path.join(root, 'audit.ndjson.1')), false);
    writeSandboxControlTransition(manifest, { requestId, phase: 'published-committed', now: 20 });
    appendDiagnosticAudit(manifest, 'terminal', { safeState: 'healthy' });
    assert.equal(fs.existsSync(path.join(root, 'audit.ndjson.1')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
