import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import { readArtifactRepairIntent } from '../../../lib/task/artifact-repair-intent.ts';
import { executeTaskWorkflow } from '../../../lib/sandbox/control/workflow-executor.ts';
import { captureProjectionTopology, createTaskWorkflowRequest } from '../../../lib/sandbox/control/task-workflow.ts';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';
import { onPlatforms } from '../../helpers.ts';

const taskId = 'TASK-20260101-000001';

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-execution-')));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  const projection = path.join(root, 'projection', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(projection, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: ${taskId}
current_step: requirement-analysis-review
---
# Task

## Review Disagreement Ledger

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## Activity Log

- 2026-01-01 00:00:00+00:00 — **Plan Task (Round 1) [started]** by codex — started
- 2026-01-01 00:00:00+00:00 — **Review Analysis (Round 1) [started]** by codex — started
`);
  const manifest = {
    repoRoot: root, worktreeRoot: root, mode: 'task-bound', taskId, generation: 'generation-1',
    controlRootId: 'a'.repeat(96), taskProjectionDir: projection,
    taskProjectionTopology: captureProjectionTopology(projection), publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing')
  } as SandboxControlManifest;
  const run = async (command: 'task-artifact' | 'task-review', args: string[]) => {
    const result = await executeTaskWorkflow(manifest, createTaskWorkflowRequest(command, [taskId, ...args], taskId, manifest.generation));
    return { ...result, body: JSON.parse(result.stdout) };
  };
  return { root, taskDir, projection, run };
}

function content(family: 'plan' | 'review-analysis'): string {
  let result = renderArtifactSkeleton({ taskId, family, artifact: `${family}.md` }).replaceAll('<!-- artifact-slot:empty -->', '内容');
  result = result.replace(`## 状态核对\n<!-- artifact-section:${family}:state-check -->\n内容`, `## 状态核对\n<!-- artifact-section:${family}:state-check -->\n\`\`\`text\n$ git status -s\n\`\`\``);
  if (family === 'review-analysis') {
    result = result.replace('## 审查摘要\n<!-- artifact-section:review-analysis:summary -->\n内容', '## 审查摘要\n<!-- artifact-section:review-analysis:summary -->\n- **总体结论**：通过\n- **发现（AI 可处理）**：{unresolved-blockers} 阻塞项，{unresolved-major} 主要，{unresolved-minor} 次要');
    result = result.replace('## 证据原文\n<!-- artifact-section:review-analysis:evidence -->\n内容', '## 证据原文\n<!-- artifact-section:review-analysis:evidence -->\n```text\n$ git status -s\n```');
    result += '\n### 审查决定\n通过\n';
  }
  return result;
}

for (const family of ['plan', 'review-analysis'] as const) {
  test(`workflow validates and publishes a projection-only ${family} artifact`, onPlatforms('linux', 'darwin'), async () => {
    const f = fixture();
    try {
      const artifact = `${family}.md`;
      fs.writeFileSync(path.join(f.projection, artifact), content(family));
      const args = family === 'plan' ? ['finalize-local', '--family', family] : ['finalize-summary', '--stage', 'analysis'];
      const command = family === 'plan' ? 'task-artifact' : 'task-review';
      const result = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(result.exitCode, 0, result.stdout);
      assert.equal(result.body.changed, true);
      assert.ok(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8').length > 0);
      assert.match(result.body.artifactSha256, /^[a-f0-9]{64}$/u);
      if (family === 'plan') assert.equal(readArtifactRepairIntent(f.root, taskId, family, artifact)?.state, 'passed');
      const repeated = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(repeated.exitCode, 0, repeated.stdout);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('workflow rejects duplicate options and invalid candidates without replacing authoritative artifacts', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const before = content('plan');
    fs.writeFileSync(path.join(f.taskDir, 'plan.md'), before);
    fs.writeFileSync(path.join(f.projection, 'plan.md'), '# Invalid candidate\n');
    const invalid = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.body.changed, false);
    const duplicate = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--family', 'code', '--artifact', 'plan.md']);
    assert.equal(duplicate.exitCode, 1);
    assert.match(duplicate.body.error.message, /duplicate option/u);
    assert.equal(fs.readFileSync(path.join(f.taskDir, 'plan.md'), 'utf8'), before);
    assert.equal(readArtifactRepairIntent(f.root, taskId, 'plan', 'plan.md'), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('workflow initializes and repairs candidates before authoritative publication', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const initialized = await f.run('task-artifact', ['init', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(initialized.exitCode, 0, initialized.stdout);
    const candidate = path.join(f.projection, 'plan.md');
    assert.ok(fs.existsSync(candidate));
    assert.equal(fs.existsSync(path.join(f.taskDir, 'plan.md')), false);
    fs.writeFileSync(candidate, content('plan').replace('## 问题理解\n', '## 问题理解：\n'));
    const invalid = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(invalid.body.repairable, true, invalid.stdout);
    const repaired = await f.run('task-artifact', ['repair', '--family', 'plan', '--artifact', 'plan.md',
      '--expected-sha256', invalid.body.artifactSha256, '--expected-semantic-digest', invalid.body.semanticDigest]);
    assert.equal(repaired.exitCode, 0, repaired.stdout);
    assert.equal(fs.readFileSync(candidate, 'utf8'), content('plan'));
    assert.equal(fs.existsSync(path.join(f.taskDir, 'plan.md')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('workflow rejects candidates outside the authoritative round and inventory', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    for (const family of ['plan', 'review-analysis'] as const) {
      const artifact = `${family}-r3.md`;
      fs.writeFileSync(path.join(f.projection, artifact), content(family));
      const command = family === 'plan' ? 'task-artifact' : 'task-review';
      const args = family === 'plan' ? ['finalize-local', '--family', family] : ['finalize-summary', '--stage', 'analysis'];
      const result = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(result.exitCode, 1, result.stdout);
      assert.equal(result.body.changed, false);
      assert.equal(fs.existsSync(path.join(f.taskDir, artifact)), false);
      assert.equal(readArtifactRepairIntent(f.root, taskId, family, artifact), null);
    }
    fs.writeFileSync(path.join(f.projection, 'plan.md'), content('plan'));
    const taskPath = path.join(f.taskDir, 'task.md');
    fs.appendFileSync(taskPath, '- 2026-01-01 00:01:00+00:00 — **Plan Task (Round 1)** by codex — done\n');
    const closed = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(closed.exitCode, 1, closed.stdout);
    assert.equal(fs.existsSync(path.join(f.taskDir, 'plan.md')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('workflow returns a failed receipt when the candidate cannot be read', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const result = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.body.changed, false);
    assert.equal(result.body.error.code, 'TASK_ARTIFACT_WRITE_CONFLICT');
    assert.equal(readArtifactRepairIntent(f.root, taskId, 'plan', 'plan.md'), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
