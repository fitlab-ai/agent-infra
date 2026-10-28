import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTempDir, INTERNAL_CLI_PATH, recordArtifactCompletions, sandboxControlSafeEnv, taskWorkspaceProject } from '../../helpers.ts';
import '../../../lib/task/events.ts';
import { verifyTaskEvent } from '../../../lib/task/verification.ts';
import { applyHumanDecision } from '../../../lib/task/decision-intents.ts';
import { parseReworkIntentDocument } from '../../../lib/task/rework-intent.ts';
import { buildLifecycleFacts } from '../../../lib/task/capabilities.ts';
import { parseArtifactName as parseQualificationArtifactName } from '../../../lib/task/artifact-name.ts';
import { parseArtifactReceipts, upsertArtifactReceipt, type ArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import {
  finalizeLocalArtifact,
  validateLocalArtifact,
  type LocalArtifactFamily
} from '../../../lib/task/local-artifact-finalization.ts';
import { buildQualificationAudit, renderQualificationAudit } from '../../../lib/task/qualification-audit.ts';
import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import { snapshotReview } from '../../../lib/git/review-snapshot.ts';
import { resolvePostReviewGlobs } from '../../../lib/task/review-fingerprint.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { hasValidArtifactCompletion } from '../../../lib/task/completion-facts.ts';
import { inspectArtifactDirectory } from '../../../lib/task/artifact-lifecycle.ts';

const FULL_ANALYSIS = '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：完整路径。\n- **判定依据**：夹具覆盖完整生命周期。\n- **未满足的更高路径条件**：没有更高路径。\n- **升级触发条件**：生命周期事实发生变化。\n';

function lifecycleInput(name: string, suffix = ''): string {
  return name.startsWith('analysis') ? `${FULL_ANALYSIS}${suffix}` : `# ${name}${suffix}\n`;
}
test('review completion accepts the current valid review artifact', () => {
  const f = fixture('requirement-analysis-review');
  try {
    const started = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
    assert.equal(started.status, 0, started.stdout || started.stderr);
    fs.writeFileSync(path.join(f.dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md'));
    const completed = run(f.root, [
      f.id, 'review-analysis.completed', '--agent', 'codex', '--initiator', 'model',
      '--request-id', `${f.id}:review-analysis`, '--reason-code', 'user-request',
      '--artifact', 'review-analysis.md', '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
    ]);
    assert.equal(completed.status, 0, completed.stdout || completed.stderr);
    assert.equal(JSON.parse(completed.stdout).toStep, 'requirement-analysis-review');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('started lifecycle events ignore malformed legacy invalidation history', () => {
  const f = fixture('requirement-analysis');
  try {
    fs.appendFileSync(f.file, '\n## 产物失效记录\n\nnot a valid legacy table\n');
    const started = run(f.root, [f.id, 'analyze.started', '--agent', 'codex']);
    assert.equal(started.status, 0, started.stdout || started.stderr);
    assert.match(fs.readFileSync(f.file, 'utf8'), /not a valid legacy table/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

function enableQualification(taskPath: string) {
  fs.appendFileSync(taskPath, `\n## \u7ea6\u675f\n\n| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| C-1 | Keep recovery bounded | derived | task-input | task.md | task.md#\u7ea6\u675f |  |  |\n\n## \u5019\u9009\u4e0e\u5426\u51b3\u65b9\u6848\n\n| candidate_id | statement | status | constraint_ids | impact | evidence |\n| --- | --- | --- | --- | --- | --- |\n| A | Rebuild the earliest stale stage | qualified | C-1 | bounded recovery | task.md#\u5019\u9009\u4e0e\u5426\u51b3\u65b9\u6848 |\n`);
}

function writeQualifiedArtifact(taskPath: string, artifactPath: string) {
  const taskContent = fs.readFileSync(taskPath, 'utf8');
  const identity = parseQualificationArtifactName(path.basename(artifactPath));
  if (!identity || identity.family === 'manual-validation' || identity.family === 'validation-run' || identity.family === 'pr-review') return;
  const built = buildQualificationAudit(taskContent);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const taskId = taskContent.match(/^id:\s*(TASK-\d{8}-\d{6})\s*$/m)?.[1] ?? 'TASK-20260101-000001';
  const family = identity.family;
  let content = renderArtifactSkeleton({ taskId, family, artifact: path.basename(artifactPath) }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  if (family === 'analysis') {
    content = content.replace(
      '## 流程裁定\n<!-- artifact-section:analysis:flow-decision -->\n内容',
      '## 流程裁定\n<!-- artifact-section:analysis:flow-decision -->\n- **本任务路径**：完整路径。\n- **判定依据**：夹具覆盖完整生命周期。\n- **未满足的更高路径条件**：没有更高路径。\n- **升级触发条件**：生命周期事实发生变化。'
    );
  }
  content = content.replace(`## 状态核对\n<!-- artifact-section:${family}:state-check -->\n内容`, `## 状态核对\n<!-- artifact-section:${family}:state-check -->\n\`\`\`text\nagent-infra-internal task-snapshot TASK-20260101-000001 --format text\n\`\`\``);
  content = appendReviewContract(content, family);
  fs.writeFileSync(artifactPath, `${content}\n## 资格审计\n\n${renderQualificationAudit(built.audit)}\n`);
}

function appendReviewContract(content: string, family: string): string {
  if (!family.startsWith('review-')) return content;
  let result = `${content}\n### 审查决定\n通过\n`;
  if (family === 'review-code') {
    result += [
      '- **总体结论**：通过',
      '- **审查基线提交**：`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`',
      '- **审查差异基线**：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '- **审查差异指纹**：sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      '- **审查快照树**：dddddddddddddddddddddddddddddddddddddddd'
    ].join('\n') + '\n';
  }
  return result;
}

function fixture(step = 'requirement-analysis-review') {
  const explicitStep = arguments.length > 0;
  const root = createTempDir('task-event-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\n');
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents/.airc.json'), JSON.stringify({ project: taskWorkspaceProject(root), delivery: { remote: 'origin', baseRef: 'main' } }) + '\n');
  spawnSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Codex'], { cwd: root });
  spawnSync('git', ['add', '.gitignore', '.agents/.airc.json'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'fixture baseline'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(taskWorkspaceRoot(root),  'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nstatus: active\ncurrent_step: ${step}\nassigned_to: claude\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.9.11-alpha.0\ndelivery_remote: origin\ndelivery_base_ref: main\n---\n\n# Task\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), FULL_ANALYSIS);
  if (['technical-design-review', 'code', 'code-review', 'commit'].includes(step)) {
    fs.writeFileSync(path.join(dir, 'plan.md'), lifecycleInput('plan.md'));
  }
  if (['code-review', 'commit'].includes(step)) {
    fs.writeFileSync(path.join(dir, 'code.md'), lifecycleInput('code.md'));
  }
  if ((!explicitStep && step === 'requirement-analysis-review') || step === 'commit') {
    fs.writeFileSync(path.join(dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md'));
    addReceipt(path.join(dir, 'task.md'), {
      event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
      inputSha256: sha256File(path.join(dir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
    });
  }
  if (step === 'code-review' || step === 'commit') {
    fs.writeFileSync(path.join(dir, 'code.md'), '# Code\n');
    fs.writeFileSync(path.join(dir, 'review-code.md'), reviewCodeArtifact());
    addReceipt(path.join(dir, 'task.md'), {
      event: 'review-code.completed', output: 'review-code.md', input: 'code.md',
      inputSha256: sha256File(path.join(dir, 'code.md')), completedAt: '2026-01-01 00:00:00+00:00'
    });
  }
  const actions: Record<string, string> = {
    analysis: 'Analyze Task', 'review-analysis': 'Review Analysis', plan: 'Plan Task',
    'review-plan': 'Review Plan', code: 'Code Task', 'review-code': 'Review Code'
  };
  const completedNames = fs.readdirSync(dir).filter((name) => parseQualificationArtifactName(name)
    && actions[parseQualificationArtifactName(name)!.family] !== undefined
    && !(step === 'requirement-analysis' && name === 'analysis.md'))
    .sort((left, right) => {
      const a = parseQualificationArtifactName(left)!; const b = parseQualificationArtifactName(right)!;
      return a.family.localeCompare(b.family) || a.round - b.round;
    });
  if (completedNames.length > 0) {
    const identities = completedNames.map((name) => parseQualificationArtifactName(name)!);
    const findInput = (family: string, round?: number) => {
      const matches = identities.filter((identity) => identity.family === family
        && (round === undefined || identity.round === round));
      return (matches.at(-1) ?? identities.filter((identity) => identity.family === family).at(-1))?.name;
    };
    recordArtifactCompletions(dir, identities.map((identity) => {
      const input = identity.family === 'analysis' ? undefined
        : identity.family === 'review-analysis' ? findInput('analysis', identity.round)
        : identity.family === 'plan' ? findInput('review-analysis', identity.round) ?? findInput('analysis')
        : identity.family === 'review-plan' ? findInput('plan', identity.round)
        : identity.family === 'code' ? findInput('plan') ?? findInput('analysis')
        : identity.family === 'review-code' ? findInput('code')
        : undefined;
      return { name: identity.name, lifecycleInputs: input ? [input] : [] };
    }));
  }
  return { root, id, dir, file: path.join(dir, 'task.md') };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = sandboxControlSafeEnv()) {
  const event = args[1] ?? '';
  const lifecycle = /^(?:analyze|review-analysis|plan|review-plan|code|review-code|manual-validation|validation-run)\.(?:started|completed)$/.test(event);
  const hasTrigger = ['--initiator', '--request-id', '--reason-code'].some((flag) => args.includes(flag));
  const family = event.split('.')[0] ?? 'event';
  const trigger = lifecycle && !hasTrigger
    ? ['--initiator', 'model', '--request-id', `${args[0]}:${family}`, '--reason-code', 'user-request']
    : [];
  if (event === 'review-code.completed') {
    const artifactIndex = args.indexOf('--artifact');
    const artifact = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
    if (artifact) bindReviewIdentity(root, args[0]!, artifact);
  }
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', ...args, ...trigger], { cwd: root, encoding: 'utf8', env });
}

function bindReviewIdentity(root: string, taskId: string, artifact: string): void {
  const reportPath = path.join(taskWorkspaceRoot(root),  'active', taskId, artifact);
  if (!fs.existsSync(reportPath)) return;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const reviewed = snapshotReview({ cwd: root, mode: 'worktree', baseline: head, diffBase: head, globs: resolvePostReviewGlobs({}, {}) });
  let report = fs.readFileSync(reportPath, 'utf8')
    .replace(/^- \*\*审查目标提交\*\*：.*$/mu, `- **审查目标提交**：${head}`)
    .replace(/^- \*\*审查基线提交\*\*：.*$/mu, `- **审查基线提交**：\`${head}\``)
    .replace(/^- \*\*审查差异基线\*\*：.*$/mu, `- **审查差异基线**：${head}`)
    .replace(/^- \*\*审查差异指纹\*\*：.*$/mu, `- **审查差异指纹**：${reviewed.fingerprint}`)
    .replace(/^- \*\*审查快照树\*\*：.*$/mu, `- **审查快照树**：${reviewed.tree}`);
  if (!/^- \*\*审查目标提交\*\*：/mu.test(report)) {
    report = report.replace('## 审查摘要\n', `## 审查摘要\n\n- **审查目标提交**：${head}\n`);
  }
  if (!/^- \*\*审查已检视提交\*\*：/mu.test(report)) {
    report = report.replace('## 审查摘要\n', `## 审查摘要\n\n- **审查已检视提交**：${head}\n`);
  }
  fs.writeFileSync(reportPath, report);
}

function finalizeReview(
  f: ReturnType<typeof fixture>,
  scenario: { stage: string; artifact: string }
) {
  return spawnSync('node', [
    INTERNAL_CLI_PATH, 'task-review', f.id, 'finalize-summary', '--stage', scenario.stage,
    '--artifact', scenario.artifact
  ], { cwd: f.root, encoding: 'utf8', env: sandboxControlSafeEnv() });
}

function inspect(root: string, args: string[]) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-artifact', ...args], { cwd: root, encoding: 'utf8', env: sandboxControlSafeEnv() });
}

function reviewCodeArtifact(input = 'code.md') {
  let content = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family: 'review-code', artifact: 'review-code.md' }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  content = content.replace('## 审查摘要\n<!-- artifact-section:review-code:summary -->\n内容', `## 审查摘要\n<!-- artifact-section:review-code:summary -->\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n- **审查输入**：\`${input}\``);
  return appendReviewContract(content.replace('## 证据原文\n<!-- artifact-section:review-code:evidence -->\n内容', '## 证据原文\n<!-- artifact-section:review-code:evidence -->\n```text\nagent-infra-internal task-snapshot TASK-20260101-000001 --format text\n```'), 'review-code');
}

function reviewArtifact(
  title: string,
  input: string,
  verdict = '通过',
  counts: ReviewCounts = { blockers: 0, major: 0, minor: 0 }
) {
  const family = title.includes('Plan') ? 'review-plan' : title.includes('Code') ? 'review-code' : 'review-analysis';
  let content = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family, artifact: `${family}.md` }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  content = content.replace(`## 审查摘要\n<!-- artifact-section:${family}:summary -->\n内容`, `## 审查摘要\n<!-- artifact-section:${family}:summary -->\n- **总体结论**：${verdict}\n- **发现（AI 可处理）**：${counts.blockers} 阻塞项，${counts.major} 主要，${counts.minor} 次要 / **人工校验**：0\n- **审查输入**：\`${input}\``);
  return appendReviewContract(content.replace(`## 证据原文\n<!-- artifact-section:${family}:evidence -->\n内容`, `## 证据原文\n<!-- artifact-section:${family}:evidence -->\n\`\`\`text\nagent-infra-internal task-snapshot TASK-20260101-000001 --format text\n\`\`\``), family);
}

function sha256File(filePath: string) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function localArtifact(family: LocalArtifactFamily, suffix = '', artifact = `${family}.md`) {
  let content = renderArtifactSkeleton({ taskId: 'TASK-20260101-000001', family, artifact }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  if (family === 'analysis') {
    content = content.replace(
      '## 流程裁定\n<!-- artifact-section:analysis:flow-decision -->\n内容',
      '## 流程裁定\n<!-- artifact-section:analysis:flow-decision -->\n- **本任务路径**：完整路径。\n- **判定依据**：夹具覆盖完整生命周期。\n- **未满足的更高路径条件**：没有更高路径。\n- **升级触发条件**：生命周期事实发生变化。'
    );
  }
  content = content.replace(`## 状态核对\n<!-- artifact-section:${family}:state-check -->\n内容`, `## 状态核对\n<!-- artifact-section:${family}:state-check -->\n\`\`\`text\nagent-infra-internal task-snapshot TASK-20260101-000001 --format text\n\`\`\``);
  if (family === 'code') content = content.replace('## 证据原文\n<!-- artifact-section:code:evidence -->\n内容', '## 证据原文\n<!-- artifact-section:code:evidence -->\n验证输出');
  return `${content}${suffix}`;
}

function completionDigestArgs(repoRoot: string, dir: string, artifact: string, family: LocalArtifactFamily): string[] {
  const result = finalizeLocalArtifact({
    taskRef: path.basename(dir),
    repoRoot,
    family,
    artifact
  });
  assert.equal(result.status, 'passed', result.error?.message);
  return ['--artifact-sha256', result.artifactSha256!, '--semantic-digest', result.semanticDigest!];
}

function addReceipt(file: string, receipt: ArtifactReceipt) {
  const content = fs.readFileSync(file, 'utf8');
  const mutation = upsertArtifactReceipt(content, receipt);
  fs.writeFileSync(file, upsertSection(content, mutation).content);
}

function fixtureSource(taskDir: string, family: string, round?: number): string | undefined {
  const candidates = fs.readdirSync(taskDir).map((candidate) => parseQualificationArtifactName(candidate))
    .filter((candidate) => candidate?.family === family && (round === undefined || candidate.round === round));
  if (candidates.length) return candidates.at(-1)?.name;
  return fs.readdirSync(taskDir).map((candidate) => parseQualificationArtifactName(candidate))
    .filter((candidate) => candidate?.family === family).at(-1)?.name;
}

function fixtureInputs(taskDir: string, family: string, round: number): string[] {
  switch (family) {
    case 'analysis': return [];
    case 'review-analysis': return [fixtureSource(taskDir, 'analysis', round)].filter((name): name is string => Boolean(name));
    case 'plan': return [fixtureSource(taskDir, 'analysis'), fixtureSource(taskDir, 'review-analysis')]
      .filter((name): name is string => Boolean(name));
    case 'review-plan': return [fixtureSource(taskDir, 'plan', round)].filter((name): name is string => Boolean(name));
    case 'code': return [fixtureSource(taskDir, 'plan') ?? fixtureSource(taskDir, 'analysis')]
      .filter((name): name is string => Boolean(name));
    case 'review-code': return [fixtureSource(taskDir, 'code')].filter((name): name is string => Boolean(name));
    default: return [];
  }
}

function recordFixtureCompletion(taskDir: string, name: string) {
  const identity = parseQualificationArtifactName(name);
  if (!identity || identity.family === 'manual-validation' || identity.family === 'validation-run' || identity.family === 'pr-review') return;
  const artifactPath = path.join(taskDir, name);
  const artifactContent = fs.readFileSync(artifactPath, 'utf8');
  const taskPath = path.join(taskDir, 'task.md');
  let task = fs.readFileSync(taskPath, 'utf8');
  const current = task.match(/^completion_facts: '(.+)'$/m)?.[1];
  const facts = current ? JSON.parse(current) as Array<{ output?: string }> : [];
  const event = identity.family === 'analysis' ? 'analyze.completed' : `${identity.family}.completed`;
  const inputs = fixtureInputs(taskDir, identity.family, identity.round);
  const fact = {
    event, output: name, outputSha256: sha256File(artifactPath), semanticDigest: canonicalSemanticDigest(artifactContent),
    requestId: `fixture-${name}`, result: 'completed',
    lifecycleInputs: inputs.map((input) => ({ name: input, sha256: sha256File(path.join(taskDir, input)) }))
  };
  const nextFacts = [...facts.filter((existing) => existing.output !== name), fact];
  task = /^completion_facts:.*$/m.test(task)
    ? task.replace(/^completion_facts:.*$/m, `completion_facts: '${JSON.stringify(nextFacts)}'`)
    : task.replace(/\n---\n/u, `\ncompletion_facts: '${JSON.stringify(nextFacts)}'\n---\n`);
  const receiptEvent = identity.family === 'analysis' ? 'analysis.completed' : event;
  const escapedEvent = receiptEvent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedOutput = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  task = task.replace(new RegExp(`^\\| ${escapedEvent} \\| ${escapedOutput} \\|[^\\n]*\\n?`, 'gmu'), '');
  fs.writeFileSync(taskPath, task);
  for (const input of inputs) addReceipt(taskPath, {
    event: receiptEvent as ArtifactReceipt['event'], output: name, input,
    inputSha256: sha256File(path.join(taskDir, input)), completedAt: '2026-01-01 00:00:00+00:00'
  });
  task = fs.readFileSync(taskPath, 'utf8');
  const actions: Record<string, string> = {
    analysis: 'Analyze Task', 'review-analysis': 'Review Analysis', plan: 'Plan Task',
    'review-plan': 'Review Plan', code: 'Code Task', 'review-code': 'Review Code'
  };
  const step = `${actions[identity.family]} (Round ${identity.round})`;
  const startedSecond = String(identity.round * 2).padStart(2, '0');
  const completedSecond = String(identity.round * 2 + 1).padStart(2, '0');
  const log = [
    `- 2026-01-01 00:00:${startedSecond}+00:00 — **${step} [started]** by codex — started`,
    `- 2026-01-01 00:00:${completedSecond}+00:00 — **${step}** by codex — completed → ${name}`
  ].join('\n');
  task = /## Activity Log\n/u.test(task)
    ? task.replace('## Activity Log\n', `## Activity Log\n\n${log}\n`)
    : `${task}\n## Activity Log\n\n${log}\n`;
  fs.writeFileSync(taskPath, task);
}

function codeReport(plan = 'plan.md') {
  return localArtifact('code').replace(
    '## 实现输入\n<!-- artifact-section:code:input -->\n内容',
    `## 实现输入\n<!-- artifact-section:code:input -->\n- **模式**：init\n- **方案输入**：\`${plan}\`\n- **审查输入**：\`N/A\`\n- **裁决输入**：N/A\n- **账本 ID**：N/A\n- **裁决证据**：N/A\n- **需求摘要**：完成实现报告门禁\n`
  );
}

type ReviewCounts = { blockers: number; major: number; minor: number };

const reviewScenarios = [
  {
    family: 'review-analysis', stage: 'analysis', step: 'requirement-analysis-review',
    input: 'analysis.md', artifact: 'review-analysis.md', title: 'Analysis Review', findingId: 'AN-1'
  },
  {
    family: 'review-plan', stage: 'plan', step: 'technical-design-review',
    input: 'plan.md', artifact: 'review-plan.md', title: 'Plan Review', findingId: 'PL-1'
  },
  {
    family: 'review-code', stage: 'code', step: 'code',
    input: 'code.md', artifact: 'review-code.md', title: 'Code Review', findingId: 'CD-1'
  }
] as const;

function setLedger(file: string, rows: string[]) {
  const content = fs.readFileSync(file, 'utf8');
  const ledger = [
    '## Review Disagreement Ledger',
    '',
    '| id | stage | round | severity | status | evidence |',
    '|----|-------|-------|----------|--------|----------|',
    ...rows,
    ''
  ].join('\n');
  const existing = /## Review Disagreement Ledger\n\n\| id \| stage \| round \| severity \| status \| evidence \|\n\|----\|-------\|-------\|----------\|--------\|----------\|\n[\s\S]*?(?=## Activity Log)/;
  fs.writeFileSync(file, content.replace(existing, ledger));
}

function prepareReview(
  scenario: (typeof reviewScenarios)[number],
  rows: string[],
  verdict = '通过',
  counts: ReviewCounts = { blockers: 0, major: 0, minor: 0 }
) {
  const f = fixture(scenario.step);
  fs.writeFileSync(path.join(f.dir, scenario.input), lifecycleInput(scenario.input));
  recordFixtureCompletion(f.dir, scenario.input);
  setLedger(f.file, rows);
  const started = run(f.root, [f.id, `${scenario.family}.started`, '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(
    path.join(f.dir, scenario.artifact),
    reviewArtifact(scenario.title, scenario.input, verdict, counts)
  );
  return f;
}

function completeReview(
  f: ReturnType<typeof fixture>,
  scenario: (typeof reviewScenarios)[number],
  verdict: 'approved' | 'changes-requested' | 'rejected',
  counts: ReviewCounts,
  extra: string[] = []
) {
  return run(f.root, [
    f.id, `${scenario.family}.completed`, '--agent', 'codex', '--artifact', scenario.artifact,
    '--verdict', verdict, '--blockers', String(counts.blockers), '--major', String(counts.major),
    '--minor', String(counts.minor), '--manual-validation', '0', ...extra
  ]);
}

function decisionFixture() {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  fs.writeFileSync(f.file, `---
id: ${f.id}
status: active
current_step: code-review
assigned_to: claude
updated_at: 2026-07-18 10:02:00+08:00
agent_infra_version: v0.9.11-alpha.0
last_reviewed_commit: abcdef1234567890
---

# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 实现备注

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|
| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:59:00+08:00 | pending | |

## 产物生命周期收据

| event | output | input | input_sha256 | completed_at |
|-------|--------|-------|--------------|--------------|
| code.completed | code.md | plan.md | ${sha256File(path.join(f.dir, 'plan.md'))} | 2026-07-18 09:58:00+08:00 |

## Activity Log

- 2026-07-18 10:00:00+08:00 — **Review Code (Round 1)** by claude — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md
`);
  addReceipt(f.file, {
    event: 'review-code.completed', output: 'review-code.md', input: 'code.md',
    inputSha256: sha256File(path.join(f.dir, 'code.md')), completedAt: '2026-07-18 10:00:00+08:00'
  });
  recordArtifactCompletions(f.dir, [
    { name: 'analysis.md', lifecycleInputs: [] },
    { name: 'plan.md', lifecycleInputs: ['analysis.md'] },
    { name: 'code.md', lifecycleInputs: ['plan.md'] },
    { name: 'review-code.md', lifecycleInputs: ['code.md'] }
  ]);
  const taskContent = fs.readFileSync(f.file, 'utf8');
  for (const [name, event] of [
    ['analysis.md', 'analyze.completed'], ['plan.md', 'plan.completed'],
    ['code.md', 'code.completed'], ['review-code.md', 'review-code.completed']
  ] as const) assert.equal(hasValidArtifactCompletion(taskContent, f.dir, name, event), true, `${name} completion fixture must be valid`);
  const reviewCode = inspectArtifactDirectory(f.dir, 'review-code');
  assert.equal(reviewCode.status, 'ready', JSON.stringify(reviewCode.error));
  assert.equal(reviewCode.latest?.name, 'review-code.md');
  return f;
}

test('internal task-event rejects a non-standard --agent token', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.started', '--agent', 'devuser']);
  assert.equal(out.status, 1);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EVENT_PAYLOAD_INVALID');
  assert.match(result.error.message, /invalid --agent 'devuser'/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('internal task-event normalizes a long --agent to the short token on write', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'claude-code']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /by claude — started/);
  assert.match(content, /assigned_to: claude/);
});

test('internal task-event accepts the human manual-executor token', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'human']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  assert.match(fs.readFileSync(f.file, 'utf8'), /by human — started/);
});

test('internal task-event keeps a blocked task state mismatch closed', () => {
  const root = createTempDir('task-event-override-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000002';
  const dir = path.join(taskWorkspaceRoot(root),  'blocked', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nstatus: blocked\ncurrent_step: requirement-analysis-review\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: v0.0.0\n---\n\n# Task\n\n## Activity Log\n\n`);
  try {
    const before = fs.readFileSync(path.join(dir, 'task.md'));
    const applied = spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', id, 'analyze.started',
      '--agent', 'codex', '--initiator', 'model', '--request-id', `blocked:${id}:analyze`, '--reason-code', 'user-request'
    ], { cwd: root, encoding: 'utf8', env: sandboxControlSafeEnv() });
    assert.equal(applied.status, 1, applied.stderr || applied.stdout);
    const result = JSON.parse(applied.stdout) as { status: string; error: { code: string } };
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'TASK_STATE_MISMATCH');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'task.md')), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('internal task-event applies a started/completed pair and replays as no-op', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', ...completionDigestArgs(f.root, f.dir, 'plan.md', 'plan')]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).toStep, 'technical-design');
  const beforeReplay = fs.readFileSync(f.file, 'utf8');
  const replayed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', ...completionDigestArgs(f.root, f.dir, 'plan.md', 'plan')]);
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(f.file, 'utf8'), beforeReplay);
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /`plan\.md`/);
  assert.deepEqual(parseArtifactReceipts(content).rows.filter((row) => row.output === 'plan.md').map((row) => row.input), ['analysis.md', 'review-analysis.md']);
});

test('completed replay uses the valid completion fact when its done row is missing or malformed', () => {
  for (const doneRow of ['missing', 'malformed']) {
    const f = fixture();
    try {
      const requestId = `${f.id}:plan-completion-replay`;
      const trigger = ['--initiator', 'model', '--request-id', requestId, '--reason-code', 'user-request'];
      const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']);
      assert.equal(started.status, 0, started.stderr || started.stdout);
      fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
      const completedArgs = [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', ...trigger,
        ...completionDigestArgs(f.root, f.dir, 'plan.md', 'plan')];
      const completed = run(f.root, completedArgs);
      assert.equal(completed.status, 0, completed.stderr || completed.stdout);
      assert.equal(JSON.parse(completed.stdout).status, 'applied');

      const task = fs.readFileSync(f.file, 'utf8');
      const changedLog = task.split('\n').filter((line) => {
        if (!line.includes('**Plan Task (Round 1)**')) return true;
        return doneRow === 'malformed';
      }).map((line) => doneRow === 'malformed' && line.includes('**Plan Task (Round 1)**')
        ? '- malformed completion row' : line).join('\n');
      assert.notEqual(changedLog, task);
      fs.writeFileSync(f.file, changedLog);

      const replayed = run(f.root, completedArgs);
      assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
      assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
      assert.equal(fs.readFileSync(f.file, 'utf8'), changedLog);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('plan completion gate allows a valid plan to resume after review-plan advances current_step', async () => {
  const f = fixture();
  try {
    const configDir = path.join(f.root, '.agents', 'skills', 'plan-task', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), '.agents', 'skills', 'plan-task', 'config', 'verify.json'), path.join(configDir, 'verify.json'));
    const content = fs.readFileSync(f.file, 'utf8').replace(
      `id: ${f.id}`,
      `id: ${f.id}\ntype: bugfix\nworkflow: bug-fix\ncreated_at: '2026-01-01 00:00:00+00:00'\nbranch: ${taskWorkspaceProject(f.root)}-bugfix-lifecycle-resume-fixture`
    );
    fs.writeFileSync(f.file, content);
    assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1']).status, 0);
    fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
    const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', ...completionDigestArgs(f.root, f.dir, 'plan.md', 'plan')]);
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(run(f.root, [f.id, 'review-plan.started', '--agent', 'codex', '--round', '1']).status, 0);
    fs.writeFileSync(path.join(f.dir, 'review-plan.md'), reviewArtifact('Plan Review', 'plan.md'));
    const reviewCompleted = run(f.root, [f.id, 'review-plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'review-plan.md', '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0']);
    assert.equal(reviewCompleted.status, 0, reviewCompleted.stderr || reviewCompleted.stdout);
    const codeStarted = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--initiator', 'model', '--request-id', `${f.id}:code-resume`, '--reason-code', 'user-request']);
    assert.equal(codeStarted.status, 0, codeStarted.stderr || codeStarted.stdout);

    const verified = await verifyTaskEvent({ taskRef: f.id, event: 'plan.completed', artifact: 'plan.md' }, { repoRoot: f.root });
    assert.equal(verified.status, 'pass', JSON.stringify(verified));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('task-event rejects a different lifecycle start while one execution is open', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);

  const beforeBlocked = fs.readFileSync(f.file);
  const blocked = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
  assert.equal(blocked.status, 1);
  const blockedResult = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
  assert.equal(blockedResult.error.code, 'EVENT_TRANSITION_INVALID');
  assert.match(blockedResult.error.message, /EXECUTION_BUSY/);
  assert.deepEqual(fs.readFileSync(f.file), beforeBlocked);

  const replay = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(f.file), beforeBlocked);
});

test('task-event applies the same execution lock to both manual validation families', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);

  for (const event of ['manual-validation.started', 'validation-run.started']) {
    const blocked = run(f.root, [f.id, event, '--agent', 'codex']);
    assert.equal(blocked.status, 1, blocked.stderr);
    const result = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
    assert.equal(result.error.code, 'EVENT_TRANSITION_INVALID');
    assert.match(result.error.message, /EXECUTION_BUSY/);
  }
});

test('started replay is idempotent despite request identity and input drift', () => {
  const f = fixture();
  const first = run(f.root, [
    f.id, 'plan.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'plan-request-1', '--reason-code', 'user-request'
  ]);
  assert.equal(first.status, 0, first.stderr);

  const requestConflict = run(f.root, [
    f.id, 'plan.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'plan-request-2', '--reason-code', 'user-request'
  ]);
  assert.equal(requestConflict.status, 0, requestConflict.stderr);
  assert.equal(JSON.parse(requestConflict.stdout).status, 'no-op');

  fs.appendFileSync(f.file, '\n## Task Input\n\nChanged after start.\n');
  const drifted = run(f.root, [
    f.id, 'plan.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'plan-request-1', '--reason-code', 'user-request'
  ]);
  assert.equal(drifted.status, 0, drifted.stderr);
  assert.equal(JSON.parse(drifted.stdout).status, 'no-op');
});

test('completion accepts the skill result when task input changes after started', () => {
  const f = fixture();
  const started = run(f.root, [
    f.id, 'plan.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'plan-request-1', '--reason-code', 'user-request'
  ]);
  assert.equal(started.status, 0, started.stderr);
  fs.appendFileSync(f.file, '\n## Task Input\n\nChanged after start.\n');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const digestArgs = completionDigestArgs(f.root, f.dir, 'plan.md', 'plan');
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'plan-request-1', '--reason-code', 'user-request', '--artifact', 'plan.md', ...digestArgs
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
});

test('task-event blocks other lifecycle starts while either manual validation family is open', () => {
  for (const event of ['manual-validation.started', 'validation-run.started']) {
    const f = fixture('code-review');
    const started = run(f.root, [f.id, event, '--agent', 'codex']);
    assert.equal(started.status, 0, started.stdout || started.stderr);

    const blocked = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
    assert.equal(blocked.status, 1, blocked.stderr);
    const result = JSON.parse(blocked.stdout) as { error: { code: string; message: string } };
    assert.equal(result.error.code, 'EVENT_TRANSITION_INVALID');
    assert.match(result.error.message, /EXECUTION_BUSY/);
  }
});

test('manual-validation started persists its transaction identity for idempotent rollover recovery', () => {
  const f = fixture('code-review');
  const args = [f.id, 'manual-validation.started', '--agent', 'codex', '--initiator', 'model', '--request-id', 'mv-generation-1', '--reason-code', 'user-request', '--transaction-id', 'mv-generation-1'];
  const started = run(f.root, args);
  assert.equal(started.status, 0, started.stderr);
  assert.match(fs.readFileSync(f.file, 'utf8'), /Complete Manual Validation \[started\].*started; transaction=mv-generation-1/);

  const replay = run(f.root, args);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).status, 'no-op');

  const conflict = run(f.root, [...args.slice(0, -1), 'mv-generation-2']);
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stdout).error.code, 'EVENT_LOG_CONFLICT');
});

test('standalone manual validation does not require an approved code review', () => {
  for (const event of ['manual-validation.started', 'validation-run.started']) {
    const f = fixture('code-review');
    fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewArtifact('Code Review', 'code.md', '拒绝'));
    const started = run(f.root, [f.id, event, '--agent', 'codex']);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).status, 'applied');
  }
});

test('task-event requires an explicit trigger for lifecycle events', () => {
  const f = fixture('technical-design');
  const before = fs.readFileSync(f.file);
  const out = spawnSync('node', [INTERNAL_CLI_PATH, 'task-event', f.id, 'analyze.started', '--agent', 'codex'], {
    cwd: f.root, encoding: 'utf8', env: sandboxControlSafeEnv()
  });
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).error.code, 'EVENT_TRIGGER_REQUIRED');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('started derives its round and completion rejects an unlanded artifact', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.round, 1);
  assert.equal(startedResult.artifact, 'plan.md');
  const before = fs.readFileSync(f.file);
  const done = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', '--artifact-sha256', '0'.repeat(64), '--semantic-digest', '0'.repeat(64)]);
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).error.code, 'ARTIFACT_NOT_FOUND');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('local completion rejects a stale finalizer digest before mutating task state', () => {
  for (const kind of ['artifactSha256', 'semanticDigest'] as const) {
    const f = fixture();
    assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
    const artifact = path.join(f.dir, 'plan.md');
    fs.writeFileSync(artifact, localArtifact('plan'));
    const digests = completionDigestArgs(f.root, f.dir, 'plan.md', 'plan');
    const stale = kind === 'artifactSha256'
      ? ['--artifact-sha256', '0'.repeat(64), '--semantic-digest', digests[3]!]
      : ['--artifact-sha256', digests[1]!, '--semantic-digest', '0'.repeat(64)];
    const before = fs.readFileSync(f.file);

    const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...stale]);

    assert.equal(completed.status, 1);
    assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
});

test('local completion accepts a valid current artifact without finalizer provenance', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan'));
  const local = validateLocalArtifact(fs.readFileSync(artifact, 'utf8'), { family: 'plan' });
  assert.equal(local.ok, true);
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', sha256File(artifact), '--semantic-digest', local.semanticDigest
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
  assert.match(fs.readFileSync(f.file, 'utf8'), /current_step: technical-design/);
});

test('local completion remains valid after a direct artifact revalidation', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan'));
  const finalized = finalizeLocalArtifact({
    taskRef: f.id,
    repoRoot: f.root,
    family: 'plan',
    artifact: 'plan.md'
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', finalized.artifactSha256!, '--semantic-digest', finalized.semanticDigest!
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
});

test('local completion accepts a direct formal artifact repair', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  fs.writeFileSync(artifact, localArtifact('plan').replace('## 验证策略\n', '## 验证策略：\n'));

  const first = inspect(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(first.status, 1, first.stderr);

  fs.writeFileSync(artifact, fs.readFileSync(artifact, 'utf8').replace('## 验证策略：', '## 验证策略'));
  const second = inspect(f.root, [f.id, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.status, 'passed');

  fs.chmodSync(artifact, 0o644);
  fs.writeFileSync(artifact, `${fs.readFileSync(artifact, 'utf8')}\nexternal mutation\n`);
  const local = validateLocalArtifact(fs.readFileSync(artifact, 'utf8'), { family: 'plan' });
  assert.equal(local.ok, true);
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', sha256File(artifact), '--semantic-digest', local.semanticDigest
  ]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
});

test('local completion uses the repository verification config for its language', () => {
  const f = fixture();
  const configDir = path.join(f.root, '.agents', 'skills', 'plan-task', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'verify.json'), JSON.stringify({
    checks: { artifact: { schema: 'plan' } }
  }));
  assert.equal(run(f.root, [f.id, 'plan.started', '--agent', 'codex']).status, 0);
  const artifact = path.join(f.dir, 'plan.md');
  let content = renderArtifactSkeleton({ taskId: f.id, family: 'plan', artifact: 'plan.md', locale: 'en' }).replaceAll('<!-- artifact-slot:empty -->', 'content');
  content = content.replace('## State Check\n<!-- artifact-section:plan:state-check -->\ncontent', '## State Check\n<!-- artifact-section:plan:state-check -->\n```text\nagent-infra-internal task-snapshot TASK-20260101-000001 --format text\n```');
  fs.writeFileSync(artifact, content);
  const artifactContent = fs.readFileSync(artifact, 'utf8');
  const local = validateLocalArtifact(artifactContent, { family: 'plan' });
  assert.equal(local.ok, true, local.diagnostics.map((item) => item.message).join('; '));
  const finalized = finalizeLocalArtifact({
    taskRef: f.id,
    repoRoot: f.root,
    family: 'plan',
    artifact: 'plan.md'
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);

  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md',
    '--artifact-sha256', finalized.artifactSha256!, '--semantic-digest', finalized.semanticDigest!
  ]);

  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
});

test('completed event preserves source @ content without blocking task state', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan', '\n@2x\n'));
  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.root, f.dir, 'plan.md', 'plan')]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.notDeepEqual(fs.readFileSync(f.file), before);
});

