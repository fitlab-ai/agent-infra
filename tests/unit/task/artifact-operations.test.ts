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
import { writeArtifactRepairIntent } from '../../../lib/task/artifact-repair-intent.ts';

function taskFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-operations-'));
  const id = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${id}\nstatus: active\ncurrent_step: technical-design\n---\n\n## Activity Log\n\n- 2026-01-01 00:00:00+00:00 — **Plan Task (Round 1) [started]** by codex — started\n`);
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
  writeArtifactRepairIntent(f.root, {
    version: 1, taskId: f.id, family: 'plan', artifact,
    state: 'awaiting-repair', baselineSemanticDigest: inspection.semanticDigest,
    artifactSha256: sha256Content(malformed), semanticDigest: inspection.semanticDigest
  });

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
  fs.writeFileSync(path.join(f.taskDir, 'task.md'), fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8').replace('technical-design', 'requirement-analysis').replace('Plan Task', 'Analyze Task'));
  writeArtifactRepairIntent(f.root, {
    version: 1, taskId: f.id, family: 'analysis', artifact,
    state: 'awaiting-repair', baselineSemanticDigest: inspection.semanticDigest,
    artifactSha256: sha256Content(malformed), semanticDigest: inspection.semanticDigest
  });
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

test('insert-section repairs one missing heading only at a unique marker with semantic body', () => {
  const f = taskFixture();
  const artifact = 'plan.md';
  const malformed = renderArtifactSkeleton({ taskId: f.id, family: 'plan', artifact })
    .replaceAll('<!-- artifact-slot:empty -->', '内容')
    .replace('## 约束条件\n', '');
  fs.writeFileSync(path.join(f.taskDir, artifact), malformed);
  const inspection = inspectArtifactStructure(malformed, getArtifactSchema('plan')!);
  assert.equal(inspection.repair?.kind, 'insert-section');
  assert.equal(inspection.repair?.sectionId, 'constraints');
  assert.equal(inspection.diagnostics.length, 1);
  assert.equal(inspection.diagnostics[0]?.repairable, true);
  writeArtifactRepairIntent(f.root, {
    version: 1, taskId: f.id, family: 'plan', artifact,
    state: 'awaiting-repair', baselineSemanticDigest: inspection.semanticDigest,
    artifactSha256: sha256Content(malformed), semanticDigest: inspection.semanticDigest
  });
  const result = applyArtifactRepair({
    repoRoot: f.root, taskId: f.id, taskDir: f.taskDir, family: 'plan', artifact,
    expectedSha256: sha256Content(malformed),
    expectedSemanticDigest: inspection.semanticDigest,
    operation: inspection.repair!
  });
  assert.equal(result.status, 'applied');
  assert.equal(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8').includes('## 约束条件\n<!-- artifact-section:plan:constraints -->'), true);

  const english = renderArtifactSkeleton({ taskId: f.id, family: 'plan', artifact, locale: 'en' })
    .replaceAll('<!-- artifact-slot:empty -->', 'content')
    .replace('## Constraints\n', '');
  const englishInspection = inspectArtifactStructure(english, getArtifactSchema('plan')!);
  assert.equal(englishInspection.repair?.to, '## Constraints\n');
});

test('repair rejects a completed lifecycle even when the artifact baseline and operation match', () => {
  const f = taskFixture();
  const artifact = 'plan.md';
  const malformed = renderArtifactSkeleton({ taskId: f.id, family: 'plan', artifact })
    .replaceAll('<!-- artifact-slot:empty -->', '内容')
    .replace('## 问题理解\n', '## 问题理解：\n');
  fs.writeFileSync(path.join(f.taskDir, artifact), malformed);
  const inspection = inspectArtifactStructure(malformed, getArtifactSchema('plan')!);
  assert.ok(inspection.repair);
  writeArtifactRepairIntent(f.root, {
    version: 1, taskId: f.id, family: 'plan', artifact,
    state: 'awaiting-repair', baselineSemanticDigest: inspection.semanticDigest,
    artifactSha256: sha256Content(malformed), semanticDigest: inspection.semanticDigest
  });
  const mismatchedContext = malformed.replace(`artifact-context:${f.id}:plan:1`, 'artifact-context:TASK-20260101-000002:plan:1');
  fs.writeFileSync(path.join(f.taskDir, artifact), mismatchedContext);
  const contextResult = applyArtifactRepair({
    repoRoot: f.root, taskId: f.id, taskDir: f.taskDir, family: 'plan', artifact,
    expectedSha256: sha256Content(mismatchedContext),
    expectedSemanticDigest: inspection.semanticDigest,
    operation: inspection.repair
  });
  assert.equal(contextResult.status, 'failed');
  assert.equal(contextResult.error?.code, 'ARTIFACT_REPAIR_CONTEXT_INVALID');
  fs.writeFileSync(path.join(f.taskDir, artifact), malformed);
  fs.writeFileSync(
    path.join(f.taskDir, 'task.md'),
    fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8').replace(
      '**Plan Task (Round 1) [started]** by codex — started',
      '**Plan Task (Round 1)** by codex — completed'
    )
  );
  const before = fs.readFileSync(path.join(f.taskDir, artifact), 'utf8');
  const result = applyArtifactRepair({
    repoRoot: f.root, taskId: f.id, taskDir: f.taskDir, family: 'plan', artifact,
    expectedSha256: sha256Content(malformed),
    expectedSemanticDigest: inspection.semanticDigest,
    operation: inspection.repair
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'ARTIFACT_REPAIR_CONTEXT_INVALID');
  assert.equal(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8'), before);
});

test('structure inspection fails closed for ambiguous insertion and reordered sections', () => {
  const f = taskFixture();
  const artifact = 'plan.md';
  const valid = renderArtifactSkeleton({ taskId: f.id, family: 'plan', artifact }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  const emptyBody = valid.replace('## 约束条件\n<!-- artifact-section:plan:constraints -->\n内容', '## 约束条件\n<!-- artifact-section:plan:constraints -->\n<!-- artifact-slot:empty -->');
  const empty = inspectArtifactStructure(emptyBody, getArtifactSchema('plan')!);
  assert.equal(empty.repair, null);
  assert.ok(empty.diagnostics.some((item) => item.code === 'ARTIFACT_EMPTY_SECTION'));

  const first = '## 问题理解\n<!-- artifact-section:plan:understanding -->\n内容\n\n';
  const second = '## 约束条件\n<!-- artifact-section:plan:constraints -->\n内容\n\n';
  const reordered = valid.replace(first + second, second + first);
  const order = inspectArtifactStructure(reordered, getArtifactSchema('plan')!);
  assert.equal(order.ok, false);
  assert.ok(order.diagnostics.some((item) => item.code === 'ARTIFACT_SECTION_ORDER_INVALID'));
});
