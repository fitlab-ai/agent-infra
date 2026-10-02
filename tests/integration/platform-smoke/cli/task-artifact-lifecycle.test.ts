import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  artifactFamilyCatalog,
  buildArtifactLinkSection,
  inspectTaskArtifacts,
  resolveArtifactContext,
  validateCompletedArtifact
} from '../../../../lib/task/artifact-lifecycle.ts';
import { artifactName, parseArtifactName } from '../../../../lib/task/artifact-name.ts';
import { sha256Bytes, sha256File, upsertArtifactReceipt } from '../../../../lib/task/artifact-receipts.ts';
import { buildQualificationAudit, renderQualificationAudit } from '../../../../lib/task/qualification-audit.ts';
import { upsertSection } from '../../../../lib/task/sections.ts';
import { snapshotReview } from '../../../../lib/git/review-snapshot.ts';
import { resolvePostReviewGlobs } from '../../../../lib/task/review-fingerprint.ts';
import { canonicalSemanticDigest } from '../../../../lib/task/artifact-operations.ts';
import { recordArtifactCompletions } from '../../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';
const STANDARD_ANALYSIS = '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：标准路径。\n- **判定依据**：变更需要技术方案。\n- **未满足的更高路径条件**：不涉及高风险边界。\n- **升级触发条件**：发现权限、持久化或外部契约变更。\n';

function fixture(files: Record<string, string> = {}, completeReports = true) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-lifecycle-'));
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.agents/workspace/\n');
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(taskDir, name), content);
  if (completeReports) recordFixtureCompletions(taskDir);
  return { repoRoot, taskDir };
}

function recordFixtureCompletions(taskDir: string) {
  const names = fs.readdirSync(taskDir).filter((name) => {
    const identity = parseArtifactName(name);
    return identity !== null && ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code'].includes(identity.family);
  }).sort((left, right) => {
    const a = parseArtifactName(left)!; const b = parseArtifactName(right)!;
    return a.family.localeCompare(b.family) || a.round - b.round;
  });
  recordArtifactCompletions(taskDir, names.map((name) => ({ name })));
}

function addReceipt(f: ReturnType<typeof fixture>, receipt: Parameters<typeof upsertArtifactReceipt>[1]) {
  const taskPath = path.join(f.taskDir, 'task.md');
  const content = fs.readFileSync(taskPath, 'utf8');
  const mutation = upsertArtifactReceipt(content, receipt);
  fs.writeFileSync(taskPath, upsertSection(content, mutation).content);
}

function enableQualification(f: ReturnType<typeof fixture>) {
  const taskPath = path.join(f.taskDir, 'task.md');
  const content = fs.readFileSync(taskPath, 'utf8');
  fs.writeFileSync(taskPath, `${content}\n## \u7ea6\u675f\n\n| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| C-1 | Keep lifecycle recovery possible | derived | task-input | task.md | task.md#\u7ea6\u675f |  |  |\n\n## \u5019\u9009\u4e0e\u5426\u51b3\u65b9\u6848\n\n| candidate_id | statement | status | constraint_ids | impact | evidence |\n| --- | --- | --- | --- | --- | --- |\n| A | Rebuild from the earliest stale stage | qualified | C-1 | bounded recovery | task.md#\u5019\u9009\u4e0e\u5426\u51b3\u65b9\u6848 |\n`);
}