test('started replay keeps the open identity after its artifact lands', () => {
  const f = fixture();
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  const result = JSON.parse(repeated.stdout);
  assert.equal(result.status, 'no-op');
  assert.equal(result.round, 1);
  assert.equal(result.artifact, 'plan.md');
  assert.equal((fs.readFileSync(f.file, 'utf8').match(/Plan Task \(Round 1\) \[started\]/g) ?? []).length, 1);
});

test('valid completion facts close a started row for event mutual exclusion', () => {
  const f = fixture('requirement-analysis');
  recordFixtureCompletion(f.dir, 'analysis.md');
  const task = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(f.file, task.split('\n').filter((line) => !line.includes('**Analyze Task (Round 1)** by codex')).join('\n'));

  const started = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex', '--dry-run']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'planned');
});

test('plan event reopens technical design after commit preparation', () => {
  const f = fixture('commit');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan round 1\n');
  recordFixtureCompletion(f.dir, 'plan.md');

  const started = run(f.root, [
    f.id, 'plan.started', '--agent', 'codex', '--reason-code', 'new-requirement',
    '--request-id', `${f.id}:plan-rework`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'commit');
  assert.equal(startedResult.toStep, 'commit');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'plan-r2.md');

  fs.writeFileSync(path.join(f.dir, 'plan-r2.md'), localArtifact('plan', '', 'plan-r2.md'));
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan-r2.md', ...completionDigestArgs(f.root, f.dir, 'plan-r2.md', 'plan'),
    '--reason-code', 'new-requirement', '--request-id', `${f.id}:plan-rework`, '--initiator', 'human'
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /Plan Task \(Round 2\) \[started\]/);
  assert.match(content, /`plan-r2\.md`/);
});

