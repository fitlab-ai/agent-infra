import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTaskLifecycle, inspectTaskLifecycleProgress, lifecycleIntentCatalog } from '../../../lib/task/lifecycle.ts';
import { sha256File, receiptForOutput, upsertArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';
import { resolveArtifactContext } from '../../../lib/task/artifact-lifecycle.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { supportsPosixModeBits } from '../../helpers.ts';

const TASK_ID = 'TASK-20260101-000001';
const METADATA = {
  timestamp: '2026-07-18 12:00:00+00:00',
  agentInfraVersion: 'v9.9.9'
};

function fixture(state: 'active' | 'blocked' = 'active') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lifecycle-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', state, TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents', 'workspace', 'active'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(
    path.join(taskDir, 'task.md'),
    `---\nid: ${TASK_ID}\nstatus: ${state}\ncurrent_step: code-review\nassigned_to: claude\nupdated_at: old\nagent_infra_version: v9.9.9\ntarget_date:\n${state === 'blocked' ? 'blocked_at: old\n' : ''}---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n\n`
  );
  if (state === 'active') {
    fs.writeFileSync(path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } }, null, 2)}\n`);
  }
  return { repoRoot, taskDir };
}

test('lifecycle catalog exposes the approved closed intent set', () => {
  assert.deepEqual(lifecycleIntentCatalog, [
    'block', 'activate', 'cancel', 'complete', 'close-codescan', 'close-dependabot', 'restore', 'recover-started'
  ]);
});

test('block moves the task, updates one metadata pair, logs a pair, and releases its short id', () => {
  const f = fixture();
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Dependency lands' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.shortId.effect, 'released');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'blocked', TASK_ID, 'task.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /status: blocked/);
  assert.match(content, /blocked_at: 2026-07-18 12:00:00\+00:00/);
  assert.match(content, /agent_infra_version: v9\.9\.9/);
  assert.equal((content.match(/Block Task/g) ?? []).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), 'utf8')).ids, {});
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)), false);
});

test('task move refuses a task-bound sandbox control consumer without changing task or runtime bytes', () => {
  const f = fixture();
  const taskFile = path.join(f.taskDir, 'task.md');
  const registryFile = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  const controlDir = path.join(f.taskDir, '.runtime', 'sandbox-control');
  fs.mkdirSync(controlDir, { recursive: true });
  const manifest = path.join(controlDir, 'manifest.json');
  fs.writeFileSync(manifest, '{"taskId":"fixture"}\n');
  const before = [fs.readFileSync(taskFile), fs.readFileSync(registryFile), fs.readFileSync(manifest)];

  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Stop sandbox' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.error?.code, 'LIFECYCLE_RUNTIME_MOVE_UNSAFE');
  assert.deepEqual([fs.readFileSync(taskFile), fs.readFileSync(registryFile), fs.readFileSync(manifest)], before);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'blocked', TASK_ID)), false);
});

test('task move refuses active or unreadable orchestration state and preserves all bytes', () => {
  for (const content of ['{"status":"running","pendingDelegation":{"id":"receipt"}}\n', '{invalid\n']) {
    const f = fixture();
    const runPath = path.join(f.taskDir, '.runtime', 'orchestration.json');
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(runPath, content);
    const taskFile = path.join(f.taskDir, 'task.md');
    const taskBefore = fs.readFileSync(taskFile);
    const runBefore = fs.readFileSync(runPath);

    const result = applyTaskLifecycle(
      { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Settle run' },
      { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
    );
    assert.equal(result.error?.code, 'LIFECYCLE_RUNTIME_MOVE_UNSAFE');
    assert.deepEqual(fs.readFileSync(taskFile), taskBefore);
    assert.deepEqual(fs.readFileSync(runPath), runBefore);
    assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), false);
  }
});

test('safe task move carries task-owned runtime bytes to the new state intact', () => {
  const f = fixture();
  const runtimeFile = path.join(f.taskDir, '.runtime', 'receipt', 'state.json');
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, '{"stable":true}\n');
  const before = fs.readFileSync(runtimeFile);
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Retry later' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.deepEqual(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'blocked', TASK_ID, '.runtime', 'receipt', 'state.json')), before);
  assert.equal(fs.existsSync(f.taskDir), false);
});

test('complete fills the empty completed mount, preserves task data, and retains its short id', () => {
  const f = fixture();
  const targetDir = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID);
  fs.mkdirSync(targetDir, { recursive: true });
  const registryPath = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  const registryBefore = fs.readFileSync(registryPath);
  const payload = Buffer.from([0, 17, 255, 3]);
  const payloadPath = path.join(f.taskDir, '.runtime', 'payload.bin');
  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, payload, { mode: 0o751 });
  fs.chmodSync(payloadPath, 0o751);
  const linkPath = path.join(f.taskDir, '.runtime', 'payload-link');
  fs.symlinkSync('payload.bin', linkPath);

  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'complete', agent: 'codex' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );

  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.deepEqual(result.completedSteps, ['task-written', 'directory-moved']);
  assert.equal(result.pendingSteps.length, 0);
  assert.equal(result.shortId.effect, 'unchanged');
  assert.deepEqual(fs.readFileSync(registryPath), registryBefore);
  assert.deepEqual(fs.readFileSync(path.join(targetDir, '.runtime', 'payload.bin')), payload);
  if (supportsPosixModeBits()) {
    assert.equal(fs.statSync(path.join(targetDir, '.runtime', 'payload.bin')).mode & 0o111, 0o111);
  }
  assert.equal(fs.readlinkSync(path.join(targetDir, '.runtime', 'payload-link')), 'payload.bin');
  assert.equal(fs.existsSync(path.join(f.taskDir, 'task.md')), false);
  assert.equal(fs.readdirSync(f.taskDir).length, 0);
});

test('dry-run plans the same transition without changing bytes, mtime, directories, or registry', () => {
  const f = fixture();
  const taskFile = path.join(f.taskDir, 'task.md');
  const registry = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  const beforeTask = fs.readFileSync(taskFile);
  const beforeRegistry = fs.readFileSync(registry);
  const beforeMtime = fs.statSync(taskFile).mtimeMs;
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'complete', agent: 'codex', dryRun: true },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'planned');
  assert.deepEqual(fs.readFileSync(taskFile), beforeTask);
  assert.deepEqual(fs.readFileSync(registry), beforeRegistry);
  assert.equal(fs.statSync(taskFile).mtimeMs, beforeMtime);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);
});

test('invalid transition fails before any side effect', () => {
  const f = fixture('blocked');
  const file = path.join(f.taskDir, 'task.md');
  const before = fs.readFileSync(file);
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'complete', agent: 'codex' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'LIFECYCLE_SOURCE_INVALID');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), false);
});

test('same completed intent replays as no-op without duplicate log entries', () => {
  const f = fixture();
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  assert.equal(applyTaskLifecycle(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA }).status, 'applied');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md');
  const before = fs.readFileSync(target);
  const replay = applyTaskLifecycle(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
  assert.equal(replay.status, 'no-op');
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal((fs.readFileSync(target, 'utf8').match(/Complete Task/g) ?? []).length, 2);
});

test('activate clears terminal fields, moves to active, and allocates a short id', () => {
  const f = fixture('blocked');
  fs.appendFileSync(path.join(f.taskDir, 'task.md'), '');
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'activate', agent: 'codex', note: 'Dependency landed' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.shortId.effect, 'allocated');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /status: active/);
  assert.match(content, /assigned_to: codex/);
  assert.equal(/^blocked_at:/m.test(content), false);
  assert.match(content, /## Review Disagreement Ledger/);
  assert.equal(result.shortId.shortId, '01');
});

test('activate rejects a blocked task with a missing ledger before journal, directory, or registry mutation', () => {
  const f = fixture('blocked');
  const taskPath = path.join(f.taskDir, 'task.md');
  const original = fs.readFileSync(taskPath, 'utf8');
  const missingLedger = original.replace(
    /## Review Disagreement Ledger\n\n\| id \| stage \| round \| severity \| status \| evidence \|\n\|----\|-------\|-------\|----------\|--------\|----------\|\n\n/,
    ''
  );
  fs.writeFileSync(taskPath, missingLedger);
  const beforeMtime = fs.statSync(taskPath).mtimeMs;
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'activate', agent: 'codex', note: 'Dependency landed' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'LIFECYCLE_DOCUMENT_INVALID');
  assert.match(result.error?.message ?? '', /LEDGER_SECTION_MISSING/);
  assert.equal(fs.readFileSync(taskPath, 'utf8'), missingLedger);
  assert.equal(fs.statSync(taskPath).mtimeMs, beforeMtime);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json')), false);
});

test('activate rejects an invalid target metadata version before lifecycle mutation', () => {
  const f = fixture('blocked');
  const taskPath = path.join(f.taskDir, 'task.md');
  const before = fs.readFileSync(taskPath);
  const beforeMtime = fs.statSync(taskPath).mtimeMs;
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'activate', agent: 'codex', note: 'Dependency landed' },
    { repoRoot: f.repoRoot, metadataProvider: () => ({ timestamp: METADATA.timestamp, agentInfraVersion: 'unknown' }) }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'LIFECYCLE_DOCUMENT_INVALID');
  assert.match(result.error?.message ?? '', /valid v-prefixed semver/);
  assert.deepEqual(fs.readFileSync(taskPath), before);
  assert.equal(fs.statSync(taskPath).mtimeMs, beforeMtime);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json')), false);
});

test('security completion records the alert payload in its canonical done note', () => {
  const f = fixture();
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'close-codescan', agent: 'codex', alertNumber: 17, reason: 'false positive' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
  assert.match(content, /Code Scanning alert #17 dismissed: false positive/);
});

test('restore validates staging before exposing active and allocates a short id', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-restore-'));
  const staging = path.join(repoRoot, '.agents', 'workspace', '.restore-staging-1');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(staging, 'task.md'), `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":42}'\nstatus: completed\ncurrent_step: code-review\nupdated_at: old\nagent_infra_version: v0.9.9\n---\n\n# Task\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n\n`);
  fs.writeFileSync(path.join(staging, 'analysis.md'), '# Analysis\n');
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'restore', agent: 'codex', stagingDir: staging, issueNumber: 42 },
    { repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.equal(fs.existsSync(staging), false);
  const target = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md');
  assert.match(fs.readFileSync(target, 'utf8'), /status: active/);
  assert.equal(result.shortId.shortId, '01');
});

