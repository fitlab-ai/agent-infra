import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  artifactFamilyCatalog,
  artifactName,
  buildArtifactLinkSection,
  inspectTaskArtifacts,
  parseArtifactName,
  resolveArtifactContext,
  validateCompletedArtifact
} from '../../../lib/task/artifact-lifecycle.ts';
import { sha256Bytes, sha256File, upsertArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';

const TASK_ID = 'TASK-20260101-000001';

function fixture(files: Record<string, string> = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-lifecycle-'));
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(taskDir, name), content);
  return { repoRoot, taskDir };
}

function addReceipt(f: ReturnType<typeof fixture>, receipt: Parameters<typeof upsertArtifactReceipt>[1]) {
  const taskPath = path.join(f.taskDir, 'task.md');
  const content = fs.readFileSync(taskPath, 'utf8');
  const mutation = upsertArtifactReceipt(content, receipt);
  fs.writeFileSync(taskPath, upsertSection(content, mutation).content);
}

test('catalog exposes exactly the approved artifact families', () => {
  assert.deepEqual(artifactFamilyCatalog.map((item) => item.family), [
    'analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code', 'manual-validation', 'validation-run', 'pr-review'
  ]);
});

test('canonical names round-trip without accepting round-one aliases', () => {
  for (const spec of artifactFamilyCatalog) {
    assert.equal(artifactName(spec.family, 1), `${spec.family}.md`);
    assert.equal(artifactName(spec.family, 2), `${spec.family}-r2.md`);
    assert.deepEqual(parseArtifactName(`${spec.family}-r3.md`), { family: spec.family, round: 3, name: `${spec.family}-r3.md` });
    assert.equal(parseArtifactName(`${spec.family}-r1.md`), null);
  }
  assert.throws(() => artifactName('analysis', 0), /safe positive integer/);
  assert.throws(() => artifactName('analysis', Number.MAX_SAFE_INTEGER + 1), /safe positive integer/);
});

test('inventory keeps family rounds independent and computes the next identity', () => {
  const f = fixture({
    'plan.md': '# plan', 'plan-r2.md': '# plan 2', 'plan-r3.md': '# plan 3',
    'review-plan.md': '# review', 'review-plan-r2.md': '# review 2'
  });
  const plans = inspectTaskArtifacts(TASK_ID, 'plan', { repoRoot: f.repoRoot });
  const reviews = inspectTaskArtifacts(TASK_ID, 'review-plan', { repoRoot: f.repoRoot });
  assert.equal(plans.status, 'ready');
  assert.deepEqual(plans.artifacts.map((item) => item.round), [1, 2, 3]);
  assert.deepEqual(plans.next, { round: 4, name: 'plan-r4.md' });
  assert.equal(reviews.status, 'ready');
  assert.deepEqual(reviews.next, { round: 3, name: 'review-plan-r3.md' });
});