test('plan event reopens technical design after code review', () => {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md'));
  addReceipt(f.file, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(f.dir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  recordFixtureCompletion(f.dir, 'review-analysis.md');
  const reviewSha = sha256File(path.join(f.dir, 'review-code.md'));
  fs.appendFileSync(f.file, `\n## 返工意图\n\n| intent_id | finding_id | source_artifact | source_sha256 | target | classification | evidence_digest | task_fact_digest | status | declared_at | consumed_at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| RI-1 | CD-1 | review-code.md | ${reviewSha} | plan | design | ${'a'.repeat(64)} | ${'b'.repeat(64)} | pending | 2026-01-01T00:00:00.000Z |  |\n`);

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'code-review');
  assert.equal(startedResult.toStep, 'code-review');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'plan-r2.md');

  fs.writeFileSync(path.join(f.dir, 'plan-r2.md'), localArtifact('plan', '', 'plan-r2.md'));
  const completed = run(f.root, [
    f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan-r2.md', ...completionDigestArgs(f.root, f.dir, 'plan-r2.md', 'plan')
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  const completedResult = JSON.parse(completed.stdout);
  assert.equal(completedResult.fromStep, 'code-review');
  assert.equal(completedResult.toStep, 'technical-design');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: technical-design/);
  assert.match(content, /Plan Task \(Round 1\) \[started\]/);
  assert.match(content, /`plan-r2\.md`/);
});

test('standalone plan start does not require a fresh analysis review', () => {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md'));
  addReceipt(f.file, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(f.dir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  fs.writeFileSync(path.join(f.dir, 'analysis-r2.md'), FULL_ANALYSIS.replace('完整路径', '精简路径'));
  recordFixtureCompletion(f.dir, 'analysis-r2.md');
  const reviewSha = sha256File(path.join(f.dir, 'review-code.md'));
  fs.appendFileSync(f.file, `\n## 返工意图\n\n| intent_id | finding_id | source_artifact | source_sha256 | target | classification | evidence_digest | task_fact_digest | status | declared_at | consumed_at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| RI-1 | CD-1 | review-code.md | ${reviewSha} | plan | design | ${'a'.repeat(64)} | ${'b'.repeat(64)} | pending | 2026-01-01T00:00:00.000Z |  |\n`);

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
});

test('manual validation completion requires coordinator evidence and receipt identity', () => {
  const f = fixture('code-review');
  const started = run(f.root, [f.id, 'manual-validation.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'manual-validation.md'), '# Manual validation\n');
  const done = run(f.root, [f.id, 'manual-validation.completed', '--agent', 'codex', '--artifact', 'manual-validation.md', '--summary-result', 'summary updated']);
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).error.code, 'EVENT_PAYLOAD_INVALID');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Complete Manual Validation \[started\]/);
});

test('dry-run returns planned without changing task bytes for start and completion', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1', '--dry-run']);
  assert.equal(JSON.parse(out.stdout).status, 'planned');
  assert.deepEqual(fs.readFileSync(f.file), before);

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
  const beforeCompletion = fs.readFileSync(f.file);
  const completed = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--artifact', 'plan.md', ...completionDigestArgs(f.root, f.dir, 'plan.md', 'plan'), '--dry-run']);
  const completedResult = JSON.parse(completed.stdout);
  assert.equal(completedResult.status, 'planned');
  assert.equal(completedResult.operations.length, 5);
  assert.deepEqual(fs.readFileSync(f.file), beforeCompletion);
});

test('task-event timestamps keep an ASCII offset in negative-offset timezones', () => {
  const f = fixture();
  const env = { ...sandboxControlSafeEnv(), TZ: 'America/Los_Angeles' };
  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1'], env);
  assert.equal(started.status, 0, started.stderr);
  assert.match(JSON.parse(started.stdout).timestamp, /-\d{2}:\d{2}$/);
  const repeated = run(f.root, [f.id, 'plan.started', '--agent', 'codex', '--round', '1'], env);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
});

test('completion without an open start fails without changing the file', () => {
  const f = fixture();
  const before = fs.readFileSync(f.file);
  const out = run(f.root, [f.id, 'plan.completed', '--agent', 'codex', '--round', '1', '--artifact', 'plan.md', '--artifact-sha256', '0'.repeat(64), '--semantic-digest', '0'.repeat(64)]);
  assert.equal(out.status, 1);
  assert.equal(JSON.parse(out.stdout).error.code, 'EVENT_START_MISSING');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('historical done-only activity does not suppress a new current start', () => {
  const f = fixture();
  fs.appendFileSync(
    f.file,
    '- 2026-01-01 00:00:00+00:00 — **Plan Task (Round 1)** by codex — historical completion\n'
  );

  const started = run(f.root, [f.id, 'plan.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');
  assert.match(fs.readFileSync(f.file, 'utf8'), /Plan Task \(Round 1\) \[started\]/);
});

test('analysis can restart from code when task requirements expand', () => {
  const f = fixture('code');

  const started = run(f.root, [
    f.id, 'analyze.started', '--agent', 'codex', '--reason-code', 'new-requirement',
    '--request-id', `${f.id}:requirements-expanded`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'code');
  assert.equal(startedResult.toStep, 'code');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'analysis-r2.md');

  fs.writeFileSync(path.join(f.dir, 'analysis-r2.md'), localArtifact('analysis'));
  const completed = run(f.root, [
    f.id, 'analyze.completed', '--agent', 'codex', '--artifact', 'analysis-r2.md', ...completionDigestArgs(f.root, f.dir, 'analysis-r2.md', 'analysis'),
    '--reason-code', 'new-requirement', '--request-id', `${f.id}:requirements-expanded`, '--initiator', 'human'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'requirement-analysis');
  const beforeReplay = fs.readFileSync(f.file, 'utf8');
  const replayed = run(f.root, [
    f.id, 'analyze.completed', '--agent', 'codex', '--artifact', 'analysis-r2.md', ...completionDigestArgs(f.root, f.dir, 'analysis-r2.md', 'analysis'),
    '--reason-code', 'new-requirement', '--request-id', `${f.id}:requirements-expanded`, '--initiator', 'human'
  ]);
  assert.equal(replayed.status, 0, replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(f.file, 'utf8'), beforeReplay);
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: requirement-analysis/);
  assert.match(content, /Analyze Task \(Round 2\) \[started\]/);
  assert.match(content, /`analysis-r2\.md`/);
});

test('streamlined design rework is consumed after the analysis upgrade step', () => {
  const f = fixture('code-review');
  try {
    fs.writeFileSync(path.join(f.dir, 'analysis.md'), FULL_ANALYSIS.replace('完整路径', '精简路径'));
    recordFixtureCompletion(f.dir, 'analysis.md');
    const sourceSha256 = sha256File(path.join(f.dir, 'review-code.md'));
    fs.appendFileSync(f.file, `\n## 返工意图\n\n| intent_id | finding_id | source_artifact | source_sha256 | target | classification | evidence_digest | task_fact_digest | status | declared_at | consumed_at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| RI-1 | CD-1 | review-code.md | ${sourceSha256} | plan | design | ${'a'.repeat(64)} | ${'b'.repeat(64)} | pending | 2026-01-01T00:00:00.000Z |  |\n`);

    const started = run(f.root, [
      f.id, 'analyze.started', '--agent', 'codex', '--initiator', 'model',
      '--request-id', `${f.id}:design-rework`, '--reason-code', 'review-finding'
    ]);
    assert.equal(started.status, 0, started.stdout || started.stderr);
    fs.writeFileSync(path.join(f.dir, 'analysis-r2.md'), localArtifact('analysis').replace('完整路径', '标准路径'));
    const completed = run(f.root, [
      f.id, 'analyze.completed', '--agent', 'codex', '--artifact', 'analysis-r2.md',
      ...completionDigestArgs(f.root, f.dir, 'analysis-r2.md', 'analysis'), '--initiator', 'model',
      '--request-id', `${f.id}:design-rework`, '--reason-code', 'review-finding'
    ]);
    assert.equal(completed.status, 0, completed.stdout || completed.stderr);
    const parsed = parseReworkIntentDocument(fs.readFileSync(f.file, 'utf8'));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.intents[0]?.status, 'consumed');
    const facts = buildLifecycleFacts(f.dir, fs.readFileSync(f.file, 'utf8'));
    assert.equal(facts.ok, true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('code completion rejects a missing lifecycle input freeze without writing completion facts or receipts', () => {
  const f = fixture('code');
  try {
    fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan\n');
    recordFixtureCompletion(f.dir, 'plan.md');
    fs.writeFileSync(path.join(f.dir, 'review-plan.md'), reviewArtifact('Plan Review', 'plan.md'));
    addReceipt(f.file, {
      event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
      inputSha256: sha256File(path.join(f.dir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
    });
    const started = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--initiator', 'model', '--request-id', `${f.id}:missing-freeze`, '--reason-code', 'user-request']);
    assert.equal(started.status, 0, started.stdout || started.stderr);
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace(/^lifecycle_input_relations:.*\n/m, ''));
    const before = fs.readFileSync(f.file, 'utf8');
    fs.writeFileSync(path.join(f.dir, 'code.md'), codeReport());
    const completed = run(f.root, [
      f.id, 'code.completed', '--agent', 'codex', '--initiator', 'model', '--request-id', `${f.id}:missing-freeze`, '--reason-code', 'user-request',
      '--artifact', 'code.md', '--files-modified', '0', '--tests-passed', '0', ...completionDigestArgs(f.root, f.dir, 'code.md', 'code')
    ]);
    assert.notEqual(completed.status, 0);
    assert.match(completed.stdout, /lifecycle input context|frozen lifecycle input/i);
    const after = fs.readFileSync(f.file, 'utf8');
    assert.equal(after.includes('code.completed'), before.includes('code.completed'));
    assert.doesNotMatch(after, /\| code\.completed \| code\.md \|/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('standalone started events may skip qualification recovery ordering', () => {
  const f = fixture('code-review');
  for (const [name, content] of [
    ['review-analysis.md', reviewArtifact('Analysis Review', 'analysis.md')],
    ['plan.md', '# Plan\n'],
    ['review-plan.md', reviewArtifact('Plan Review', 'plan.md')]
  ] as const) fs.writeFileSync(path.join(f.dir, name), content);
  addReceipt(f.file, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(f.dir, 'analysis.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  recordFixtureCompletion(f.dir, 'review-analysis.md');
  enableQualification(f.file);
  writeQualifiedArtifact(f.file, path.join(f.dir, 'plan.md'));
  recordFixtureCompletion(f.dir, 'plan.md');

  const skipped = run(f.root, [
    f.id, 'review-plan.started', '--agent', 'codex', '--dry-run', '--initiator', 'human',
    '--request-id', `${f.id}:review-plan-supplement`, '--reason-code', 'upstream-fact-doubt'
  ]);
  assert.equal(skipped.status, 0, skipped.stdout || skipped.stderr);

  const planned = run(f.root, [
    f.id, 'analyze.started', '--agent', 'codex', '--dry-run', '--reason-code', 'new-requirement',
    '--request-id', `${f.id}:recovery`, '--initiator', 'human'
  ]);
  assert.equal(planned.status, 0, planned.stdout || planned.stderr);
  assert.equal(JSON.parse(planned.stdout).artifact, 'analysis-r2.md');

  const started = run(f.root, [
    f.id, 'analyze.started', '--agent', 'codex', '--reason-code', 'new-requirement',
    '--request-id', `${f.id}:recovery`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).artifact, 'analysis-r2.md');
});

test('analysis restart is authorized by explicit intent without current-step adjacency', () => {
  const f = fixture('technical-design');
  const started = run(f.root, [
    f.id, 'analyze.started', '--agent', 'codex', '--reason-code', 'new-requirement',
    '--request-id', `${f.id}:restart`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).artifact, 'analysis-r2.md');
});

test('explicit trigger can start analysis without a current_step adjacency match', () => {
  const f = fixture('technical-design');
  const started = run(f.root, [
    f.id, 'analyze.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', 'req-new-requirement', '--reason-code', 'new-requirement'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).artifact, 'analysis-r2.md');
});

for (const scenario of [
  {
    family: 'review-analysis', step: 'requirement-analysis-review', input: 'analysis.md',
    title: 'Analysis Review', first: 'review-analysis.md', second: 'review-analysis-r2.md'
  },
  {
    family: 'review-plan', step: 'technical-design-review', input: 'plan.md',
    title: 'Plan Review', first: 'review-plan.md', second: 'review-plan-r2.md'
  }
] as const) {
  test(`${scenario.family} event completes a supplemental round from its review stage`, () => {
    const f = fixture(scenario.step);
    fs.writeFileSync(path.join(f.dir, scenario.input), lifecycleInput(scenario.input));
    recordFixtureCompletion(f.dir, scenario.input);
    fs.writeFileSync(path.join(f.dir, scenario.first), reviewArtifact(scenario.title, scenario.input));
    recordFixtureCompletion(f.dir, scenario.first);

    const started = run(f.root, [
      f.id, `${scenario.family}.started`, '--agent', 'codex', '--initiator', 'human',
      '--request-id', `${f.id}:${scenario.family}-supplement`, '--reason-code', 'upstream-fact-doubt'
    ]);
    assert.equal(started.status, 0, started.stdout || started.stderr);
    const startedResult = JSON.parse(started.stdout);
    assert.equal(startedResult.status, 'applied');
    assert.equal(startedResult.fromStep, scenario.step);
    assert.equal(startedResult.toStep, scenario.step);
    assert.equal(startedResult.round, 2);
    assert.equal(startedResult.artifact, scenario.second);

    fs.writeFileSync(path.join(f.dir, scenario.second), reviewArtifact(scenario.title, scenario.input));
    const finalized = finalizeReview(f, {
      stage: scenario.family === 'review-analysis' ? 'analysis' : 'plan',
      artifact: scenario.second
    });
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const completed = run(f.root, [
      f.id, `${scenario.family}.completed`, '--agent', 'codex', '--artifact', scenario.second,
      '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
    ]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).toStep, scenario.step);
    const content = fs.readFileSync(f.file, 'utf8');
    assert.match(content, new RegExp(scenario.second.replace('.', '\\.')));
    assert.match(content, new RegExp(`current_step: ${scenario.step}`));
  });
}

for (const scenario of [
  { family: 'review-analysis', step: 'technical-design', input: 'analysis.md' },
  { family: 'review-plan', step: 'requirement-analysis-review', input: 'plan.md' }
] as const) {
  test(`${scenario.family} event is authorized by explicit intent without current-step adjacency`, () => {
    const f = fixture(scenario.step);
    fs.writeFileSync(path.join(f.dir, scenario.input), lifecycleInput(scenario.input));
    recordFixtureCompletion(f.dir, scenario.input);

    const started = run(f.root, [f.id, `${scenario.family}.started`, '--agent', 'codex']);
    assert.equal(started.status, 0, started.stdout || started.stderr);
  });
}

test('review-code event completes the regular code review path', () => {
  const f = fixture('code');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  recordFixtureCompletion(f.dir, 'code.md');

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).status, 'applied');

  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  const finalized = finalizeReview(f, reviewScenarios[2]);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'code-review');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /current_step: code-review/);
  assert.match(content, /`review-code\.md`/);
});

test('review-code completes against the Git diff without a code artifact receipt', () => {
  const f = fixture('code');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  recordFixtureCompletion(f.dir, 'code.md');
  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);

  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  const finalized = finalizeReview(f, reviewScenarios[2]);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  const task = fs.readFileSync(f.file, 'utf8');
  assert.match(task, /review-code\.completed.*review-code\.md/);
});

test('review completion rejects the same missing schema pattern used by finalization', () => {
  const f = fixture('requirement-analysis-review');
  fs.writeFileSync(path.join(f.dir, 'analysis.md'), FULL_ANALYSIS);
  const started = run(f.root, [f.id, 'review-analysis.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'review-analysis.md'), reviewArtifact('Analysis Review', 'analysis.md').replace('\n### 审查决定\n通过\n', '\n'));

  const completed = completeReview(f, reviewScenarios[0]!, 'approved', { blockers: 0, major: 0, minor: 0 });

  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.match(JSON.parse(completed.stdout).error.message, /ARTIFACT_REQUIRED_PATTERN_MISSING/);
});

for (const scenario of reviewScenarios) {
  test(`${scenario.family} completion records the reviewed input digest receipt`, () => {
    const f = prepareReview(scenario, []);
    const startedContent = fs.readFileSync(f.file, 'utf8');
    assert.match(startedContent, /^review_input_artifact: /m);
    assert.match(startedContent, /^review_input_sha256: [a-f0-9]{64}$/m);
    const finalized = finalizeReview(f, scenario);
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    assert.equal(completed.status, 0, completed.stderr);
    const digest = sha256File(path.join(f.dir, scenario.input));
    const content = fs.readFileSync(f.file, 'utf8');
    assert.match(content, new RegExp(`\\| ${scenario.family}\\.completed \\| ${scenario.artifact} \\| ${scenario.input} \\| ${digest} \\|`));
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} completes a finalized non-advancing review`, () => {
    const f = prepareReview(scenario, [
      `| ${scenario.findingId} | ${scenario.stage} | 1 | minor | open | ${scenario.artifact}#finding |`
    ], '需要修改', { blockers: 0, major: 0, minor: 1 });

    const finalized = finalizeReview(f, scenario);
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const finalization = JSON.parse(finalized.stdout);
    assert.equal(finalization.status, 'no-op');
    assert.equal(finalization.stageStatus.canAdvance, false);

    const completed = completeReview(f, scenario, 'changes-requested', { blockers: 0, major: 0, minor: 1 });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} preserves a known pending decision during unrelated artifact repair`, () => {
    const f = prepareReview(scenario, [
      `| HD-1 | ${scenario.stage} | - | decision | needs-human-decision | ${scenario.artifact}#HD-1 |`
    ], '需要修改');
    const artifactPath = path.join(f.dir, scenario.artifact);
    const original = fs.readFileSync(artifactPath, 'utf8');
    fs.writeFileSync(
      artifactPath,
      `${original.replace('0 阻塞项，0 主要，0 次要', '{unresolved-blockers} 阻塞项，{unresolved-major} 主要，{unresolved-minor} 次要')}\n### HD-1: Decision [needs-human-decision]\n\n- **What needs a decision**: choose a repair\n`
    );

    const finalized = finalizeReview(f, scenario);
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const finalization = JSON.parse(finalized.stdout);
    assert.equal(finalization.status, 'applied');
    assert.equal(finalization.changed, true);
    assert.equal(finalization.stageStatus.canAdvance, false);
    assert.match(fs.readFileSync(artifactPath, 'utf8'), /0 阻塞项，0 主要，0 次要/);
    assert.match(fs.readFileSync(artifactPath, 'utf8'), /### HD-1: Decision \[needs-human-decision\]/);

    const completed = completeReview(f, scenario, 'changes-requested', { blockers: 0, major: 0, minor: 0 });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} rejects input changes after the review artifact is written`, () => {
    const f = prepareReview(scenario, []);
    fs.writeFileSync(path.join(f.dir, scenario.input), lifecycleInput(scenario.input, 'changed\n'));
    const before = fs.readFileSync(f.file);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    const result = JSON.parse(completed.stdout);

    assert.equal(completed.status, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'EVENT_ARTIFACT_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

for (const scenario of reviewScenarios) {
  test(`${scenario.family} rejects approved finding counts that differ from the ${scenario.stage} ledger`, () => {
    const f = prepareReview(scenario, [
      `| ${scenario.findingId} | ${scenario.stage} | 1 | minor | open | ${scenario.artifact}#finding |`
    ]);
    const before = fs.readFileSync(f.file);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    const result = JSON.parse(completed.stdout);

    assert.equal(completed.status, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.changed, false);
    assert.equal(result.error.code, 'EVENT_FINDING_COUNT_MISMATCH');
    assert.match(result.error.message, new RegExp(`${scenario.stage} ledger`));
    assert.match(result.error.message, /minor ledger 1, payload 0/);
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

test('approved review completion rejects non-zero finding counts even when payload and ledger match', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, [
    '| CD-1 | code | 1 | blocker | open | review-code.md#CD-1 |',
    '| CD-2 | code | 1 | major | adjusted | review-code.md#CD-2 |',
    '| CD-3 | code | 1 | minor | needs-human-decision | review-code.md#CD-3 |'
  ], '通过', { blockers: 1, major: 1, minor: 1 });
  const before = fs.readFileSync(f.file);
  const completed = completeReview(f, scenario, 'approved', { blockers: 1, major: 1, minor: 1 });

  assert.equal(completed.status, 1);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.error.code, 'EVENT_VERDICT_INVALID');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

for (const verdict of ['changes-requested', 'rejected'] as const) {
  test(`${verdict} review completion rejects finding counts that differ from the ledger`, () => {
    const scenario = reviewScenarios[2];
    const f = prepareReview(
      scenario,
      ['| CD-1 | code | 1 | minor | open | review-code.md#CD-1 |'],
      verdict === 'changes-requested' ? '需要修改' : '拒绝'
    );
    const before = fs.readFileSync(f.file);
    const completed = completeReview(f, scenario, verdict, { blockers: 0, major: 0, minor: 0 });

    assert.equal(completed.status, 1);
    assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_FINDING_COUNT_MISMATCH');
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

test('review completion rejects unresolved summary placeholders before mutating task.md', () => {
  const scenario = reviewScenarios[0];
  const f = prepareReview(scenario, []);
  const artifactPath = path.join(f.dir, scenario.artifact);
  fs.writeFileSync(
    artifactPath,
    fs.readFileSync(artifactPath, 'utf8')
      .replace('0 阻塞项，0 主要，0 次要', '{unresolved-blockers} 阻塞项，{unresolved-major} 主要，{unresolved-minor} 次要')
  );
  const before = fs.readFileSync(f.file);
  const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });

  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_FINDING_COUNT_MISMATCH');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('approved dry-run rejects mismatched finding counts without changing task bytes', () => {
  const scenario = reviewScenarios[1];
  const f = prepareReview(scenario, [
    '| PL-1 | plan | 1 | major | open | review-plan.md#PL-1 |'
  ]);
  const before = fs.readFileSync(f.file);
  const completed = completeReview(
    f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 }, ['--dry-run']
  );
  const result = JSON.parse(completed.stdout);

  assert.equal(completed.status, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EVENT_FINDING_COUNT_MISMATCH');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('approved review completion reports an invalid ledger as an invalid task document', () => {
  const scenario = reviewScenarios[0];
  const f = prepareReview(scenario, []);
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace(
    '|----|-------|-------|----------|--------|----------|',
    '|----|-------|-------|----------|--------|----------|\n| invalid | analysis | 1 | minor | open | review-analysis.md#finding |'
  ));
  const before = fs.readFileSync(f.file);
  const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  const result = JSON.parse(completed.stdout);

  assert.equal(completed.status, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'TASK_DOCUMENT_INVALID');
  assert.match(result.error.message, /LEDGER_ID_INVALID/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('completed approved review rejects stale finding counts after the ledger changes', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  const finalized = finalizeReview(f, scenario);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  assert.equal(completed.status, 0, completed.stderr);

  const content = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(
    f.file,
    content.replace(
      '|----|-------|-------|----------|--------|----------|',
      '|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | minor | open | review-code.md#CD-1 |'
    )
  );
  const beforeReplay = fs.readFileSync(f.file);
  const replayed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });

  assert.equal(replayed.status, 1);
  assert.equal(JSON.parse(replayed.stdout).error.code, 'EVENT_FINDING_COUNT_MISMATCH');
  assert.deepEqual(fs.readFileSync(f.file), beforeReplay);
});

test('review completion replays the same current result without another activity entry', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  const finalized = finalizeReview(f, scenario);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);

  const first = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const beforeReplay = fs.readFileSync(f.file);
  const replayed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
  assert.deepEqual(fs.readFileSync(f.file), beforeReplay);
});

test('review completion refuses to rewrite a completed review artifact', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  assert.equal(finalizeReview(f, scenario).status, 0);
  assert.equal(completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 }).status, 0);
  const beforeTask = fs.readFileSync(f.file, 'utf8');
  fs.appendFileSync(path.join(f.dir, scenario.artifact), '\nUpdated evidence.\n');
  const changedArtifact = fs.readFileSync(path.join(f.dir, scenario.artifact));
  const finalized = finalizeReview(f, scenario);
  assert.equal(finalized.status, 1);
  assert.match(JSON.parse(finalized.stdout).error.message, /completed artifact|completion evidence/u);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, scenario.artifact)), changedArtifact);
  assert.equal(fs.readFileSync(f.file, 'utf8'), beforeTask);
});