test('restore transports task receipts with artifacts without using mtime', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-restore-receipt-'));
  const staging = path.join(repoRoot, '.agents', 'workspace', '.restore-staging-1');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  const taskPath = path.join(staging, 'task.md');
  fs.writeFileSync(taskPath, `---\nid: ${TASK_ID}\nplatform_issue_identity: '{"kind":"number","value":42}'\nstatus: completed\ncurrent_step: code-review\nupdated_at: old\nagent_infra_version: v0.9.9\n---\n\n# Task\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n## Activity Log\n\n`);
  fs.writeFileSync(path.join(staging, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(staging, 'analysis.md'), '# Analysis\n\n## 流程裁定\n\n- **本任务路径**：完整路径。\n- **判定依据**：需要独立审查。\n- **未满足的更高路径条件**：已选最高路径。\n- **升级触发条件**：无。\n');
  fs.writeFileSync(path.join(staging, 'review-plan.md'), '# Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n');
  let content = fs.readFileSync(taskPath, 'utf8');
  const mutation = upsertArtifactReceipt(content, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(staging, 'plan.md')), completedAt: '2026-07-18 12:00:00+00:00'
  });
  content = upsertSection(content, mutation).content;
  const factSpecs = [
    { name: 'analysis.md', event: 'analyze.completed', step: 'Analyze Task' },
    { name: 'plan.md', event: 'plan.completed', step: 'Plan Task' },
    { name: 'review-plan.md', event: 'review-plan.completed', step: 'Review Plan' }
  ];
  const facts = factSpecs.map(({ name, event }) => {
    const file = path.join(staging, name);
    const artifactContent = fs.readFileSync(file, 'utf8');
    return { event, output: name, outputSha256: sha256File(file), semanticDigest: canonicalSemanticDigest(artifactContent), requestId: `restore-${name}`, result: 'completed' };
  });
  const fmEnd = content.indexOf('\n---', 4);
  content = `${content.slice(0, fmEnd)}\ncompletion_facts: '${JSON.stringify(facts)}'${content.slice(fmEnd)}`;
  const completionRows = factSpecs.flatMap(({ name, step }, index) => [
    `- 2026-07-18 11:5${6 + index}:00+00:00 — **${step} (Round 1) [started]** by codex — started`,
    `- 2026-07-18 11:5${6 + index}:30+00:00 — **${step} (Round 1)** by codex — Completed → ${name}`
  ]).join('\n');
  content = content.replace('## Activity Log\n\n', `## Activity Log\n\n${completionRows}\n`);
  fs.writeFileSync(taskPath, content);

  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'restore', agent: 'codex', stagingDir: staging, issueNumber: 42 },
    { repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  const targetTask = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md');
  const restored = fs.readFileSync(targetTask, 'utf8');
  assert.deepEqual(receiptForOutput(restored, 'review-plan.md'), {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'plan.md')),
    completedAt: '2026-07-18 12:00:00+00:00'
  });
  assert.equal(resolveArtifactContext(TASK_ID, 'review-plan', { repoRoot }).status, 'ready');
});

