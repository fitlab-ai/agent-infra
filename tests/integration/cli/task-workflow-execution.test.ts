import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { renderArtifactSkeleton } from '../../../lib/task/artifact-schema.ts';
import { readArtifactRecoveryIntent } from '../../../lib/task/artifact-repair-intent.ts';
import {
  beginArtifactRecovery,
  commitArtifactRecovery,
  prepareArtifactRecoveryFinal,
  prepareArtifactRecoveryCommit,
  stageArtifactCandidate
} from '../../../lib/task/artifact-recovery.ts';
import { prepareLocalArtifact, commitLocalArtifactProvenance } from '../../../lib/task/local-artifact-finalization.ts';
import { executeTaskWorkflow } from '../../../lib/sandbox/control/workflow-executor.ts';
import { createTaskWorkflowRequest } from '../../../lib/sandbox/control/task-workflow.ts';
import type { SandboxControlManifest } from '../../../lib/sandbox/control/protocol.ts';
import { TASK_WORKFLOW_COMMANDS, TASK_WORKFLOW_OPERATIONS } from '../../../lib/task/workflow-command.ts';
import { onPlatforms } from '../../helpers.ts';

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

test('authorized workflow executor dispatches without a global host service', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const result = await executeTaskWorkflow(f.manifest, createTaskWorkflowRequest(
      'task-ledger', [taskId, 'decision-next-id'], taskId, f.manifest.generation
    ));
    assert.equal(result.exitCode, 0, result.stdout);
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

function workflowArgs(operation: typeof TASK_WORKFLOW_OPERATIONS[number]): string[] {
  switch (operation) {
    case 'artifact-inspect': return [taskId, 'inspect', '--family', 'plan'];
    case 'artifact-init': return [taskId, 'init', '--family', 'plan', '--artifact', 'plan.md'];
    case 'artifact-preflight': return [taskId, 'preflight', '--family', 'plan', '--artifact', 'plan.md'];
    case 'artifact-finalize-local': return [taskId, 'finalize-local', '--family', 'plan', '--artifact', 'plan.md'];
    case 'review-preflight': return [taskId, 'preflight', '--stage', 'analysis', '--artifact', 'review-analysis.md'];
    case 'review-finalize-summary': return [taskId, 'finalize-summary', '--stage', 'analysis', '--artifact', 'review-analysis.md'];
    case 'event': return [taskId, 'plan.started', '--agent', 'codex', '--initiator', 'model', '--request-id', 'workflow-fault-event', '--reason-code', 'user-request'];
    case 'ledger-finding-response': return [taskId, 'finding-respond', '--id', 'AN-1', '--round', '1', '--status', 'accepted', '--evidence', 'code-r2.md:1'];
    case 'ledger-finding-review': return [taskId, 'finding-review', '--id', 'AN-1', '--status', 'confirmed', '--evidence', 'review-analysis.md#finding-1'];
    case 'ledger-finding-upsert': return [taskId, 'finding-upsert', '--stage', 'analysis', '--review-artifact', 'review-analysis.md', '--ordinal', '1', '--severity', 'major', '--evidence', 'review-analysis.md#finding-1'];
    case 'decision-next-id': return [taskId, 'decision-next-id'];
    case 'decision-upsert': return [taskId, 'decision-upsert', '--id', 'HD-1', '--stage', 'plan', '--artifact', 'plan.md'];
    case 'invalidation-reconcile': return [taskId, 'reconcile'];
    case 'warning-add': return [taskId, 'add', '--step', 'code', '--severity', 'IMPORTANT', '--code', 'FAULT_MATRIX', '--target', 'workflow', '--message', 'fault test', '--action', 'retry'];
  }
}

function workflowStateSnapshot(root: string): string {
  const stateRoot = path.join(root, '.agents');
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(stateRoot, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) entries.push(`${relative}:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`);
    }
  };
  visit(stateRoot);
  return entries.join('\n');
}