test('review completion rejects replay when its reviewed input later changes', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  assert.equal(finalizeReview(f, scenario).status, 0);
  assert.equal(completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 }).status, 0);
  fs.appendFileSync(path.join(f.dir, scenario.input), '\nChanged implementation.\n');
  const before = fs.readFileSync(f.file, 'utf8');
  const repeated = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
  assert.equal(repeated.status, 1);
  assert.equal(JSON.parse(repeated.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file, 'utf8'), before);
});

test('review completion dry-run leaves current task bytes unchanged', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  const finalized = finalizeReview(f, scenario);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);

  const beforeTask = fs.readFileSync(f.file);

  const planned = completeReview(
    f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 }, ['--dry-run']
  );
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  assert.equal(JSON.parse(planned.stdout).status, 'planned');
  assert.deepEqual(fs.readFileSync(f.file), beforeTask);
});

test('review completion dry-run is repeatable with current review facts', () => {
  const scenario = reviewScenarios[2];
  const f = prepareReview(scenario, []);
  const finalized = finalizeReview(f, scenario);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);

  const beforeTask = fs.readFileSync(f.file);
  const replayed = completeReview(
    f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 }, ['--dry-run']
  );
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  assert.equal(JSON.parse(replayed.stdout).status, 'planned');
  assert.deepEqual(fs.readFileSync(f.file), beforeTask);
});

