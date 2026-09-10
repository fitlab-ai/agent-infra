import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import { readArtifactRepairIntent } from '../../../lib/task/artifact-repair-intent.ts';
import { prepareLocalArtifact, commitLocalArtifactProvenance } from '../../../lib/task/local-artifact-finalization.ts';
import { executeTaskWorkflow } from '../../../lib/sandbox/control/workflow-executor.ts';
import { createTaskWorkflowRequest } from '../../../lib/sandbox/control/task-workflow.ts';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';
import { onPlatforms } from '../../helpers.ts';
import { startHostControlServer } from '../../../lib/host-control/server.ts';

const taskId = 'TASK-20260101-000001';

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-execution-')));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---
id: ${taskId}
agent_infra_version: v0.9.15-alpha.0
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
    controlRootId: 'a'.repeat(96), publicStatusDir: path.join(root, 'public'),
    processingDir: path.join(root, 'processing')
  } as SandboxControlManifest;
  const run = async (command: 'task-artifact' | 'task-review', args: string[]) => {
    const result = await executeTaskWorkflow(manifest, createTaskWorkflowRequest(command, [taskId, ...args], taskId, manifest.generation));
    return { ...result, body: JSON.parse(result.stdout) };
  };
  return { root, taskDir, manifest, run };
}