test('every workflow operation is isolated across the four termination windows', onPlatforms('linux', 'darwin'), async () => {
  const windows = ['before-call', 'before-domain-write', 'after-atomic-rename', 'before-result-return'] as const;
  for (const operation of TASK_WORKFLOW_OPERATIONS) {
    const operationWindows = operation === 'artifact-preflight'
      ? windows.filter((window) => window !== 'after-atomic-rename')
      : windows;
    for (const window of operationWindows) {
      const f = fixture();
      try {
        if (operation === 'artifact-preflight' || operation === 'artifact-finalize-local') fs.writeFileSync(path.join(f.taskDir, 'plan.md'), content('plan'));
        if (operation === 'review-preflight' || operation === 'review-finalize-summary') fs.writeFileSync(path.join(f.taskDir, 'review-analysis.md'), content('review-analysis'));
        const [command] = TASK_WORKFLOW_COMMANDS[operation];
        const request = createTaskWorkflowRequest(command, workflowArgs(operation), taskId, f.manifest.generation);
        const before = workflowStateSnapshot(f.root);
        const result = await executeTaskWorkflow(f.manifest, request, null, { faultWindow: window });
        const body = JSON.parse(result.stdout);
        const afterFault = workflowStateSnapshot(f.root);
        const interruptedIntent = operation === 'review-finalize-summary' && window === 'after-atomic-rename'
          ? readArtifactRecoveryIntent(f.root, taskId, 'review-analysis', 'review-analysis.md')
          : null;
        assert.equal(result.exitCode, 1, `${operation}/${window}: ${result.stdout}`);
        assert.equal(body.error.code, 'TASK_WORKFLOW_FAULT_INJECTED', `${operation}/${window}: ${result.stdout}`);
        assert.match(body.error.message, new RegExp(`:${window}$`), `${operation}/${window}: ${result.stdout}`);
        if (window === 'before-call' || window === 'before-domain-write') {
          assert.equal(body.changed, false, `${operation}/${window} must be known not applied`);
          assert.equal(afterFault, before, `${operation}/${window} wrote before its fault point`);
          continue;
        }
        const replay = await executeTaskWorkflow(f.manifest, request);
        const replayBody = JSON.parse(replay.stdout);
        const afterReplay = workflowStateSnapshot(f.root);
        const published = afterFault !== before;
        assert.equal(body.changed, published ? null : false, `${operation}/${window} must classify its native publication state`);
        if ((operation === 'review-preflight' || operation === 'review-finalize-summary') && window === 'after-atomic-rename') {
          if (operation === 'review-finalize-summary') {
            assert.equal(interruptedIntent?.state, 'commit-started', `${operation}/${window} must stop after the formal rename`);
          }
          assert.notEqual(afterReplay, afterFault, `${operation}/${window} replay must record the reconciled terminal fact`);
          const settled = await executeTaskWorkflow(f.manifest, request);
          assert.equal(workflowStateSnapshot(f.root), afterReplay, `${operation}/${window} settled replay must not rewrite the artifact`);
          assert.equal(JSON.parse(settled.stdout).changed, false, `${operation}/${window} settled replay must remain a no-op`);
        } else {
          assert.equal(afterReplay, afterFault, `${operation}/${window} replay must reconcile the native terminal fact without rewriting it`);
        }
        assert.equal(replayBody.changed, false, `${operation}/${window} replay must not automatically publish again`);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
  }
});

test('workflow finalize-local reconciles an interrupted publication without a recovery id', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const artifact = 'plan.md';
    const formalPath = path.join(f.taskDir, artifact);
    const candidate = content('plan');
    fs.writeFileSync(formalPath, '# provisional\n');
    const recovery = beginArtifactRecovery(
      { taskId, family: 'plan', artifact, round: 1, requestId: 'interrupted-local-finalize' },
      Buffer.from('# provisional\n'),
      { repoRoot: f.root, taskDir: f.taskDir, recoveryId: 'abcde-00000000009' }
    );
    const staged = stageArtifactCandidate(recovery, Buffer.from(candidate));
    prepareArtifactRecoveryCommit(recovery, staged.candidateSha256, staged.semanticDigest);
    assert.equal(commitArtifactRecovery(recovery).state, 'preflight-passed');
    prepareArtifactRecoveryFinal(recovery, Buffer.from(candidate));
    assert.throws(() => commitArtifactRecovery(recovery, { afterPublish: () => { throw new Error('injected interruption'); } }), /lifecycle task lock operation failed/u);
    assert.equal(readArtifactRecoveryIntent(f.root, taskId, 'plan', artifact)?.state, 'commit-started');

    const replay = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', artifact]);
    assert.equal(replay.exitCode, 0, replay.stdout);
    assert.equal(replay.body.changed, false);
    assert.equal(readArtifactRecoveryIntent(f.root, taskId, 'plan', artifact)?.state, 'passed');
    assert.equal(fs.readFileSync(formalPath, 'utf8'), candidate);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

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
      assert.equal(result.body.changed, family === 'plan' ? false : true);
      assert.ok(fs.readFileSync(path.join(f.taskDir, artifact), 'utf8').length > 0);
      assert.match(result.body.artifactSha256, /^[a-f0-9]{64}$/u);
      const direct = fs.readFileSync(path.join(f.taskDir, artifact));
      assert.equal(createHash('sha256').update(direct).digest('hex'), result.body.artifactSha256);
      if (family === 'plan') assert.equal(readArtifactRecoveryIntent(f.root, taskId, family, artifact)?.state, 'passed');
      const repeated = await f.run(command, [...args, '--artifact', artifact]);
      assert.equal(repeated.exitCode, 0, repeated.stdout);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

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
    assert.equal(readArtifactRecoveryIntent(f.root, taskId, 'plan', 'plan.md')?.state, 'awaiting-preflight-recovery');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('workflow preflight seals an active generation without publishing or finalizer audit', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const artifact = path.join(f.taskDir, 'plan.md');
    const baseline = content('plan');
    fs.writeFileSync(artifact, baseline);

    const result = await f.run('task-artifact', ['preflight', '--family', 'plan', '--artifact', 'plan.md']);

    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.body.status, 'passed');
    assert.equal(result.body.changed, false);
    assert.equal(fs.readFileSync(artifact, 'utf8'), baseline);
    const intent = readArtifactRecoveryIntent(f.root, taskId, 'plan', 'plan.md');
    assert.equal(intent?.state, 'preflight-ready');
    assert.ok(intent?.activeGenerationSha256);
    assert.equal(fs.existsSync(path.join(f.taskDir, '.local-artifact-recovery', intent!.stagingId, 'generations', `${intent!.activeGenerationSha256}.md`)), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const operation of ['finalize-local'] as const) {
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
      assert.equal(JSON.parse(rejected.stdout).error.code, 'TASK_ARTIFACT_WRITE_CONFLICT');
      assert.equal(valid.exitCode, 0, valid.stdout);
      assert.equal(fs.readFileSync(path.join(f.taskDir, 'plan.md'), 'utf8'), content('plan'));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('workflow initializes and retries invalid candidates through the recovery journal', onPlatforms('linux', 'darwin'), async () => {
  const f = fixture();
  try {
    const initialized = await f.run('task-artifact', ['init', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(initialized.exitCode, 0, initialized.stdout);
    const candidate = path.join(f.taskDir, 'plan.md');
    assert.ok(fs.existsSync(candidate));
    fs.writeFileSync(candidate, content('plan').replace('## 问题理解\n', '## 问题理解：\n'));
    const invalid = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md']);
    assert.equal(invalid.body.status, 'failed', invalid.stdout);
    assert.ok(invalid.body.recovery?.recoveryId, invalid.stdout);
    fs.writeFileSync(invalid.body.recovery.candidatePath, content('plan'));
    const repaired = await f.run('task-artifact', ['finalize-local', '--family', 'plan', '--artifact', 'plan.md', '--recovery-id', invalid.body.recovery.recoveryId]);
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
      assert.equal(readArtifactRecoveryIntent(f.root, taskId, family, artifact), null);
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
    assert.equal(readArtifactRecoveryIntent(f.root, taskId, 'plan', 'plan.md'), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('local artifact preparation stages the baseline and commits only after validation', () => {
  for (const invalid of [false, true]) {
    const f = fixture();
    try {
      const candidate = invalid ? content('plan').replace('## 问题理解\n', '## 问题理解：\n') : content('plan');
      fs.writeFileSync(path.join(f.taskDir, 'plan.md'), candidate);
      const prepared = prepareLocalArtifact({ taskRef: taskId, family: 'plan', artifact: 'plan.md', repoRoot: f.root }, candidate);
      assert.equal(prepared.result.status, invalid ? 'failed' : 'passed');
      assert.equal(prepared.content, candidate);
      assert.equal(fs.readFileSync(path.join(f.taskDir, 'plan.md'), 'utf8'), candidate);
      if (!invalid) assert.equal(commitLocalArtifactProvenance(prepared).status, 'passed');
      const intent = readArtifactRecoveryIntent(f.root, taskId, 'plan', 'plan.md');
      assert.equal(intent?.state, invalid ? 'awaiting-preflight-recovery' : 'passed');
      assert.equal(intent?.candidateSha256, invalid ? intent?.baselineSha256 : prepared.result.artifactSha256);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});
