import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { filePath, gitSafeEnv, INTERNAL_CLI_PATH, sandboxControlSafeEnv } from '../../helpers.ts';
import { sha256File, upsertArtifactReceipt } from '../../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../../lib/task/sections.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-orchestration-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\nstatus: active\ncurrent_step: requirement-analysis\n---\n\n# Task\n\n## Activity Log\n`);
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  return { root, id, dir };
}

function run(root: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync('node', [INTERNAL_CLI_PATH, 'task-orchestration', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: sandboxControlSafeEnv(gitSafeEnv(env))
  });
}

function addReceipt(taskDir: string, receipt: Parameters<typeof upsertArtifactReceipt>[1]) {
  const taskPath = path.join(taskDir, 'task.md');
  const content = fs.readFileSync(taskPath, 'utf8');
  const mutation = upsertArtifactReceipt(content, receipt);
  fs.writeFileSync(taskPath, upsertSection(content, mutation).content);
}

function approvedRouteFixture(prFlow: 'required' | 'disabled' | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-orchestration-route-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:fitlab-ai/agent-infra.git'], { cwd: root });
  const id = 'TASK-20260101-000001';
  const dir = path.join(root, '.agents', 'workspace', 'active', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.agents/workspace/\nfake-gh.cjs\npr.json\ncalls.jsonl\n');
  fs.writeFileSync(path.join(root, 'source.ts'), 'baseline\n');
  const config = { platform: { type: 'github' }, ...(prFlow === undefined ? {} : { prFlow }) };
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), `${JSON.stringify(config)}\n`);
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${id}\ncurrent_step: code-review\npr_number: 42\nlast_reviewed_commit: ${head}\n---\n\n# Task\n`);
  fs.writeFileSync(path.join(dir, 'analysis.md'), '# Analysis\n');
  fs.writeFileSync(path.join(dir, 'review-analysis.md'), '# Review\n\n- **审查输入**：`analysis.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(dir, 'review-plan.md'), '# Review\n\n- **审查输入**：`plan.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  fs.writeFileSync(path.join(dir, 'code.md'), '# Code\n');
  fs.writeFileSync(path.join(dir, 'review-code.md'), '# Review\n\n- **审查输入**：`code.md`\n\n## 审查摘要\n\n- **总体结论**：通过\n- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0\n');
  const completedAt = '2026-01-01 00:00:00+00:00';
  addReceipt(dir, {
    event: 'review-analysis.completed', output: 'review-analysis.md', input: 'analysis.md',
    inputSha256: sha256File(path.join(dir, 'analysis.md')), completedAt
  });
  addReceipt(dir, {
    event: 'review-plan.completed', output: 'review-plan.md', input: 'plan.md',
    inputSha256: sha256File(path.join(dir, 'plan.md')), completedAt
  });
  addReceipt(dir, {
    event: 'code.completed', output: 'code.md', input: 'plan.md',
    inputSha256: sha256File(path.join(dir, 'plan.md')), completedAt
  });
  addReceipt(dir, {
    event: 'review-code.completed', output: 'review-code.md', input: 'code.md',
    inputSha256: sha256File(path.join(dir, 'code.md')), completedAt
  });
  const fake = path.join(root, 'fake-gh.cjs');
  const pr = path.join(root, 'pr.json');
  const calls = path.join(root, 'calls.jsonl');
  fs.copyFileSync(filePath('tests/fixtures/validate-artifact/fake-gh.js'), fake);
  fs.writeFileSync(pr, JSON.stringify({
    head: { ref: 'fixture-head', sha: head, repo: { full_name: 'fitlab-ai/agent-infra' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'fitlab-ai/agent-infra' } }
  }));
  const env = {
    AGENT_INFRA_GH_BIN: process.execPath,
    AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
    GH_FAKE_PR_PATH: pr,
    GH_FAKE_ARGS_PATH: calls
  };
  return { root, id, dir, calls, env };
}