test('duplicate hot directories are rejected before either copy changes', () => {
  const f = fixture();
  const duplicate = path.join(f.repoRoot, '.agents', 'workspace', 'blocked', TASK_ID);
  fs.mkdirSync(path.dirname(duplicate), { recursive: true });
  fs.cpSync(f.taskDir, duplicate, { recursive: true });
  const before = fs.readFileSync(path.join(f.taskDir, 'task.md'));
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Ready' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'LIFECYCLE_IDENTITY_CONFLICT');
  assert.deepEqual(fs.readFileSync(path.join(f.taskDir, 'task.md')), before);
});

test('task write failure preserves source bytes and retries with journal metadata', () => {
  const f = fixture();
  const file = path.join(f.taskDir, 'task.md');
  const before = fs.readFileSync(file);
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  const failed = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA,
    taskFileSystem: { renameSync: () => { throw new Error('injected task rename failure'); } }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'RENAME_FAILED');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), true);
  const recovered = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot,
    metadataProvider: () => ({ timestamp: 'different', agentInfraVersion: 'different' })
  });
  assert.equal(recovered.status, 'applied');
  const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
  assert.match(content, /updated_at: 2026-07-18 12:00:00\+00:00/);
});

test('active recovery rejects invalid journal metadata before resuming any lifecycle step', () => {
  const f = fixture('blocked');
  const request = { taskRef: TASK_ID, intent: 'activate' as const, agent: 'codex', note: 'Dependency landed' };
  const taskPath = path.join(f.taskDir, 'task.md');
  const journalPath = path.join(f.taskDir, '.task-lifecycle.json');
  const failed = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA,
    taskFileSystem: { renameSync: () => { throw new Error('injected task rename failure'); } }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(fs.existsSync(journalPath), true);

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { metadata: { agentInfraVersion: string } };
  journal.metadata.agentInfraVersion = 'unknown';
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const beforeTask = fs.readFileSync(taskPath);
  const beforeTaskMtime = fs.statSync(taskPath).mtimeMs;
  const beforeJournal = fs.readFileSync(journalPath);

  const recovered = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA
  });
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error?.code, 'LIFECYCLE_DOCUMENT_INVALID');
  assert.match(recovered.error?.message ?? '', /journal metadata agentInfraVersion must be a valid v-prefixed semver/);
  assert.deepEqual(fs.readFileSync(taskPath), beforeTask);
  assert.equal(fs.statSync(taskPath).mtimeMs, beforeTaskMtime);
  assert.deepEqual(fs.readFileSync(journalPath), beforeJournal);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)), false);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json')), false);
});

test('complete rejects conflicting completed task content without overwriting either copy', () => {
  const f = fixture();
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'other.txt'), 'existing completed data');
  const sourceTask = fs.readFileSync(path.join(f.taskDir, 'task.md'));
  const sourcePayload = Buffer.from('active payload');
  fs.writeFileSync(path.join(f.taskDir, 'payload.bin'), sourcePayload);
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  const failed = applyTaskLifecycle(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'LIFECYCLE_TARGET_CONFLICT');
  assert.deepEqual(fs.readFileSync(path.join(f.taskDir, 'task.md')), sourceTask);
  assert.deepEqual(fs.readFileSync(path.join(f.taskDir, 'payload.bin')), sourcePayload);
  assert.equal(fs.readFileSync(path.join(target, 'other.txt'), 'utf8'), 'existing completed data');
});