test('authorized workflow executor owns the command worker without redispatching to the service', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  let dispatched = false;
  const server = await startHostControlServer({
    endpoint: path.join(f.root, 'service', 'control.sock'),
    dispatch: async () => { dispatched = true; throw new Error('UNEXPECTED_REDISPATCH'); }
  });
  const previous = process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
  process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = server.endpoint;
  try {
    const result = await executeTaskWorkflow(f.manifest, createTaskWorkflowRequest(
      'task-ledger', [taskId, 'decision-next-id'], taskId, f.manifest.generation
    ));
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(dispatched, false);
    assert.equal(JSON.parse(result.stdout).entityId, 'HD-1');
    fs.writeFileSync(path.join(f.taskDir, 'plan.md'), 'Unpublished draft\n');
    const mutation = await executeTaskWorkflow(f.manifest, createTaskWorkflowRequest(
      'task-ledger', [taskId, 'finding-upsert', '--stage', 'analysis', '--review-artifact', 'review-analysis.md',
        '--ordinal', '1', '--severity', 'major', '--evidence', 'review-analysis.md#finding-1'], taskId, f.manifest.generation
    ));
    assert.equal(mutation.exitCode, 0, mutation.stdout);
    assert.equal(fs.readFileSync(path.join(f.taskDir, 'plan.md'), 'utf8'), 'Unpublished draft\n');
    const directMutation = await executeTaskWorkflow(f.manifest, createTaskWorkflowRequest(
      'task-ledger', [taskId, 'finding-upsert', '--stage', 'analysis', '--review-artifact', 'review-analysis.md',
        '--ordinal', '2', '--severity', 'major', '--evidence', 'review-analysis.md#finding-2'], taskId, f.manifest.generation
    ));
    assert.equal(directMutation.exitCode, 0, directMutation.stdout);
    assert.match(fs.readFileSync(path.join(f.taskDir, 'task.md'), 'utf8'), /\| AN-2 \|/u);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
    else process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT = previous;
    await server.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

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
  test(`workflow validates and publishes a direct task-directory ${family} artifact`, onPlatforms('linux', 'darwin'), async () => {
    const f = fixture();
    try {
      const artifact = `${family}.md`;
      fs.writeFileSync(path.join(f.taskDir, artifact), content(family));
      const args = family === 'plan' ? ['finalize-local', '--family', family] : ['finalize-summary', '--stage', 'analysis'];
      const command = family === 'plan' ? 'task-artifact' : 'task-review';
      const result = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(result.exitCode, 0, result.stdout);
      assert.equal(result.body.changed, true);
      assert.ok(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8').length > 0);
      assert.match(result.body.artifactSha256, /^[a-f0-9]{64}$/u);
      const direct = fs.readFileSync(path.join(f.taskDir, artifact));
      assert.equal(createHash('sha256').update(direct).digest('hex'), result.body.artifactSha256);
      if (family === 'plan') assert.equal(readArtifactRepairIntent(f.root, taskId, family, artifact)?.state, 'passed');
      const repeated = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(repeated.exitCode, 0, repeated.stdout);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('summary feedback preserves a concurrent direct candidate edit', onPlatforms('linux', 'darwin'), async (t) => {
  const f = fixture();
  const artifact = 'review-analysis.md';
  const candidate = path.join(f.taskDir, artifact);
  const draft = 'New concurrent draft\n';
  const open = fs.promises.open;
  let edited = false;
  t.mock.method(fs.promises, 'open', (...args: Parameters<typeof fs.promises.open>) => {
    if (!edited && String(args[0]).startsWith(path.join(f.taskDir, `.${artifact}.`))) {
      edited = true;
      fs.writeFileSync(candidate, draft);
    }
    return open(...args);
  });
  try {
    fs.writeFileSync(candidate, content('review-analysis'));
    const result = await f.run('task-review', ['finalize-summary', '--stage', 'analysis', '--artifact', artifact]);
    assert.equal(edited, true);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.body.changed, null);
    assert.equal(result.body.error.code, 'TASK_ARTIFACT_WRITE_CONFLICT');
    assert.equal(fs.readFileSync(candidate, 'utf8'), draft);
    assert.equal(fs.readFileSync(candidate, 'utf8'), draft);
    assert.deepEqual(fs.readdirSync(f.taskDir).sort(), ['analysis.md', artifact, 'task.md']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('workflow rejects duplicate options and invalid direct candidates without provenance', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.taskDir, 'plan.md'), '# Invalid candidate\n');
    const invalid = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.body.changed, false);
    const duplicate = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--family', 'code', '--artifact', 'plan.md']);
    assert.equal(duplicate.exitCode, 1);
    assert.match(duplicate.body.error.message, /duplicate option/u);
    assert.equal(fs.readFileSync(path.join(f.taskDir, 'plan.md'), 'utf8'), '# Invalid candidate\n');
    assert.equal(readArtifactRepairIntent(f.root, taskId, 'plan', 'plan.md'), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const operation of ['finalize-local', 'repair'] as const) {
  test(`workflow ${operation} rejects a FIFO and releases the lock for a valid request`, onPlatforms('linux', 'darwin'), async () => {
    const f = fixture();
    const candidate = path.join(f.taskDir, 'plan.md');
    try {
      assert.equal(spawnSync('mkfifo', [candidate]).status, 0);
      // A child bounds the regression itself: blocking open must not hang the test runner.
      const script = `
        import fs from 'node:fs';
        import { executeTaskWorkflow } from ${JSON.stringify(new URL('../../../lib/sandbox/control/workflow-executor.ts', import.meta.url).href)};
        import { createTaskWorkflowRequest } from ${JSON.stringify(new URL('../../../lib/sandbox/control/task-workflow.ts', import.meta.url).href)};
        const manifest = ${JSON.stringify(f.manifest)};
        const args = [${JSON.stringify(taskId)}, ${JSON.stringify(operation)}, '--family', 'plan', '--artifact', 'plan.md'];
        if (${JSON.stringify(operation)} === 'repair') args.push('--expected-sha256', 'a'.repeat(64), '--expected-semantic-digest', 'b'.repeat(64));
        const rejected = await executeTaskWorkflow(manifest, createTaskWorkflowRequest('task-artifact', args, manifest.taskId, manifest.generation));
        fs.unlinkSync(${JSON.stringify(candidate)});
        fs.writeFileSync(${JSON.stringify(candidate)}, ${JSON.stringify(content('plan'))});
        const valid = await executeTaskWorkflow(manifest, createTaskWorkflowRequest('task-artifact', [manifest.taskId, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md'], manifest.taskId, manifest.generation));
        console.log(JSON.stringify({ rejected, valid }));
      `;
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
      const { rejected, valid } = JSON.parse(result.stdout);
      assert.equal(rejected.exitCode, 1);
      assert.equal(JSON.parse(rejected.stdout).changed, false);
      assert.equal(JSON.parse(rejected.stdout).error.code, operation === 'repair' ? 'ARTIFACT_REPAIR_TARGET_INVALID' : 'TASK_ARTIFACT_WRITE_CONFLICT');
      assert.equal(valid.exitCode, 0, valid.stdout);
      assert.equal(fs.readFileSync(path.join(f.taskDir, 'plan.md'), 'utf8'), content('plan'));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('workflow initializes and repairs candidates in the direct task directory', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const initialized = await f.run('task-artifact', ['init', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(initialized.exitCode, 0, initialized.stdout);
    const candidate = path.join(f.taskDir, 'plan.md');
    assert.ok(fs.existsSync(candidate));
    fs.writeFileSync(candidate, content('plan').replace('## 问题理解\n', '## 问题理解：\n'));
    const invalid = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(invalid.body.repairable, true, invalid.stdout);
    const repaired = await f.run('task-artifact', ['repair', '--family', 'plan', '--artifact', 'plan.md',
      '--expected-sha256', invalid.body.artifactSha256, '--expected-semantic-digest', invalid.body.semanticDigest]);
    assert.equal(repaired.exitCode, 0, repaired.stdout);
    assert.equal(fs.readFileSync(candidate, 'utf8'), content('plan'));
    assert.equal(fs.existsSync(path.join(f.taskDir, 'plan.md')), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('workflow rejects candidates outside the authoritative round and inventory', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    for (const family of ['plan', 'review-analysis'] as const) {
      const artifact = `${family}-r3.md`;
      fs.writeFileSync(path.join(f.taskDir, artifact), content(family));
      const command = family === 'plan' ? 'task-artifact' : 'task-review';
      const args = family === 'plan' ? ['finalize-local', '--family', family] : ['finalize-summary', '--stage', 'analysis'];
      const result = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(result.exitCode, 1, result.stdout);
      assert.equal(result.body.changed, false);
      assert.equal(fs.existsSync(path.join(f.taskDir, artifact)), true);
      assert.equal(readArtifactRepairIntent(f.root, taskId, family, artifact), null);
    }
    fs.writeFileSync(path.join(f.taskDir, 'plan.md'), content('plan'));
    const taskPath = path.join(f.taskDir, 'task.md');
    fs.appendFileSync(taskPath, '- 2026-01-01 00:01:00+00:00 — **Plan Task (Round 1)** by codex — done\n');
    const closed = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(closed.exitCode, 1, closed.stdout);
    assert.equal(fs.existsSync(path.join(f.taskDir, 'plan.md')), true);
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

test('local artifact preparation defers both success and repair provenance until commit', () => {
  for (const repairable of [false, true]) {
    const f = fixture();
    try {
      const candidate = repairable ? content('plan').replace('## 问题理解\n', '## 问题理解：\n') : content('plan');
      const prepared = prepareLocalArtifact({ taskRef: taskId, family: 'plan', artifact: 'plan.md', repoRoot: f.root }, candidate);
      assert.equal(prepared.result.repairable, repairable);
      assert.equal(prepared.result.status, repairable ? 'failed' : 'passed');
      assert.equal(prepared.content, candidate);
      assert.equal(fs.existsSync(path.join(f.taskDir, 'plan.md')), false);
      assert.equal(readArtifactRepairIntent(f.root, taskId, 'plan', 'plan.md'), null);
      assert.deepEqual(commitLocalArtifactProvenance(prepared), prepared.result);
      const intent = readArtifactRepairIntent(f.root, taskId, 'plan', 'plan.md');
      assert.equal(intent?.state, repairable ? 'awaiting-repair' : 'passed');
      assert.equal(intent?.artifactSha256, prepared.result.artifactSha256);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