function writeQualifiedArtifact(f: ReturnType<typeof fixture>, name: string) {
  const taskContent = fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8');
  const built = buildQualificationAudit(taskContent);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const lifecycle = parseArtifactName(name)?.family === 'analysis' ? `${STANDARD_ANALYSIS}\n` : `# ${name}\n\n`;
  fs.writeFileSync(path.join(f.taskDir, name), `${lifecycle}## \u8d44\u683c\u5ba1\u8ba1\n\n${renderQualificationAudit(built.audit)}\n`);
  recordFixtureCompletions(f.taskDir);
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function completedReviewFixture(f: ReturnType<typeof fixture>, options: { includeReviewedHead?: boolean } = {}) {
  const aircPath = path.join(f.repoRoot, '.agents', '.airc.json');
  fs.mkdirSync(path.dirname(aircPath), { recursive: true });
  fs.writeFileSync(aircPath, JSON.stringify({ delivery: { remote: 'origin', baseRef: 'main' } }) + '\n');
  fs.writeFileSync(path.join(f.repoRoot, '.gitignore'), '.agents/workspace/\n');
  git(f.repoRoot, ['config', 'user.email', 'codex@example.com']);
  git(f.repoRoot, ['config', 'user.name', 'Codex']);
  git(f.repoRoot, ['add', '.agents/.airc.json', '.gitignore']);
  git(f.repoRoot, ['commit', '-qm', 'fixture base']);
  const head = git(f.repoRoot, ['rev-parse', 'HEAD']);
  const reviewed = snapshotReview({ cwd: f.repoRoot, mode: 'worktree', baseline: head, diffBase: head, globs: resolvePostReviewGlobs({}, {}) });
  const report = [
    '# Code Review', '', '## Review Summary', '',
    `- **Review Target Commit**: ${head}`,
    ...(options.includeReviewedHead === false ? [] : [`- **Reviewed Head**: ${head}`]),
    `- **Review Baseline Commit**: ${head}`,
    `- **Reviewed Diff Base**: ${head}`,
    `- **Reviewed Diff Fingerprint**: ${reviewed.fingerprint}`,
    `- **Reviewed Snapshot Tree**: ${reviewed.tree}`,
    '- **Overall Verdict**: Approved'
  ].join('\n') + '\n';
  const analysisPath = path.join(f.taskDir, 'analysis.md');
  fs.writeFileSync(analysisPath, STANDARD_ANALYSIS);
  const analysisFact = {
    event: 'analyze.completed', output: 'analysis.md', outputSha256: sha256File(analysisPath),
    semanticDigest: canonicalSemanticDigest(STANDARD_ANALYSIS), requestId: 'fixture-analysis', result: 'completed'
  };
  const reviewPath = path.join(f.taskDir, 'review-code.md');
  fs.writeFileSync(reviewPath, report);
  const fact = {
    event: 'review-code.completed', output: 'review-code.md', outputSha256: sha256File(reviewPath),
    semanticDigest: canonicalSemanticDigest(report), requestId: 'fixture-review', result: '{}'
  };
  fs.writeFileSync(path.join(f.taskDir, 'task.md'), [
    '---', `id: ${TASK_ID}`, 'status: active', 'current_step: code-review',
    'delivery_remote: origin', 'delivery_base_ref: main',
    `completion_facts: ${JSON.stringify(JSON.stringify([analysisFact, fact]))}`, '---', '', '# Task', '',
    '## 活动日志', '',
    '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started',
    '- 2026-01-01 00:00:01+00:00 — **Analyze Task (Round 1)** by codex — Analysis completed → analysis.md',
    '- 2026-01-01 00:00:02+00:00 — **Review Code (Round 1) [started]** by codex — started',
    '- 2026-01-01 00:00:03+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved → review-code.md', ''
  ].join('\n'));
  return { head };
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

test('review-code can start with the current git diff when no code artifact exists', () => {
  const f = fixture({ 'analysis.md': STANDARD_ANALYSIS });
  const result = resolveArtifactContext(TASK_ID, 'review-code', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready', JSON.stringify(result.error));
  assert.deepEqual(result.inputs, []);
  assert.equal(result.selection?.disposition, 'create');
  assert.equal(result.selection?.artifact.name, 'review-code.md');
});

test('review-code reuses only a completed report bound to the current commit', () => {
  const f = fixture({ 'analysis.md': STANDARD_ANALYSIS });
  completedReviewFixture(f);
  const unchanged = resolveArtifactContext(TASK_ID, 'review-code', { repoRoot: f.repoRoot });
  assert.equal(unchanged.status, 'ready', JSON.stringify(unchanged.error));
  assert.equal(unchanged.selection?.disposition, 'reuse');
  assert.equal(unchanged.selection?.artifact.name, 'review-code.md');

  fs.mkdirSync(path.join(f.repoRoot, '.agents', 'skills'), { recursive: true });
  const uncommittedPath = path.join(f.repoRoot, '.agents', 'skills', 'uncommitted.md');
  fs.writeFileSync(uncommittedPath, 'uncommitted review scope\n');
  const dirty = resolveArtifactContext(TASK_ID, 'review-code', { repoRoot: f.repoRoot });
  assert.equal(dirty.status, 'ready', JSON.stringify(dirty.error));
  assert.equal(dirty.selection?.disposition, 'create');
  fs.unlinkSync(uncommittedPath);

  fs.writeFileSync(path.join(f.repoRoot, '.agents', 'skills', 'after-review.md'), 'new commit\n');
  git(f.repoRoot, ['add', '.agents/skills/after-review.md']);
  git(f.repoRoot, ['commit', '-qm', 'change reviewed head']);
  const changed = resolveArtifactContext(TASK_ID, 'review-code', { repoRoot: f.repoRoot });
  assert.equal(changed.status, 'ready', JSON.stringify(changed.error));
  assert.equal(changed.selection?.disposition, 'create');
  assert.equal(changed.selection?.artifact.name, 'review-code-r2.md');
});

test('review-code creates a new round when a completed report omits Reviewed Head', () => {
  const f = fixture({ 'analysis.md': STANDARD_ANALYSIS });
  completedReviewFixture(f, { includeReviewedHead: false });

  const result = resolveArtifactContext(TASK_ID, 'review-code', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready', JSON.stringify(result.error));
  assert.equal(result.selection?.disposition, 'create');
  assert.equal(result.selection?.artifact.name, 'review-code-r2.md');
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

test('legacy invalidation text is inert and does not filter the physical artifact inventory', () => {
  const f = fixture({ 'analysis.md': '# analysis\n' }, false);
  const taskPath = path.join(f.taskDir, 'task.md');
  fs.appendFileSync(taskPath, '\n## 产物失效记录\n\nnot a valid legacy table\n');

  const result = inspectTaskArtifacts(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.artifacts.map((artifact) => artifact.name), ['analysis.md']);
  assert.deepEqual(result.completed, []);
  assert.equal(result.latest, null);
  assert.deepEqual(result.next, { round: 2, name: 'analysis-r2.md' });
});

test('an open higher round resumes while the prior completed round remains current', () => {
  const f = fixture({
    'analysis.md': STANDARD_ANALYSIS,
    'plan.md': '# Plan 1\n',
    'plan-r2.md': '# Plan 2\n'
  });
  const taskPath = path.join(f.taskDir, 'task.md');
  fs.appendFileSync(taskPath, '- 2026-01-01 00:01:00+00:00 — **Plan Task (Round 3) [started]** by codex — started\n');

  const inventory = inspectTaskArtifacts(TASK_ID, 'plan', { repoRoot: f.repoRoot });
  assert.equal(inventory.status, 'ready');
  assert.equal(inventory.latest?.name, 'plan-r2.md');
  assert.deepEqual(inventory.openRounds, [3]);
  const context = resolveArtifactContext(TASK_ID, 'plan', { repoRoot: f.repoRoot });
  assert.equal(context.status, 'ready');
  assert.equal(context.selection?.disposition, 'resume');
  assert.equal(context.next?.name, 'plan-r3.md');
});

test('unknown families fail without resolving outside the catalog', () => {
  const f = fixture();
  const result = inspectTaskArtifacts(TASK_ID, 'unknown', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'ARTIFACT_FAMILY_UNKNOWN');
});

test('completed artifacts preserve source Markdown content', () => {
  const f = fixture({ 'analysis.md': '# Analysis\n\n[local](/workspace/file.md)\n\n@2x\n' });
  const result = validateCompletedArtifact(f.taskDir, 'analysis', 'analysis.md', 1);
  assert.equal(result.ok, true);
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

test('context resolves required latest inputs from review receipts', () => {
  const f = fixture({
    'analysis.md': STANDARD_ANALYSIS,
    'analysis-r2.md': STANDARD_ANALYSIS.replace('# Analysis', '# Analysis 2'),
    'plan.md': '# plan',
    'plan-r2.md': '# plan 2',
    'review-plan.md': '# Review Plan\n\n本轮检视了 `plan-r2.md`。\n'
  });
  addReceipt(f, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan-r2.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan-r2.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const plan = resolveArtifactContext(TASK_ID, 'plan', { repoRoot: f.repoRoot });
  const review = resolveArtifactContext(TASK_ID, 'review-plan', { repoRoot: f.repoRoot });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.error));
  assert.deepEqual(plan.inputs.map((item) => item.name), ['analysis-r2.md', 'review-plan.md']);
  assert.equal(review.status, 'ready');
  assert.equal(inspectTaskArtifacts(TASK_ID, 'review-plan', { repoRoot: f.repoRoot }).reviewedInput?.name, 'plan-r2.md');
});

test('code context selects analysis or plan from the canonical lifecycle path', () => {
  const analysis = (pathName: string) => `# Analysis\n\n## 流程裁定\n\n- **本任务路径**：${pathName}。\n- **判定依据**：事实充分。\n- **未满足的更高路径条件**：没有更高路径事实。\n- **升级触发条件**：出现真实外部边界。\n`;
  const streamlined = fixture({ 'analysis.md': analysis('精简路径') });
  const streamlinedCode = resolveArtifactContext(TASK_ID, 'code', { repoRoot: streamlined.repoRoot });
  assert.equal(streamlinedCode.status, 'ready');
  assert.deepEqual(streamlinedCode.inputs.map((item) => item.name), ['analysis.md']);

  const standard = fixture({ 'analysis.md': analysis('标准路径'), 'plan.md': '# Plan\n' });
  const standardCode = resolveArtifactContext(TASK_ID, 'code', { repoRoot: standard.repoRoot });
  assert.equal(standardCode.status, 'ready');
  assert.deepEqual(standardCode.inputs.map((item) => item.name), ['plan.md']);

  const invalid = fixture({ 'analysis.md': '# Analysis\n', 'plan.md': '# Plan\n' });
  const rejected = resolveArtifactContext(TASK_ID, 'plan', { repoRoot: invalid.repoRoot });
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error?.code, 'LIFECYCLE_PATH_INVALID');
});

test('artifact context accepts available inputs without qualification authorization', () => {
  const f = fixture({
    'analysis.md': '# analysis\n',
    'review-analysis.md': '**\u5ba1\u67e5\u8f93\u5165**\uff1a`analysis.md`\n',
    'plan.md': '# plan\n',
    'review-plan.md': '**\u5ba1\u67e5\u8f93\u5165**\uff1a`plan.md`\n'
  });
  enableQualification(f);
  addReceipt(f, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(f.taskDir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  addReceipt(f, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });

  const recovery = resolveArtifactContext(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(recovery.status, 'ready');
  assert.deepEqual(recovery.inputs.map((item) => item.name), ['review-analysis.md']);

  const required = resolveArtifactContext(TASK_ID, 'review-plan', { repoRoot: f.repoRoot });
  assert.equal(required.status, 'failed');
  assert.equal(required.error?.code, 'LIFECYCLE_PATH_INVALID');


  writeQualifiedArtifact(f, 'analysis.md');
  const planRecovery = resolveArtifactContext(TASK_ID, 'plan', { repoRoot: f.repoRoot });
  assert.equal(planRecovery.status, 'ready');
  assert.deepEqual(planRecovery.inputs.map((item) => item.name), ['analysis.md', 'review-analysis.md', 'review-plan.md']);
});

test('artifact context treats qualification data as context outside analysis and plan', () => {
  const codeFixture = fixture({ 'analysis.md': STANDARD_ANALYSIS, 'plan.md': '# plan\n', 'code.md': '# legacy code\n' });
  enableQualification(codeFixture);
  writeQualifiedArtifact(codeFixture, 'plan.md');
  const code = resolveArtifactContext(TASK_ID, 'code', { repoRoot: codeFixture.repoRoot });
  assert.equal(code.status, 'ready');

  const reviewCodeFixture = fixture({
    'analysis.md': STANDARD_ANALYSIS,
    'code.md': '# code\n',
    'plan.md': '# plan\n',
    'review-plan.md': '**\u5ba1\u67e5\u8f93\u5165**\uff1a`plan.md`\n'
  });
  enableQualification(reviewCodeFixture);
  writeQualifiedArtifact(reviewCodeFixture, 'code.md');
  const reviewCode = resolveArtifactContext(TASK_ID, 'review-code', { repoRoot: reviewCodeFixture.repoRoot });
  assert.equal(reviewCode.status, 'ready');

  for (const family of ['manual-validation', 'validation-run'] as const) {
    const f = fixture({ 'analysis.md': STANDARD_ANALYSIS, 'review-code.md': '# legacy review code\n' });
    enableQualification(f);
    const result = resolveArtifactContext(TASK_ID, family, { repoRoot: f.repoRoot });
    assert.equal(result.status, 'ready');
  }
});

test('review references remain optional context after input content changes', () => {
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
  assert.equal(changed.status, 'ready');
});

test('change-request reviews create only while they target the latest artifact', () => {
  const scenarios: Array<{
    family: 'analysis' | 'plan';
    reviewFamily: 'review-analysis' | 'review-plan';
    files: Record<string, string>;
    reviewed: string;
  }> = [
    {
      family: 'analysis' as const,
      reviewFamily: 'review-analysis' as const,
      files: {
        'analysis.md': '# analysis\n',
        'analysis-r2.md': '# revised analysis\n',
        'review-analysis.md': '## 审查摘要\n\n- **总体结论**：需要修改\n- **发现（AI 可处理）**：0 阻塞项，1 主要，0 次要 / **人工校验**：0\n'
      },
      reviewed: 'analysis.md'
    },
    {
      family: 'plan' as const,
      reviewFamily: 'review-plan' as const,
      files: {
        'analysis.md': STANDARD_ANALYSIS,
        'plan.md': '# plan\n',
        'plan-r2.md': '# revised plan\n',
        'review-plan.md': '## 审查摘要\n\n- **总体结论**：需要修改\n- **发现（AI 可处理）**：0 阻塞项，1 主要，0 次要 / **人工校验**：0\n'
      },
      reviewed: 'plan.md'
    }
  ];
  for (const scenario of scenarios) {
    const f = fixture(scenario.files);
    if (scenario.family === 'plan') addReceipt(f, {
      event: 'plan.completed', output: 'plan-r2.md', input: 'analysis.md',
      inputSha256: sha256File(path.join(f.taskDir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
    });
    const review = `${scenario.reviewFamily}.md`;
    addReceipt(f, {
      event: `${scenario.reviewFamily}.completed`, output: review, input: scenario.reviewed,
      inputSha256: sha256File(path.join(f.taskDir, scenario.reviewed)), completedAt: '2026-01-01 00:00:00+00:00'
    });

    const result = resolveArtifactContext(TASK_ID, scenario.family, { repoRoot: f.repoRoot });
    assert.equal(result.status, 'ready', JSON.stringify(result.error));
    assert.equal(result.selection?.disposition, 'reuse', scenario.family);
  }

  const current = fixture({
    'analysis.md': '# analysis\n',
    'review-analysis.md': '## 审查摘要\n\n- **总体结论**：需要修改\n- **发现（AI 可处理）**：0 阻塞项，1 主要，0 次要 / **人工校验**：0\n'
  });
  addReceipt(current, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(current.taskDir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  assert.equal(
    resolveArtifactContext(TASK_ID, 'analysis', { repoRoot: current.repoRoot }).selection?.disposition,
    'create'
  );
});

test('standard-path code replan routing compares plan content with the code input receipt', () => {
  const f = fixture({
    'analysis.md': STANDARD_ANALYSIS,
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
  assert.equal(result.codeMode?.reviewArtifact, null);
});

test('code fix routing trusts the review receipt when code and review family rounds differ', () => {
  const f = fixture();
  enableQualification(f);
  writeQualifiedArtifact(f, 'analysis.md');
  writeQualifiedArtifact(f, 'plan.md');
  writeQualifiedArtifact(f, 'code.md');
  writeQualifiedArtifact(f, 'code-r2.md');
  writeQualifiedArtifact(f, 'review-code.md');
  fs.appendFileSync(path.join(f.taskDir, 'review-code.md'), [
    '', '- **审查输入**：', '  - `code-r2.md`', '', '## 审查摘要', '',
    '- **总体结论**：需要修改',
    '- **发现（AI 可处理）**：0 阻塞项，1 主要，0 次要 / **人工校验**：0', ''
  ].join('\n'));
  recordFixtureCompletions(f.taskDir);
  addReceipt(f, {
    event: 'code.completed', output: 'code-r2.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  addReceipt(f, {
    event: 'review-code.completed', output: 'review-code.md', input: 'code-r2.md',
    inputSha256: sha256File(path.join(f.taskDir, 'code-r2.md')), completedAt: '2026-01-01 00:01:00+00:00'
  });

  const result = resolveArtifactContext(TASK_ID, 'code', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready');
  assert.equal(result.codeMode?.mode, 'fix');
  assert.equal(result.codeMode?.reviewArtifact, 'review-code.md');
});

test('code selection reuses completed work without explicit change evidence', () => {
  const f = fixture({ 'analysis.md': STANDARD_ANALYSIS, 'plan.md': '# plan\n', 'code.md': '# code\n' });
  addReceipt(f, {
    event: 'code.completed', output: 'code.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const unchanged = resolveArtifactContext(TASK_ID, 'code', { repoRoot: f.repoRoot });
  assert.equal(unchanged.status, 'ready');
  assert.equal(unchanged.selection?.disposition, 'reuse');
});

test('code selection creates a new round for explicit change evidence', () => {
  const f = fixture({ 'analysis.md': STANDARD_ANALYSIS, 'plan.md': '# plan\n', 'code.md': '# code\n' });
  addReceipt(f, {
    event: 'code.completed', output: 'code.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.taskDir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const result = resolveArtifactContext(TASK_ID, 'code', {
    repoRoot: f.repoRoot,
    sourceFinding: 'CD-1',
    sourceArtifact: 'review-code.md',
    sourceSha256: 'a'.repeat(64)
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.selection?.disposition, 'create');
  assert.equal(result.selection?.artifact.name, 'code-r2.md');
});

test('revision context does not use file timestamps as authorization', () => {
  const f = fixture({ 'analysis.md': '# analysis', 'review-analysis.md': '**Review Input**: `analysis.md`\n' });
  const reviewPath = path.join(f.taskDir, 'review-analysis.md');
  const analysisPath = path.join(f.taskDir, 'analysis.md');
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(reviewPath, past, past);
  const future = new Date(Date.now());
  fs.utimesSync(analysisPath, future, future);
  const result = resolveArtifactContext(TASK_ID, 'analysis', { repoRoot: f.repoRoot });
  assert.equal(result.status, 'ready');
});