const explicitPolicyArgs = [
  '--client', 'claude-code',
  '--executor-model', 'executor-model', '--executor-reasoning-effort', 'xhigh',
  '--reviewer-model', 'reviewer-model', '--reviewer-reasoning-effort', 'high'
];

test('task-orchestration begins idempotently and exposes a structured route', () => {
  const f = fixture();
  const begin = run(f.root, [f.id, 'begin-or-resume', '--max-steps', '8',
    ...explicitPolicyArgs]);
  assert.equal(begin.status, 0, begin.stderr);
  const begun = JSON.parse(begin.stdout);
  assert.equal(begun.status, 'running');
  assert.equal(begun.changed, true);
  assert.equal(begun.run.maxSteps, 8);
  assert.deepEqual(begun.run.modelPolicy, {
    executor: { model: 'executor-model', reasoningEffort: 'xhigh' },
    reviewer: { model: 'reviewer-model', reasoningEffort: 'high' }
  });
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), true);

  const second = run(f.root, [f.id, 'begin-or-resume', '--client', 'claude-code']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).changed, false);

  const route = run(f.root, [f.id, 'route']);
  assert.equal(route.status, 0, route.stderr);
  assert.deepEqual(JSON.parse(route.stdout).next, {
    action: 'analyze-task', role: 'executor', stage: 'analysis', round: 1,
    artifact: 'analysis.md', requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh'
  });
});

test('task-orchestration reports current-structure state errors without rewriting persisted input', () => {
  const f = fixture();
  const begun = run(f.root, [f.id, 'begin-or-resume', ...explicitPolicyArgs]);
  assert.equal(begun.status, 0, begun.stderr);
  const runPath = path.join(f.dir, 'orchestration.json');
  const invalid = { ...JSON.parse(fs.readFileSync(runPath, 'utf8')), schemaVersion: 3 };
  const serialized = `${JSON.stringify(invalid, null, 2)}\n`;
  fs.writeFileSync(runPath, serialized);

  const result = run(f.root, [f.id, 'status']);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'failed',
    changed: false,
    taskId: f.id,
    run: null,
    next: null,
    error: {
      code: 'ORCHESTRATION_STATE_INVALID',
      message: 'orchestration.json does not match the current runtime structure; finish or clear active runs before upgrading'
    }
  });
  assert.equal(fs.readFileSync(runPath, 'utf8'), serialized);
});

test('task-orchestration rejects duplicate and unknown options without writing state', () => {
  const f = fixture();
  const result = run(f.root, [f.id, 'begin-or-resume', '--max-steps', '8', '--max-steps', '9']);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'ORCHESTRATION_PAYLOAD_INVALID');
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), false);
});

test('task-orchestration rejects partial model policy options before core state changes', () => {
  const f = fixture();
  const first = run(f.root, [f.id, 'begin-or-resume', '--client', 'claude-code',
    '--executor-model', 'executor-model']);
  assert.equal(first.status, 2);
  assert.equal(JSON.parse(first.stdout).error.code, 'ORCHESTRATION_PAYLOAD_INVALID');
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), false);

  assert.equal(run(f.root, [f.id, 'begin-or-resume', ...explicitPolicyArgs]).status, 0);
  const runPath = path.join(f.dir, 'orchestration.json');
  const before = fs.readFileSync(runPath);
  const reentry = run(f.root, [f.id, 'begin-or-resume', '--client', 'claude-code',
    '--reviewer-model', 'reviewer-model']);
  assert.equal(reentry.status, 2);
  assert.equal(JSON.parse(reentry.stdout).error.code, 'ORCHESTRATION_PAYLOAD_INVALID');
  assert.deepEqual(fs.readFileSync(runPath), before);
});