test('review-code event completes a supplemental round against the latest code artifact', () => {
  const f = fixture('code-review');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  fs.appendFileSync(
    f.file,
    '- 2026-01-01 00:01:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md\n'
  );

  const artifact = inspect(f.root, [
    f.id, 'inspect', '--family', 'review-code', '--source-finding', 'CD-1',
    '--source-artifact', 'review-code.md', '--source-sha256', 'a'.repeat(64)
  ]);
  assert.equal(artifact.status, 0, artifact.stderr);
  const artifactResult = JSON.parse(artifact.stdout);
  assert.equal(artifactResult.status, 'ready');
  assert.deepEqual(artifactResult.next, { round: 2, name: 'review-code-r2.md' });
  assert.equal(artifactResult.inputs[0].name, 'code.md');

  const started = run(f.root, [
    f.id, 'review-code.started', '--agent', 'codex', '--reason-code', 'upstream-fact-doubt',
    '--request-id', `${f.id}:supplemental-review`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'code-review');
  assert.equal(startedResult.toStep, 'code-review');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'review-code-r2.md');

  fs.writeFileSync(path.join(f.dir, 'review-code-r2.md'), reviewCodeArtifact());
  const finalized = finalizeReview(f, { stage: 'code', artifact: 'review-code-r2.md' });
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code-r2.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).toStep, 'code-review');
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Review Code \(Round 2\) \[started\]/);
  assert.match(content, /`review-code-r2\.md`/);
});

