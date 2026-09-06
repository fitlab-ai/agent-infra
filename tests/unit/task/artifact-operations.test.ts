import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { getArtifactSchema, renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import {
  applyArtifactRepair,
  canonicalSemanticDigest,
  inspectArtifactStructure,
  sha256Content
} from '../../../lib/task/artifact-operations.ts';

function taskFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-operations-'));
  const id = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${id}\nstatus: active\ncurrent_step: technical-design\n---\n`);
  return { root, id, taskDir };
}

test('repair applies exactly one structural operation and preserves canonical digest', () => {
  const f = taskFixture();
  const artifact = 'plan.md';
  const content = renderArtifactSkeleton({ taskId: f.id, family: 'plan', artifact });
  const filled = content.replaceAll('<!-- artifact-slot:empty -->', '内容');
  const malformed = filled.replace('## 问题理解\n', '## 问题理解：\n');
  fs.writeFileSync(path.join(f.taskDir, artifact), malformed);
  const schema = getArtifactSchema('plan')!;
  const inspection = inspectArtifactStructure(malformed, schema);
  assert.equal(inspection.repair?.kind, 'replace-line');
  assert.equal(inspection.diagnostics.length, 1);

  const result = applyArtifactRepair({
    repoRoot: f.root,
    taskId: f.id,
    taskDir: f.taskDir,
    family: 'plan',
    artifact,
    expectedSha256: sha256Content(malformed),
    expectedSemanticDigest: canonicalSemanticDigest(malformed, inspection.repair),
    operation: inspection.repair!
  });

  assert.equal(result.status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8').includes('## 问题理解：'), false);
  assert.equal(result.semanticDigest, canonicalSemanticDigest(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8')));
});

test('repair fails closed on stale digest, symlink, and empty marker body', () => {
  const f = taskFixture();
  const artifact = 'analysis.md';
  const skeleton = renderArtifactSkeleton({ taskId: f.id, family: 'analysis', artifact });
  const malformed = skeleton.replaceAll('<!-- artifact-slot:empty -->', '内容').replace('## 需求来源\n', '## 需求来源：\n');
  fs.writeFileSync(path.join(f.taskDir, artifact), malformed);
  const inspection = inspectArtifactStructure(malformed, getArtifactSchema('analysis')!);
  assert.ok(inspection.repair);
  const stale = applyArtifactRepair({
    repoRoot: f.root,
    taskId: f.id,
    taskDir: f.taskDir,
    family: 'analysis',
    artifact,
    expectedSha256: createHash('sha256').update('stale').digest('hex'),
    expectedSemanticDigest: canonicalSemanticDigest(malformed, inspection.repair),
    operation: inspection.repair!
  });
  assert.equal(stale.status, 'failed');
  assert.equal(stale.error?.code, 'ARTIFACT_REPAIR_BASELINE_MISMATCH');

  fs.unlinkSync(path.join(f.taskDir, artifact));
  fs.symlinkSync(path.join(f.taskDir, 'task.md'), path.join(f.taskDir, artifact));
  const symlink = applyArtifactRepair({
    repoRoot: f.root,
    taskId: f.id,
    taskDir: f.taskDir,
    family: 'analysis',
    artifact,
    expectedSha256: sha256Content(malformed),
    expectedSemanticDigest: canonicalSemanticDigest(malformed, inspection.repair),
    operation: inspection.repair!
  });
  assert.equal(symlink.status, 'failed');
  assert.equal(symlink.error?.code, 'ARTIFACT_REPAIR_TARGET_INVALID');
});