test('inventory is byte, mtime, and directory-entry pure', () => {
  const f = fixture({ 'analysis.md': '# analysis' });
  const taskPath = path.join(f.taskDir, 'task.md');
  const artifactPath = path.join(f.taskDir, 'analysis.md');
  const before = {
    task: fs.readFileSync(taskPath), artifact: fs.readFileSync(artifactPath),
    taskMtime: fs.statSync(taskPath).mtimeMs, artifactMtime: fs.statSync(artifactPath).mtimeMs,
    entries: fs.readdirSync(f.taskDir).sort()
  };
  const result = inspectTaskArtifacts(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready');
  assert.deepEqual(fs.readFileSync(taskPath), before.task);
  assert.deepEqual(fs.readFileSync(artifactPath), before.artifact);
  assert.equal(fs.statSync(taskPath).mtimeMs, before.taskMtime);
  assert.equal(fs.statSync(artifactPath).mtimeMs, before.artifactMtime);
  assert.deepEqual(fs.readdirSync(f.taskDir).sort(), before.entries);
});

test('read inventory returns canonical history plus topology diagnostics', () => {
  const f = fixture({ 'analysis.md': '# one', 'analysis-r3.md': '# three', 'analysis-r1.md': '# alias' });
  const result = inspectTaskArtifacts(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.artifacts.map((item) => item.name), ['analysis.md', 'analysis-r3.md']);
  assert.deepEqual(result.diagnostics.map((item) => item.code).sort(), ['NONCANONICAL_NAME', 'ROUND_GAP']);
});

test('unknown families fail without resolving outside the catalog', () => {
  const f = fixture();
  const result = inspectTaskArtifacts(TASK_ID, 'unknown', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'ARTIFACT_FAMILY_UNKNOWN');
});

test('completed artifacts reject unsafe Issue comment content', () => {
  const f = fixture({ 'analysis.md': '# Analysis\n\n@2x\n' });
  const result = validateCompletedArtifact(f.taskDir, 'analysis', 'analysis.md', 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'ARTIFACT_CONTENT_INVALID');
});

test('automatic artifact references use code text and remain idempotent', () => {
  const f = fixture({ 'analysis.md': '# Analysis\n' });
  const inventory = inspectTaskArtifacts(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(inventory.status, 'ready');
  const artifact = inventory.artifacts[0]!;
  const content = '# Task\n\n## 分析\n\n[分析阶段的发现。哪些文件受影响？范围是什么？]\n';
  const first = buildArtifactLinkSection(content, artifact);
  assert.match(first.body, /：`analysis\.md`$/);
  const second = buildArtifactLinkSection(`# Task\n\n## 分析\n\n${first.body}\n`, artifact);
  assert.equal(second.body, first.body);
});

test('context resolves required latest inputs and actual review references independently', () => {
  const f = fixture({
    'analysis.md': '# analysis',
    'analysis-r2.md': '# analysis 2',
    'plan.md': '# plan',
    'plan-r2.md': '# plan 2',
    'review-plan.md': '**审查输入**：`plan-r2.md`\n'
  });
  addReceipt(f, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan-r2.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan-r2.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const plan = resolveArtifactContext(TASK_ID, 'plan', { repoRoot: f.repoRoot });
  const review = resolveArtifactContext(TASK_ID, 'review-plan', { repoRoot: f.repoRoot });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.inputs.map((item) => item.name), ['analysis-r2.md', 'review-plan.md']);
  assert.equal(review.status, 'ready');
  assert.deepEqual(review.inputs.map((item) => item.name), ['plan-r2.md']);
  assert.equal(inspectTaskArtifacts(TASK_ID, 'review-plan', { repoRoot: f.repoRoot }).reviewedInput?.name, 'plan-r2.md');
});

test('review references ignore mtime order and fail closed on content changes', () => {
  const f = fixture({
    'analysis.md': '# analysis\n',
    'review-analysis.md': '**审查输入**：`analysis.md`\n'
  });
  addReceipt(f, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(f.taskDir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const old = new Date(Date.now() - 10_000);
  const future = new Date(Date.now());
  fs.utimesSync(path.join(f.taskDir, 'review-analysis.md'), old, old);
  fs.utimesSync(path.join(f.taskDir, 'analysis.md'), future, future);

  assert.equal(resolveArtifactContext(TASK_ID, 'analysis', { repoRoot: f.repoRoot }).status, 'ready');
  fs.appendFileSync(path.join(f.taskDir, 'analysis.md'), 'changed\n');
  const changed = resolveArtifactContext(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(changed.status, 'failed');
  assert.equal(changed.error?.code, 'ARTIFACT_REFERENCE_INVALID');
});

test('code replan routing compares plan content with the code input receipt', () => {
  const f = fixture({
    'plan.md': '# new plan\n',
    'code.md': '# code\n',
    'review-plan.md': '**审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n'
  });
  addReceipt(f, {
    event: 'code.completed', output: 'code.md', input: 'plan.md',
    inputSha256: sha256Bytes(Buffer.from('# old plan\n')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  addReceipt(f, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan.md')), completedAt: '2026-01-01 00:01:00+00:00'
  });

  const result = resolveArtifactContext(TASK_ID, 'code', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready');
  assert.equal(result.codeMode?.mode, 'init');
  assert.equal(result.codeMode?.reviewArtifact, 'review-plan.md');
});

test('revision context fails closed when a review points to a future input', () => {
  const f = fixture({ 'analysis.md': '# analysis', 'review-analysis.md': '**Review Input**: `analysis.md`\n' });
  const reviewPath = path.join(f.taskDir, 'review-analysis.md');
  const analysisPath = path.join(f.taskDir, 'analysis.md');
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(reviewPath, past, past);
  const future = new Date(Date.now());
  fs.utimesSync(analysisPath, future, future);
  const result = resolveArtifactContext(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'ARTIFACT_REFERENCE_INVALID');
});