test('review-code completion anchors an approved clean reviewed commit', () => {
  const f = fixture('code-review');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();

  const started = run(f.root, [
    f.id, 'review-code.started', '--agent', 'codex', '--reason-code', 'upstream-fact-doubt',
    '--request-id', `${f.id}:supplemental-review`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stderr);
  const artifact = reviewCodeArtifact()
    .replace('- **审查基线提交**：`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`', `- **审查基线提交**：${head}`)
    .replace('- **审查快照树**：dddddddddddddddddddddddddddddddddddddddd', `- **审查快照树**：${tree}`)
    .replace('- **审查差异基线**：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', `- **审查已检视提交**：${head}\n- **审查差异基线**：${head}`);
  fs.writeFileSync(path.join(f.dir, 'review-code-r2.md'), artifact);
  const finalized = finalizeReview(f, { stage: 'code', artifact: 'review-code-r2.md' });
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);

  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code-r2.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(fs.readFileSync(f.file, 'utf8'), new RegExp(`^last_reviewed_commit: ${head}$`, 'm'));
});

test('review-code completion anchors the task branch worktree when the task workspace is on the host', () => {
  const f = fixture('code-review');
  const branch = 'agent-infra-bugfix-worktree-anchor';
  const registeredWorktree = path.join(f.root, 'task-worktree');
  const sandboxWorktree = path.join(f.root, 'sandbox-worktree');
  let result = spawnSync('git', ['worktree', 'add', '-b', branch, registeredWorktree], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(path.join(registeredWorktree, 'reviewed.txt'), 'reviewed\n');
  result = spawnSync('git', ['add', 'reviewed.txt'], { cwd: registeredWorktree, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'reviewed'], { cwd: registeredWorktree, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: registeredWorktree, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: registeredWorktree, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('assigned_to: claude', `assigned_to: claude\nbranch: ${branch}`));
  fs.renameSync(registeredWorktree, sandboxWorktree);
  const sandboxTaskDir = path.join(taskWorkspaceRoot(sandboxWorktree),  'active', f.id);
  assert.equal(sandboxTaskDir, f.dir, 'registered worktrees of the same project share the host task root');

  const started = run(sandboxWorktree, [
    f.id, 'review-code.started', '--agent', 'codex', '--reason-code', 'upstream-fact-doubt',
    '--request-id', `${f.id}:supplemental-review`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stderr);
  const artifact = reviewCodeArtifact()
    .replace('- **审查基线提交**：`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`', `- **审查基线提交**：${head}`)
    .replace('- **审查快照树**：dddddddddddddddddddddddddddddddddddddddd', `- **审查快照树**：${tree}`)
    .replace('- **审查差异基线**：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', `- **审查已检视提交**：${head}\n- **审查差异基线**：${head}`);
  fs.writeFileSync(path.join(sandboxTaskDir, 'review-code-r2.md'), artifact);
  const sandboxFixture = { ...f, root: sandboxWorktree, dir: sandboxTaskDir, file: path.join(sandboxTaskDir, 'task.md') };
  const finalized = finalizeReview(sandboxFixture, { stage: 'code', artifact: 'review-code-r2.md' });
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);

  const completed = run(sandboxWorktree, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code-r2.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(fs.readFileSync(sandboxFixture.file, 'utf8'), new RegExp(`^last_reviewed_commit: ${head}$`, 'm'));
});

test('review-code completion records the result without authorizing a changed implementation', () => {
  const f = fixture('code-review');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: f.root, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace(
    'agent_infra_version: v0.9.11-alpha.0',
    `agent_infra_version: v0.9.11-alpha.0\nlast_reviewed_commit: ${head}`
  ));

  const started = run(f.root, [
    f.id, 'review-code.started', '--agent', 'codex', '--reason-code', 'upstream-fact-doubt',
    '--request-id', `${f.id}:supplemental-review`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stderr);
  const artifact = reviewCodeArtifact()
    .replace('- **审查基线提交**：`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`', `- **审查基线提交**：${head}`)
    .replace('- **审查快照树**：dddddddddddddddddddddddddddddddddddddddd', `- **审查快照树**：${tree}`)
    .replace('- **审查差异基线**：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', `- **审查已检视提交**：${head}\n- **审查差异基线**：${head}`);
  fs.writeFileSync(path.join(f.dir, 'review-code-r2.md'), artifact);
  const finalized = finalizeReview(f, { stage: 'code', artifact: 'review-code-r2.md' });
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  fs.appendFileSync(path.join(f.root, '.gitignore'), '# dirty review snapshot\n');

  const completed = run(f.root, [
    f.id, 'review-code.completed', '--agent', 'codex', '--artifact', 'review-code-r2.md',
    '--verdict', 'approved', '--blockers', '0', '--major', '0', '--minor', '0', '--manual-validation', '0'
  ]);
  assert.equal(completed.status, 1, completed.stdout || completed.stderr);
  assert.match(JSON.parse(completed.stdout).error.message, /uncommitted changes/i);
  assert.match(fs.readFileSync(f.file, 'utf8'), new RegExp(`^last_reviewed_commit: ${head}$`, 'm'));
});

test('review-code event allows a supplemental round after commit preparation', () => {
  const f = fixture('commit');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(f.dir, 'review-code.md'), reviewCodeArtifact());
  fs.appendFileSync(
    f.file,
    '- 2026-01-01 00:01:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code.md\n'
  );

  const started = run(f.root, [
    f.id, 'review-code.started', '--agent', 'codex', '--reason-code', 'upstream-fact-doubt',
    '--request-id', `${f.id}:supplemental-review`, '--initiator', 'human'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.fromStep, 'commit');
  assert.equal(startedResult.toStep, 'commit');
  assert.equal(startedResult.round, 2);
  assert.equal(startedResult.artifact, 'review-code-r2.md');
});

test('review-code event is authorized by explicit intent without current-step adjacency', () => {
  const f = fixture('technical-design');
  fs.writeFileSync(path.join(f.dir, 'code.md'), '# Code\n');

  const started = run(f.root, [f.id, 'review-code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
});

test('decision code event clears the review baseline and consumes its input on completion', () => {
  const f = decisionFixture();
  const started = run(f.root, [
    f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1'
  ]);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  const startedResult = JSON.parse(started.stdout);
  assert.equal(startedResult.status, 'applied');
  assert.equal(startedResult.implementationInput, 'II-1');
  let content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /Code Task \(Round 2, decision II-1\) \[started\]/);
  assert.match(content, /^code_input_artifact: plan\.md$/m);
  assert.match(content, /^code_input_sha256: [a-f0-9]{64}$/m);
  assert.match(content, /last_reviewed_commit:\s*$/m);
  assert.match(content, /\| II-1 .*\| pending \|\s*\|/);

  fs.writeFileSync(path.join(f.dir, 'code-r2.md'), codeReport());
  const digests = completionDigestArgs(f.root, f.dir, 'code-r2.md', 'code');
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '4', ...digests
  ]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).implementationInput, 'II-1');
  content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /\| II-1 .*\| consumed \| code-r2\.md \|/);
  assert.match(content, /Code Task \(Round 2, decision II-1\).*Code implemented/);
  assert.match(content, new RegExp(`\\| code.completed \\| code-r2\\.md \\| plan\\.md \\| ${sha256File(path.join(f.dir, 'plan.md'))} \\|`));

  const repeated = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '4', ...digests
  ]);
  assert.equal(JSON.parse(repeated.stdout).status, 'no-op');
});