test('task-orchestration accepts one model for both orchestration roles', () => {
  const f = fixture();
  const result = run(f.root, [f.id, 'begin-or-resume',
    '--client', 'claude-code',
    '--executor-model', 'shared-model', '--executor-reasoning-effort', 'high',
    '--reviewer-model', 'shared-model', '--reviewer-reasoning-effort', 'high']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).run.modelPolicy, {
    executor: { model: 'shared-model', reasoningEffort: 'high' },
    reviewer: { model: 'shared-model', reasoningEffort: 'high' }
  });
});

test('task-orchestration prepare fails closed before delegation for clients without orchestration capability', () => {
  const f = fixture();
  const explicitAntigravityPolicyArgs = [
    '--client', 'antigravity-cli',
    '--executor-model', 'executor-model', '--executor-reasoning-effort', 'xhigh',
    '--reviewer-model', 'reviewer-model', '--reviewer-reasoning-effort', 'high'
  ];
  assert.equal(run(f.root, [f.id, 'begin-or-resume', ...explicitAntigravityPolicyArgs]).status, 0);
  const runPath = path.join(f.dir, 'orchestration.json');
  const before = fs.readFileSync(runPath);

  const prepared = run(f.root, [f.id, 'prepare', '--client', 'antigravity-cli',
    '--requested-model', 'executor-model', '--requested-reasoning-effort', 'xhigh']);
  assert.equal(prepared.status, 1, prepared.stderr);
  const result = JSON.parse(prepared.stdout);
  assert.equal(result.error.code, 'ORCHESTRATION_CLIENT_UNSUPPORTED');
  assert.deepEqual(fs.readFileSync(runPath), before);
});

test('task-orchestration prepares a real Claude Code delegation now that lifecycle orchestration is supported (AC-1)', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'begin-or-resume', ...explicitPolicyArgs]).status, 0);

  const prepared = run(f.root, [f.id, 'prepare', '--client', 'claude-code',
    '--requested-model', 'executor-model', '--requested-reasoning-effort', 'xhigh']);
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout);
  assert.equal(result.error, null);
  assert.ok(result.run.pendingDelegation);
});

test('task-orchestration hook-stop explicit taskRef branch forwards model/effort evidence like the auto branch (PL-3)', () => {
  const f = fixture();
  assert.equal(run(f.root, [f.id, 'begin-or-resume', ...explicitPolicyArgs]).status, 0);
  const runPath = path.join(f.dir, 'orchestration.json');
  const before = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const stageCompleted = {
    ...before,
    pendingDelegation: {
      id: 'receipt-explicit-seal', taskId: f.id, runId: before.runId, role: 'executor',
      stage: 'analysis', round: 1, artifact: 'analysis.md', client: 'claude-code',
      requestedModel: 'executor-model', requestedReasoningEffort: 'xhigh',
      actualModel: null, actualReasoningEffort: null,
      modelFallbackReason: null, reasoningEffortFallbackReason: null,
      parentId: 'parent-1', childId: 'child-1', spawnMode: null, agent: 'claude',
      status: 'stage-completed', workspaceSnapshotScope: 'task',
      lifecycleProvenance: null, hostEvidence: null,
      beforeFingerprint: 'before', afterFingerprint: null,
      changedPaths: [], createdAt: '2026-01-01T00:00:00.000Z',
      preparedMonotonicMs: 0, spawnDispatchMonotonicMs: 0, activationDeadlineMonotonicMs: 15000,
      spawnDispatchedAt: '2026-01-01T00:00:00.000Z', activationDeadlineAt: '2026-01-01T00:00:15.000Z',
      startEvidenceMonotonicMs: 1, activatedMonotonicMs: 1, activatedAt: '2026-01-01T00:00:01.000Z',
      sealedAt: null, consumedAt: null
    }
  };
  fs.writeFileSync(runPath, `${JSON.stringify(stageCompleted, null, 2)}\n`);

  const sealed = run(f.root, [f.id, 'hook-stop',
    '--child-id', 'child-1', '--exit-code', '0', '--after-fingerprint', 'after',
    '--actual-model', 'host-model-v2', '--actual-reasoning-effort', 'high']);
  assert.equal(sealed.status, 0, sealed.stderr);
  const result = JSON.parse(sealed.stdout);
  assert.equal(result.error, null);
  assert.equal(result.run.pendingDelegation.status, 'sealed');
  assert.equal(result.run.pendingDelegation.actualModel, 'host-model-v2');
  assert.equal(result.run.pendingDelegation.actualReasoningEffort, 'high');
});