test('internal event preserves a human decision in the same task directory', () => {
  const f = decisionFixture();
  const task = fs.readFileSync(f.file, 'utf8')
    .replace(
      '| II-1 | CD-1 | task.md#HDR-1 | code | true | 2026-07-18 09:59:00+08:00 | pending | |',
      '| II-1 | CD-1 | review-code.md#CD-1 | code | true | | declared | |'
    )
    .replace(
      '|----|-------|-------|----------|--------|----------|',
      '|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |'
    );
  fs.writeFileSync(f.file, task);
  const decision = applyHumanDecision({ taskRef: f.id, selector: 'CD-1', decision: 'Use the direct task directory' }, {
    repoRoot: f.root,
    metadataProvider: () => ({ timestamp: '2026-07-18 10:03:00+08:00', agentInfraVersion: 'v0.9.11-alpha.0' })
  });
  assert.equal(decision.status, 'applied', JSON.stringify(decision));
  const decided = fs.readFileSync(f.file, 'utf8');
  assert.match(decided, /\| CD-1 \| code \| 1 \| major \| human-decided \| task\.md#HDR-1 \|/);
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const afterEvent = fs.readFileSync(f.file, 'utf8');
  assert.match(afterEvent, /\| CD-1 \| code \| 1 \| major \| human-decided \| task\.md#HDR-1 \|/);
  assert.match(afterEvent, /### HDR-1/);
  assert.match(afterEvent, /Code Task \(Round 2, decision II-1\) \[started\]/);
});

test('code completion uses the plan identity bound by code.started', () => {
  const f = decisionFixture();
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'code-r2.md'), codeReport().replace('- **方案输入**：`plan.md`', '本轮输入为 `plan.md`'));
  const digests = completionDigestArgs(f.root, f.dir, 'code-r2.md', 'code');
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '1', ...digests
  ]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.match(fs.readFileSync(f.file, 'utf8'), /\| code\.completed \| code-r2\.md \| plan\.md \|/);
});

for (const scenario of reviewScenarios) {
  test(`${scenario.family} completion uses the input identity bound by review.started`, () => {
    const f = prepareReview(scenario, []);
    const artifactPath = path.join(f.dir, scenario.artifact);
    fs.writeFileSync(artifactPath, fs.readFileSync(artifactPath, 'utf8').replace(
      `- **审查输入**：\`${scenario.input}\``, `本轮检视了 \`${scenario.input}\``
    ));
    const finalized = finalizeReview(f, scenario);
    assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
    const completed = completeReview(f, scenario, 'approved', { blockers: 0, major: 0, minor: 0 });
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  });
}

test('code completion keeps its original result counts and permits only exact replay', () => {
  const f = fixture('technical-design-review');
  try {
    fs.writeFileSync(path.join(f.dir, 'plan.md'), localArtifact('plan'));
    recordFixtureCompletion(f.dir, 'plan.md');
    fs.writeFileSync(path.join(f.dir, 'review-plan.md'), reviewArtifact('Plan Review', 'plan.md'));
    recordFixtureCompletion(f.dir, 'review-plan.md');
    addReceipt(f.file, {
      event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
      inputSha256: sha256File(path.join(f.dir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
    });
    const started = run(f.root, [f.id, 'code.started', '--agent', 'codex']);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    assert.match(fs.readFileSync(f.file, 'utf8'), /^lifecycle_input_relations: /m);
    fs.writeFileSync(path.join(f.dir, 'code.md'), codeReport());
    const args = [f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code.md',
      ...completionDigestArgs(f.root, f.dir, 'code.md', 'code')];
    const completedArgs = [...args, '--files-modified', '1', '--tests-passed', '10'];
    const completed = run(f.root, completedArgs);
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, 'applied');
    const after = fs.readFileSync(f.file, 'utf8');
    assert.ok(after.includes('Code implemented, 1 files modified, 10 tests passed → code.md'));
    const replay = run(f.root, completedArgs);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(replay.stdout).status, 'no-op');
    assert.equal(fs.readFileSync(f.file, 'utf8'), after);
    assert.match(after, /lifecycleInputs/);
    const withoutOptionalReceipt = after.split('\n')
      .filter((line) => !line.startsWith('| code.completed | code.md | review-plan.md |'))
      .join('\n');
    assert.notEqual(withoutOptionalReceipt, after);
    fs.writeFileSync(f.file, withoutOptionalReceipt);
    const missingOptionalReceipt = run(f.root, completedArgs);
    assert.notEqual(missingOptionalReceipt.status, 0);
    assert.equal(JSON.parse(missingOptionalReceipt.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
    assert.equal(fs.readFileSync(f.file, 'utf8'), withoutOptionalReceipt);
    const correctedCounts = run(f.root, [...args, '--files-modified', '2', '--tests-passed', '20']);
    assert.notEqual(correctedCounts.status, 0);
    assert.equal(fs.readFileSync(f.file, 'utf8'), withoutOptionalReceipt);
    const notes = fs.readFileSync(f.file, 'utf8').split('\n').filter((line) => line.includes(' — Code implemented,'));
    assert.equal(notes.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('code completion rejects a plan changed after code started', () => {
  const f = fixture('technical-design-review');
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan v1\n');
  recordFixtureCompletion(f.dir, 'plan.md');
  fs.writeFileSync(path.join(f.dir, 'review-plan.md'), reviewArtifact('Plan Review', 'plan.md'));
  addReceipt(f.file, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(f.dir, 'plan.md')), completedAt: '2026-01-01 00:00:00+00:00'
  });
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stderr);
  fs.writeFileSync(path.join(f.dir, 'plan.md'), '# Plan v2\n');
  fs.writeFileSync(path.join(f.dir, 'code.md'), codeReport());
  const digests = completionDigestArgs(f.root, f.dir, 'code.md', 'code');
  const before = fs.readFileSync(f.file);
  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code.md',
    '--files-modified', '1', '--tests-passed', '1', ...digests
  ]);
  assert.equal(completed.status, 1);
  assert.equal(JSON.parse(completed.stdout).error.code, 'EVENT_ARTIFACT_CONFLICT');
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('code completion accepts the current valid artifact without finalizer provenance', () => {
  const f = decisionFixture();
  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex', '--implementation-input', 'II-1']);
  assert.equal(started.status, 0, started.stderr);
  const artifact = path.join(f.dir, 'code-r2.md');
  fs.writeFileSync(artifact, codeReport());
  const content = fs.readFileSync(artifact, 'utf8');
  const local = validateLocalArtifact(content, { family: 'code' });
  assert.equal(local.ok, true, local.diagnostics.map((item) => item.message).join('; '));

  const completed = run(f.root, [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r2.md',
    '--implementation-input', 'II-1', '--files-modified', '1', '--tests-passed', '1',
    '--artifact-sha256', sha256File(artifact), '--semantic-digest', local.semanticDigest
  ]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.equal(JSON.parse(completed.stdout).status, 'applied');
});

test('code-r7 completion accepts a directly repaired report', () => {
  const f = fixture('code');
  const planPath = path.join(f.dir, 'plan.md');
  fs.writeFileSync(planPath, localArtifact('plan'));
  recordFixtureCompletion(f.dir, 'plan.md');
  const planSha256 = sha256File(planPath);
  fs.writeFileSync(path.join(f.dir, 'review-plan.md'), reviewArtifact('Plan Review', 'plan.md'));
  recordFixtureCompletion(f.dir, 'review-plan.md');
  addReceipt(f.file, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: planSha256, completedAt: '2026-01-01 00:00:00+00:00'
  });
  fs.appendFileSync(f.file, '- 2026-01-01 00:00:00+00:00 — **Review Plan (Round 1)** by codex — Verdict: Approved, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-plan.md\n');
  for (let round = 1; round <= 6; round += 1) {
    const suffix = round === 1 ? '' : `-r${round}`;
    const codeArtifact = `code${suffix}.md`;
    const reviewArtifactName = `review-code${suffix}.md`;
    fs.writeFileSync(path.join(f.dir, codeArtifact), codeReport());
    fs.writeFileSync(
      path.join(f.dir, reviewArtifactName),
      round === 6
        ? reviewCodeArtifact(codeArtifact)
          .replace('- **总体结论**：通过', '- **总体结论**：需要修改')
          .replace('### 审查决定\n通过', '### 审查决定\n需要修改')
        : reviewCodeArtifact(codeArtifact)
    );
    recordFixtureCompletion(f.dir, codeArtifact);
    recordFixtureCompletion(f.dir, reviewArtifactName);
  }
  const lifecycleTask = fs.readFileSync(f.file, 'utf8');
  for (let round = 1; round <= 6; round += 1) {
    const suffix = round === 1 ? '' : `-r${round}`;
    assert.equal(hasValidArtifactCompletion(lifecycleTask, f.dir, `code${suffix}.md`, 'code.completed'), true, `code${suffix}.md`);
    assert.equal(hasValidArtifactCompletion(lifecycleTask, f.dir, `review-code${suffix}.md`, 'review-code.completed'), true, `review-code${suffix}.md`);
  }
  fs.appendFileSync(f.file, [
    ...Array.from({ length: 6 }, (_, index) => {
      const round = index + 1;
      const suffix = round === 1 ? '' : `-r${round}`;
      return `- 2026-01-01 00:0${round}:00+00:00 — **Code Task (Round ${round})** by codex — Code implemented, 1 files modified, 1 tests passed → code${suffix}.md`;
    }),
    ...Array.from({ length: 6 }, (_, index) => {
      const round = index + 1;
      const suffix = round === 1 ? '' : `-r${round}`;
      return `- 2026-01-01 01:0${round}:00+00:00 — **Review Code (Round ${round})** by codex — Verdict: ${round === 6 ? 'Changes Requested' : 'Approved'}, blockers: 0, major: 0, minor: 0, Manual-validation: 0 → review-code${suffix}.md`;
    })
  ].join('\n') + '\n');

  const reviewCodeInventory = inspectArtifactDirectory(f.dir, 'review-code');
  assert.equal(reviewCodeInventory.status, 'ready', JSON.stringify(reviewCodeInventory.error));
  assert.equal(reviewCodeInventory.latest?.name, 'review-code-r6.md');

  const started = run(f.root, [f.id, 'code.started', '--agent', 'codex']);
  assert.equal(started.status, 0, started.stdout || started.stderr);
  assert.equal(JSON.parse(started.stdout).artifact, 'code-r7.md');
  const resumed = run(f.root, [
    f.id, 'code.started', '--agent', 'codex', '--initiator', 'model',
    '--request-id', `${f.id}:code-resume-fix`, '--reason-code', 'review-finding',
    '--fix-for', 'review-code-r6.md'
  ]);
  assert.equal(resumed.status, 0, resumed.stdout || resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, 'applied');
  const resumedContent = fs.readFileSync(f.file, 'utf8');
  assert.match(resumedContent, /Code Task \(Round 7\) \[aborted\].*superseded by Code Task \(Round 7, fix for review-code-r6\.md\)/);
  assert.match(resumedContent, /Code Task \(Round 7, fix for review-code-r6\.md\) \[started\]/);
  const beforeRecovery = fs.readFileSync(f.file);
  const artifactPath = path.join(f.dir, 'code-r7.md');
  const malformed = codeReport().replace(/## 实现输入[\s\S]*?(?=## 变更文件)/, '');
  fs.writeFileSync(artifactPath, malformed);

  const first = finalizeLocalArtifact({
    taskRef: f.id, repoRoot: f.root, family: 'code', artifact: 'code-r7.md'
  });
  assert.equal(first.status, 'failed');
  assert.deepEqual(fs.readFileSync(f.file), beforeRecovery);
  fs.writeFileSync(artifactPath, codeReport());

  const finalized = finalizeLocalArtifact({
    taskRef: f.id, repoRoot: f.root, family: 'code', artifact: 'code-r7.md'
  });
  assert.equal(finalized.status, 'passed', finalized.error?.message);
  assert.deepEqual(fs.readFileSync(f.file), beforeRecovery);
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), codeReport());

  const completedArgs = [
    f.id, 'code.completed', '--agent', 'codex', '--artifact', 'code-r7.md',
    '--fix-for', 'review-code-r6.md', '--blockers', '0', '--major', '0', '--minor', '0',
    '--manual-validation', '0', '--artifact-sha256', finalized.artifactSha256!,
    '--semantic-digest', finalized.semanticDigest!
  ];
  const completed = run(f.root, completedArgs);
  assert.equal(completed.status, 0, completed.stdout || completed.stderr);
  const afterCompletion = fs.readFileSync(f.file, 'utf8');
  assert.equal((afterCompletion.match(/^.* — \*\*Code Task \(Round 7, fix for review-code-r6\.md\)\*\* by codex — Fixed /gm) ?? []).length, 1);
  assert.equal((afterCompletion.match(/^.* — \*\*Code Task \(Round 7, fix for review-code-r6\.md\) \[started\]\*\* by codex — started$/gm) ?? []).length, 1);
  const replayed = run(f.root, completedArgs);
  assert.equal(replayed.status, 0, replayed.stdout || replayed.stderr);
  assert.equal(JSON.parse(replayed.stdout).status, 'no-op');
  assert.equal((fs.readFileSync(f.file, 'utf8').match(/^.* — \*\*Code Task \(Round 7, fix for review-code-r6\.md\)\*\* by codex — Fixed /gm) ?? []).length, 1);
});