test('task-orchestration begin fails closed when model policy is omitted', () => {
  const f = fixture();
  const missingClient = run(f.root, [f.id, 'begin-or-resume']);
  assert.equal(missingClient.status, 2);
  const result = run(f.root, [f.id, 'begin-or-resume', '--client', 'claude-code']);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'ORCHESTRATION_MODEL_POLICY_REQUIRED');
  assert.equal(payload.error.modelSelectionContext.kind, 'interactive-only');
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), false);
});

test('task-orchestration falls back to the selected client project policy only', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, '.agents', '.airc.json'), `${JSON.stringify({
    agentClients: ['claude-code', 'codex', 'antigravity-cli', 'opencode', 'traecli'].map((id) => ({
      id,
      enabled: true,
      installInSandbox: true,
      ...(id === 'claude-code' ? {
        orchestration: {
          executor: { model: 'configured-executor', reasoningEffort: 'high' },
          reviewer: { model: 'configured-reviewer', reasoningEffort: 'medium' }
        }
      } : {})
    }))
  }, null, 2)}\n`);

  const partial = run(f.root, [f.id, 'begin-or-resume', '--client', 'claude-code',
    '--executor-model', 'override-only']);
  assert.equal(partial.status, 2);
  assert.equal(fs.existsSync(path.join(f.dir, 'orchestration.json')), false);

  const result = run(f.root, [f.id, 'begin-or-resume', '--client', 'claude-code']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.run.modelPolicySource.kind, 'project-config');
  assert.equal(payload.run.modelPolicy.executor.model, 'configured-executor');
});

test('task-orchestration CLI completes clean reviewed heads and preserves dirty commit routing', () => {
  const clean = approvedRouteFixture('required');
  assert.equal(run(clean.root, [clean.id, 'begin-or-resume', ...explicitPolicyArgs], clean.env).status, 0);
  const completed = run(clean.root, [clean.id, 'route'], clean.env);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const completedPayload = JSON.parse(completed.stdout);
  assert.equal(completedPayload.status, 'completed');
  assert.equal(completedPayload.next, null);
  assert.equal(completedPayload.run.completionEvidence.kind, 'reviewed-head-clean');

  const dirty = approvedRouteFixture('required');
  assert.equal(run(dirty.root, [dirty.id, 'begin-or-resume', ...explicitPolicyArgs], dirty.env).status, 0);
  fs.writeFileSync(path.join(dirty.root, 'source.ts'), 'dirty\n');
  const commit = run(dirty.root, [dirty.id, 'route'], dirty.env);
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);
  assert.equal(JSON.parse(commit.stdout).next.stage, 'commit');
  assert.equal(fs.existsSync(dirty.calls), false);
});

test('task-orchestration CLI does not inspect PRs when clean completion is disabled or unspecified', () => {
  for (const prFlow of ['disabled', undefined] as const) {
    const f = approvedRouteFixture(prFlow);
    assert.equal(run(f.root, [f.id, 'begin-or-resume', ...explicitPolicyArgs], f.env).status, 0);
    const routed = run(f.root, [f.id, 'route'], f.env);
    assert.equal(routed.status, 0, routed.stderr || routed.stdout);
    assert.equal(JSON.parse(routed.stdout).next.stage, 'commit');
    assert.equal(fs.existsSync(f.calls), false);
  }
});
