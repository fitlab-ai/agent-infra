import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import test, { after } from 'node:test';

import {
  envWithPrependedPath,
  INTERNAL_CLI_PATH,
  sandboxControlSafeEnv,
  writeNodeCommandShim
} from '../../helpers.ts';
import { createCodexLifecycleStore } from '../../../lib/agent-clients/adapters/codex-lifecycle/store.ts';
import {
  activateCodexOrchestrationDelegation,
  prepareCodexOrchestrationDelegation
} from '../../../lib/task/codex-orchestration.ts';
import {
  beginOrResumeOrchestration,
  completeOrchestrationStage,
  dispatchOrchestrationDelegation
} from '../../../lib/task/orchestration.ts';
import { appendCodexLifecycleBinding, resolveCodexLifecycleStoreRoot } from '../../../lib/agent-clients/adapters/codex-lifecycle/binding.ts';
const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-cli-'));
  fixtureRoots.add(root);
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['branch', '-M', 'agent-infra-feature-test'], { cwd: root, encoding: 'utf8' }).status, 0);
  const bin = path.join(root, 'bin');
  const codex = path.join(root, 'codex.mjs');
  const rollout = path.join(root, 'rollout-child.jsonl');
  fs.mkdirSync(path.join(root, '.agents', 'workspace'), { recursive: true });
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: {
      id: 'child', parent_thread_id: 'parent', agent_role: 'agent-infra-lifecycle-executor'
    } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'model', effort: 'high' } })
  ].join('\n'));
  fs.writeFileSync(codex, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    if (process.argv[2] === '--version') {
      process.stdout.write('codex-cli 0.147.0\\n');
    } else if (process.argv[2] === 'app-server') {
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (!message.id) return;
        if (message.method === 'thread/read' && process.env.REPLACE_PENDING_RECEIPT) {
          const runPath = process.env.REPLACE_PENDING_RECEIPT;
          const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
          run.pendingDelegation.id = 'receipt-replaced';
          fs.writeFileSync(runPath, JSON.stringify(run, null, 2) + '\\n');
          process.env.REPLACE_PENDING_RECEIPT = '';
        }
        const parentThreadId = process.env.CHILD_PARENT || 'parent';
        const result = message.method === 'thread/read' ? {
          thread: {
            id: 'child', parentThreadId, forkedFromId: null,
            path: ${JSON.stringify(rollout)},
            source: { subAgent: { thread_spawn: { parent_thread_id: parentThreadId } } },
            turns: message.params.includeTurns ? [{ id: 'child-turn', status: process.env.TURN_STATUS || 'completed' }] : []
          }
        } : message.method === 'thread/unsubscribe' ? { status: 'unsubscribed' } : {};
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
      });
    } else {
      process.exit(2);
    }
  `);
  writeNodeCommandShim(path.join(bin, 'codex'), codex);
  const hooks = '{"hooks":{}}\n';
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), hooks);
  for (const file of [
    '.codex/agents/agent-infra-lifecycle-executor.toml',
    '.codex/agents/agent-infra-lifecycle-reviewer.toml',
    '.agents/hooks/lifecycle-delegation.js',
    '.agents/skills/run-task/SKILL.md',
    '.agents/rules/lifecycle-orchestration.md'
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'managed lifecycle contract\n');
  }
  return {
    root,
    env: envWithPrependedPath(sandboxControlSafeEnv({
      ...process.env,
      AGENT_INFRA_RUNTIME_DIR: undefined,
      AGENT_INFRA_TASK_ID: undefined,
      AGENT_INFRA_EXECUTOR_MANIFEST: undefined,
      AGENT_INFRA_CODEX_CONTROLLER_CONTEXT: undefined
    }), bin),
    hookDefinitionHash: crypto.createHash('sha256').update(hooks).digest('hex')
  };
}

function writeCapabilityTask(root: string, taskId: string) {
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\ncurrent_step: requirement-analysis\nagent_infra_version: v0.9.12-alpha.0\n---\n\n# Task\n`);
}

function copyCompiledPackage(root: string) {
  fs.copyFileSync(path.join(process.cwd(), 'package.json'), path.join(root, 'package.json'));
  fs.cpSync(path.join(process.cwd(), 'dist'), path.join(root, 'dist'), { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
}

function rewriteCompiledLauncher(root: string) {
  const file = path.join(root, 'dist', 'bin', 'internal-cli.js');
  const content = fs.readFileSync(file);
  const lineEnd = content.indexOf(0x0a);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('#!/opt/homebrew/opt/node/bin/node\n'),
    content.subarray(lineEnd + 1)
  ]));
}

async function prepareLifecycleTask(root: string, hookDefinitionHash: string) {
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(root, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nstatus: active\nbranch: agent-infra-feature-test\ncurrent_step: requirement-analysis\nagent_infra_version: v0.9.11-alpha.0\n---\n\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n`);
  beginOrResumeOrchestration(taskId, {
    repoRoot: root,
    client: 'codex',
    modelPolicy: {
      executor: { model: 'model', reasoningEffort: 'high' },
      reviewer: { model: 'review-model', reasoningEffort: 'high' }
    },
    id: () => 'run-1'
  });
  const prepared = await prepareCodexOrchestrationDelegation(taskId, {
    client: 'codex', requestedModel: 'model', requestedReasoningEffort: 'high'
  }, {
    repoRoot: root,
    buildIdentity: {
      protocolVersion: 3,
      packageVersion: '0.9.9-alpha.0',
      internalExecutableBuildHash: 'a'.repeat(64),
      lifecycleContractHash: 'b'.repeat(64)
    },
    preflight: async () => ({
      cliVersion: '0.147.0', hookDefinitionHash, staticReady: true as const,
      discoveredHooks: [], runtimeLiveness: false, diagnostics: [],
      hookProvenance: {
        hookSource: 'project' as const,
        hookSourcePathDigest: 'c'.repeat(64), hookSourceHash: 'd'.repeat(64)
      }
    }),
    orchestrationOptions: { captureWorkspace: () => 'before', id: () => 'receipt-1' }
  });
  assert.equal(prepared.status, 'running', JSON.stringify(prepared));
  assert.ok(prepared.lifecycleBindingMarker);
  const taskName = `analysis_executor_r1${prepared.lifecycleBindingMarker}`;
  assert.match(taskName, /^[a-z0-9_]+$/u);
  return {
    taskId,
    taskDir,
    bindingMarker: taskName,
    storeRoot: resolveCodexLifecycleStoreRoot(taskId, { repoRoot: root })
  };
}

function run(root: string, env: NodeJS.ProcessEnv, args: string[], input = '', cliPath = INTERNAL_CLI_PATH) {
  return spawnSync(process.execPath, [cliPath, 'codex-lifecycle', ...args], {
    cwd: root, env, input, encoding: 'utf8'
  });
}

function runBuildFixture(launcherShebang: Record<string, unknown>, executableFiles: readonly string[] = ['bin/internal-cli.ts']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-build-'));
  fixtureRoots.add(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), 'scripts', 'build.js'), path.join(root, 'scripts', 'build.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    version: '0.9.12-alpha.0'
  }));
  const manifest = path.join(root, 'lib', 'agent-clients', 'adapters', 'codex-lifecycle', 'manifest-files.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ executableFiles, contractFiles: [], launcherShebang }));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'internal-cli.ts'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'internal-cli.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, 'lib', 'defaults.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'lib', 'sandbox', 'runtimes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'agent-clients', 'adapters', 'runtimes'), { recursive: true });
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.js')], {
    cwd: root, encoding: 'utf8'
  });
  return { root, result };
}

test('compiled codex-lifecycle CLI rechecks its generated executable identity', () => {
  const { root, env } = fixture();
  const taskId = 'TASK-20260101-000001';
  writeCapabilityTask(root, taskId);

  const result = run(root, env, ['capability-arm', '--task-id', taskId]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'armed');
  assert.equal(payload.error, null);
  assert.equal(payload.buildIdentity.protocolVersion, 3);
  assert.match(payload.buildIdentity.internalExecutableBuildHash, /^[0-9a-f]{64}$/u);
});

test('compiled codex-lifecycle CLI accepts a Homebrew-rewritten launcher in an isolated package', () => {
  const { root, env } = fixture();
  const taskId = 'TASK-20260101-000001';
  writeCapabilityTask(root, taskId);
  copyCompiledPackage(root);
  rewriteCompiledLauncher(root);

  const result = run(
    root,
    env,
    ['capability-arm', '--task-id', taskId],
    '',
    path.join(root, 'dist', 'bin', 'internal-cli.js')
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'armed');
  assert.equal(payload.error, null);
  assert.equal(payload.buildIdentity.protocolVersion, 3);
});

test('build rejects malformed launcher policies before creating a lifecycle manifest', () => {
  for (const [launcherShebang, executableFiles] of [
    [{
      sourceFile: 'bin/internal-cli.ts',
      compiledFile: 'dist/bin/internal-cli.js',
      canonicalLine: '#!/usr/bin/env node\npayload\n',
      acceptedLines: ['#!/usr/bin/env node\npayload\n']
    }, ['bin/internal-cli.ts']],
    [{
      sourceFile: '../outside.ts',
      compiledFile: 'outside.js',
      canonicalLine: '#!/usr/bin/env node\n',
      acceptedLines: ['#!/usr/bin/env node\n']
    }, ['../outside.ts']]
  ] as const) {
    const { root, result } = runBuildFixture(launcherShebang, executableFiles);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(path.join(root, 'dist', 'lifecycle-build-manifest.json')), false);
  }
});

test('codex-lifecycle CLI records normalized hook identity across invocations', async () => {
  const { root, env } = fixture();
  const task = await prepareLifecycleTask(root, 'hash');
  const spawn = run(root, env, ['hook-event', '--event', 'pre-tool'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash: 'hash', taskName: task.bindingMarker
  }));
  assert.equal(spawn.status, 0, `${spawn.stderr}\n${spawn.stdout}`);
  assert.equal(JSON.parse(spawn.stdout).status, 'observed-spawn');

  const child = run(root, env, ['hook-event', '--event', 'subagent-start'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const childState = JSON.parse(child.stdout);
  assert.equal(childState.status, 'observed-child');
  assert.equal(childState.evidence.child.sessionId, 'parent');
  assert.equal(childState.evidence.child.parentThreadId, 'parent');
  assert.equal(fs.existsSync(task.storeRoot), true);
});

test('codex-lifecycle bridge rejects an unbound managed spawn before creating lifecycle state', () => {
  const { root, env, hookDefinitionHash } = fixture();
  const spawn = run(root, env, ['hook-event', '--event', 'pre-tool', '--bridge', 'true'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash
  }));
  assert.equal(spawn.status, 1, `${spawn.stderr}\n${spawn.stdout}`);
  assert.equal(JSON.parse(spawn.stdout).error.code, 'CODEX_LIFECYCLE_FAILED');
  assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', '.runtime')), false);
});

test('codex-lifecycle rejects receipt, branch, and multiple-task mismatches without lifecycle writes', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const originalRun = fs.readFileSync(runPath);
  const event = (taskName: string) => run(root, env, ['hook-event', '--event', 'pre-tool'], JSON.stringify({
    sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash, taskName
  }));

  const wrongReceiptName = appendCodexLifecycleBinding('analysis_executor_r1', {
    taskId: task.taskId, runId: 'run-1', receiptId: 'wrong-receipt'
  });
  const wrongReceipt = event(wrongReceiptName);
  assert.equal(wrongReceipt.status, 1, `${wrongReceipt.stderr}\n${wrongReceipt.stdout}`);
  assert.deepEqual(fs.readFileSync(runPath), originalRun);
  assert.equal(fs.existsSync(task.storeRoot), false);

  assert.equal(spawnSync('git', ['branch', '-M', 'agent-infra-feature-moved'], { cwd: root, encoding: 'utf8' }).status, 0);
  const changedBranch = event(task.bindingMarker);
  assert.equal(changedBranch.status, 1, `${changedBranch.stderr}\n${changedBranch.stdout}`);
  assert.deepEqual(fs.readFileSync(runPath), originalRun);
  assert.equal(fs.existsSync(task.storeRoot), false);

  const secondTaskId = 'TASK-20260101-000002';
  const secondTaskDir = path.join(root, '.agents', 'workspace', 'active', secondTaskId);
  fs.mkdirSync(secondTaskDir, { recursive: true });
  fs.writeFileSync(path.join(secondTaskDir, 'task.md'), `---\nid: ${secondTaskId}\nstatus: active\nbranch: agent-infra-feature-test\ncurrent_step: requirement-analysis\n---\n\n# Task\n`);
  assert.equal(spawnSync('git', ['branch', '-M', 'agent-infra-feature-test'], { cwd: root, encoding: 'utf8' }).status, 0);
  const ambiguous = event(task.bindingMarker);
  assert.equal(ambiguous.status, 1, `${ambiguous.stderr}\n${ambiguous.stdout}`);
  assert.deepEqual(fs.readFileSync(runPath), originalRun);
  assert.equal(fs.existsSync(task.storeRoot), false);
  assert.equal(fs.existsSync(path.join(secondTaskDir, '.runtime')), false);
});

test('codex-lifecycle rejects a stop from an old receipt without changing evidence or the current run', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({
    root: task.storeRoot,
    taskId: task.taskId,
    cliVersion: '0.147.0'
  });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'old-parent-turn', toolUseId: 'old-spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
    requestedReasoningEffort: 'high', hookDefinitionHash,
    taskBinding: { taskId: task.taskId, runId: 'old-run', receiptId: 'old-receipt' }
  });
  store.apply({
    type: 'hook-child', sessionId: 'parent', turnId: 'old-child-turn', childThreadId: 'old-child',
    parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook'
  });

  const evidencePath = path.join(task.storeRoot, `${crypto.createHash('sha256').update('parent\0old-parent-turn\0old-spawn-tool').digest('hex')}.json`);
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const evidenceBefore = fs.readFileSync(evidencePath);
  const runBefore = fs.readFileSync(runPath);
  const result = run(root, env, ['hook-event', '--event', 'subagent-stop'], JSON.stringify({
    sessionId: 'parent', turnId: 'old-child-turn', childThreadId: 'old-child',
    nativeAgent: 'agent-infra-lifecycle-executor', taskName: task.bindingMarker
  }));

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readFileSync(evidencePath), evidenceBefore);
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('codex-lifecycle rejects an ambiguous child event without writing evidence or consuming either spawn', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({
    root: task.storeRoot,
    taskId: task.taskId,
    cliVersion: '0.147.0'
  });
  const binding = { taskId: task.taskId, runId: 'run-1', receiptId: 'receipt-1' };
  for (const [turnId, toolUseId] of [['parent-turn-1', 'spawn-tool-1'], ['parent-turn-2', 'spawn-tool-2']] as const) {
    store.apply({
      type: 'hook-spawn', sessionId: 'parent', turnId, toolUseId,
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash, taskBinding: binding
    });
  }

  const evidenceFiles = fs.readdirSync(task.storeRoot).sort();
  const evidenceBefore = new Map(evidenceFiles.map((name) => [name, fs.readFileSync(path.join(task.storeRoot, name))]));
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const runBefore = fs.readFileSync(runPath);
  const result = run(root, env, ['hook-event', '--event', 'subagent-start'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor', taskName: task.bindingMarker
  }));

  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readdirSync(task.storeRoot).sort(), evidenceFiles);
  for (const name of evidenceFiles) assert.deepEqual(fs.readFileSync(path.join(task.storeRoot, name)), evidenceBefore.get(name));
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
});

test('codex-lifecycle bridge rejects an old receipt child before changing evidence or the current run', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({ root: task.storeRoot, taskId: task.taskId, cliVersion: '0.147.0' });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'old-parent-turn', toolUseId: 'old-spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash,
    taskBinding: { taskId: task.taskId, runId: 'old-run', receiptId: 'old-receipt' }
  });
  const evidenceFiles = fs.readdirSync(task.storeRoot).sort();
  const evidenceBefore = new Map(evidenceFiles.map((name) => [name, fs.readFileSync(path.join(task.storeRoot, name))]));
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const runBefore = fs.readFileSync(runPath);
  const result = run(root, env, ['hook-event', '--event', 'subagent-start', '--bridge', 'true'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readdirSync(task.storeRoot).sort(), evidenceFiles);
  for (const name of evidenceFiles) assert.deepEqual(fs.readFileSync(path.join(task.storeRoot, name)), evidenceBefore.get(name));
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pause, null);
});

test('codex-lifecycle bridge rejects a mismatched resolved parent without changing evidence or the current run', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({ root: task.storeRoot, taskId: task.taskId, cliVersion: '0.147.0' });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash,
    taskBinding: { taskId: task.taskId, runId: 'run-1', receiptId: 'receipt-1' }
  });
  const evidenceFiles = fs.readdirSync(task.storeRoot).sort();
  const evidenceBefore = new Map(evidenceFiles.map((name) => [name, fs.readFileSync(path.join(task.storeRoot, name))]));
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const runBefore = fs.readFileSync(runPath);
  const result = run(root, { ...env, CHILD_PARENT: 'other-parent' }, ['hook-event', '--event', 'subagent-start', '--bridge', 'true'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readdirSync(task.storeRoot).sort(), evidenceFiles);
  for (const name of evidenceFiles) assert.deepEqual(fs.readFileSync(path.join(task.storeRoot, name)), evidenceBefore.get(name));
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pause, null);
});

test('codex-lifecycle bridge rechecks the current receipt after async resolution before writing child evidence', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({ root: task.storeRoot, taskId: task.taskId, cliVersion: '0.147.0' });
  store.apply({
    type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
    nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash,
    taskBinding: { taskId: task.taskId, runId: 'run-1', receiptId: 'receipt-1' }
  });
  const evidenceFiles = fs.readdirSync(task.storeRoot).sort();
  const evidenceBefore = new Map(evidenceFiles.map((name) => [name, fs.readFileSync(path.join(task.storeRoot, name))]));
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const result = run(root, { ...env, REPLACE_PENDING_RECEIPT: runPath }, ['hook-event', '--event', 'subagent-start', '--bridge', 'true'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readdirSync(task.storeRoot).sort(), evidenceFiles);
  for (const name of evidenceFiles) assert.deepEqual(fs.readFileSync(path.join(task.storeRoot, name)), evidenceBefore.get(name));
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pendingDelegation.id, 'receipt-replaced');
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pause, null);
});

test('codex-lifecycle bridge rejects multiple matching spawn records before writing child evidence', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({ root: task.storeRoot, taskId: task.taskId, cliVersion: '0.147.0' });
  for (const [index, turnId, toolUseId] of [[1, 'parent-turn-1', 'spawn-tool-1'], [2, 'parent-turn-2', 'spawn-tool-2']] as const) {
    store.apply({
      type: 'hook-spawn', sessionId: 'parent', turnId, toolUseId,
      nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash,
      taskBinding: { taskId: task.taskId, runId: 'run-1', receiptId: 'receipt-1' }
    });
    if (index === 1) store.apply({
      type: 'hook-child', sessionId: 'parent', turnId: 'other-child-turn', childThreadId: 'other-child',
      parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
    });
  }
  const evidenceFiles = fs.readdirSync(task.storeRoot).sort();
  const evidenceBefore = new Map(evidenceFiles.map((name) => [name, fs.readFileSync(path.join(task.storeRoot, name))]));
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const runBefore = fs.readFileSync(runPath);
  const result = run(root, env, ['hook-event', '--event', 'subagent-start', '--bridge', 'true'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor'
  }));
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(fs.readdirSync(task.storeRoot).sort(), evidenceFiles);
  for (const name of evidenceFiles) assert.deepEqual(fs.readFileSync(path.join(task.storeRoot, name)), evidenceBefore.get(name));
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pause, null);
});

test('codex-lifecycle bridge rejects a same-source child replay with a conflicting turn without changing state in source and compiled CLIs', async () => {
  const invocations: Array<Readonly<Record<string, unknown>>> = [];
  const compiledCli = path.resolve('dist/bin/internal-cli.js');
  for (const [label, cliPath] of [['compiled', compiledCli], ['source', INTERNAL_CLI_PATH]] as const) {
    const { root, env, hookDefinitionHash } = fixture();
    const task = await prepareLifecycleTask(root, hookDefinitionHash);
    const store = createCodexLifecycleStore({ root: task.storeRoot, taskId: task.taskId, cliVersion: '0.147.0' });
    store.apply({
      type: 'hook-spawn', sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
      nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash,
      taskBinding: { taskId: task.taskId, runId: 'run-1', receiptId: 'receipt-1' }
    });
    store.apply({
      type: 'hook-child', sessionId: 'parent', turnId: 'original-child-turn', childThreadId: 'child',
      parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook'
    });
    const namesBefore = fs.readdirSync(task.storeRoot).sort();
    const evidenceBefore = new Map(namesBefore.map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(task.storeRoot, name))).digest('hex')]));
    const runPath = path.join(task.taskDir, 'orchestration.json');
    const runBefore = fs.readFileSync(runPath);

    const result = run(root, env, ['hook-event', '--event', 'subagent-start', '--bridge', 'true'], JSON.stringify({
      sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }), cliPath);

    const record = store.read('child');
    const changedNames = fs.readdirSync(task.storeRoot).sort().filter((name) =>
      crypto.createHash('sha256').update(fs.readFileSync(path.join(task.storeRoot, name))).digest('hex') !== evidenceBefore.get(name)
    );
    const runAfter = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    invocations.push({
      cli: label,
      exitCode: result.status,
      result: result.stdout.trim(),
      evidenceNamesBefore: namesBefore,
      evidenceNamesAfter: fs.readdirSync(task.storeRoot).sort(),
      changedEvidenceFiles: changedNames,
      recordBefore: { revision: 2, status: 'observed-child', turnId: 'original-child-turn' },
      recordAfter: { revision: record.revision, status: record.state.status, turnId: record.state.child?.turnId },
      consumer: record.consumer,
      runBytesUnchanged: fs.readFileSync(runPath).equals(runBefore),
      runStatus: runAfter.status,
      pause: runAfter.pause
    });
  }
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations.map((item) => item.exitCode), [1, 1], JSON.stringify(invocations));
  assert.deepEqual(invocations.map((item) => item.evidenceNamesAfter), invocations.map((item) => item.evidenceNamesBefore), JSON.stringify(invocations));
  assert.deepEqual(invocations.map((item) => item.changedEvidenceFiles), [[], []], JSON.stringify(invocations));
  assert.deepEqual(invocations.map((item) => item.recordAfter), invocations.map((item) => item.recordBefore), JSON.stringify(invocations));
  assert.deepEqual(invocations.map((item) => item.consumer), [null, null], JSON.stringify(invocations));
  assert.deepEqual(invocations.map((item) => item.runBytesUnchanged), [true, true], JSON.stringify(invocations));
  assert.deepEqual(invocations.map((item) => [item.runStatus, item.pause]), [['running', null], ['running', null]], JSON.stringify(invocations));
});

test('codex-lifecycle bridge parent seal rejects multiple current children without pausing or writing', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const store = createCodexLifecycleStore({ root: task.storeRoot, taskId: task.taskId, cliVersion: '0.147.0' });
  for (const [index, childThreadId] of [[1, 'child-1'], [2, 'child-2']] as const) {
    store.apply({
      type: 'hook-spawn', sessionId: 'parent', turnId: `parent-turn-${index}`, toolUseId: `spawn-${index}`,
      nativeAgent: 'agent-infra-lifecycle-executor', hookDefinitionHash,
      taskBinding: { taskId: task.taskId, runId: 'run-1', receiptId: 'receipt-1' }
    });
    store.apply({
      type: 'hook-child', sessionId: 'parent', turnId: `child-turn-${index}`, childThreadId,
      parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
    });
    store.apply({
      type: 'app-thread', childThreadId, parentThreadId: 'parent', forkedFromId: null,
      sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
    });
    store.apply({ type: 'app-settings', childThreadId, model: 'model', reasoningEffort: 'high' });
  }
  const evidenceFiles = fs.readdirSync(task.storeRoot).sort();
  const evidenceBefore = new Map(evidenceFiles.map((name) => [name, fs.readFileSync(path.join(task.storeRoot, name))]));
  const runPath = path.join(task.taskDir, 'orchestration.json');
  const runBefore = fs.readFileSync(runPath);
  const result = run(root, env, ['hook-event', '--event', 'post-tool', '--bridge', 'true'], JSON.stringify({
    toolName: 'collaborationwait_agent', sessionId: 'parent'
  }));
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'CODEX_LIFECYCLE_TASK_BINDING_MISMATCH');
  assert.deepEqual(fs.readFileSync(runPath), runBefore);
  assert.equal(JSON.parse(fs.readFileSync(runPath, 'utf8')).pause, null);
  assert.deepEqual(fs.readdirSync(task.storeRoot).sort(), evidenceFiles);
  for (const name of evidenceFiles) assert.deepEqual(fs.readFileSync(path.join(task.storeRoot, name)), evidenceBefore.get(name));
});

test('Codex SubagentStop bridge records stop before parent reconciliation seals terminal evidence', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  const taskId = task.taskId;
  const taskDir = task.taskDir;
  const buildIdentity = {
    protocolVersion: 3,
    packageVersion: '0.9.9-alpha.0',
    internalExecutableBuildHash: 'a'.repeat(64),
    lifecycleContractHash: 'b'.repeat(64)
  } as const;
  const preflight = async () => ({
    cliVersion: '0.147.0', hookDefinitionHash, staticReady: true as const,
    discoveredHooks: [], runtimeLiveness: false, diagnostics: [],
    hookProvenance: {
      hookSource: 'project' as const,
      hookSourcePathDigest: 'c'.repeat(64), hookSourceHash: 'd'.repeat(64)
    }
  });
  dispatchOrchestrationDelegation(taskId, { repoRoot: root });
  const store = createCodexLifecycleStore({
    root: task.storeRoot,
    taskId,
    cliVersion: '0.147.0'
  });
  for (const event of [
    {
      type: 'hook-spawn' as const, sessionId: 'parent', turnId: 'parent-turn', toolUseId: 'spawn-tool',
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash, taskBinding: {
        taskId, runId: 'run-1', receiptId: 'receipt-1'
      }
    },
    {
      type: 'hook-child' as const, sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      parentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor', source: 'hook' as const
    },
    {
      type: 'app-thread' as const, childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null,
      sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
    },
    { type: 'app-settings' as const, childThreadId: 'child', model: 'model', reasoningEffort: 'high' }
  ]) store.apply(event);
  const activated = await activateCodexOrchestrationDelegation('child', {
    repoRoot: root,
    store,
    buildIdentity,
    preflight,
    resolveThread: async () => ({
      resolution: {
        thread: {
          type: 'app-thread', childThreadId: 'child', parentThreadId: 'parent', forkedFromId: null,
          sourceParentThreadId: 'parent', nativeAgent: 'agent-infra-lifecycle-executor'
        },
        settings: { type: 'app-settings', childThreadId: 'child', model: 'model', reasoningEffort: 'high' }
      },
      reroutes: [], diagnostics: []
    })
  });
  assert.equal(activated.run?.pendingDelegation?.status, 'activated');
  completeOrchestrationStage(taskId, {
    stage: 'analysis', round: 1, artifact: 'analysis.md', agent: 'codex'
  }, { repoRoot: root });

  const stopped = run(root, { ...env, TURN_STATUS: 'failed' }, [
    'hook-event', '--event', 'subagent-stop', '--bridge', 'true'
  ], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor', taskName: task.bindingMarker
  }));
  assert.equal(stopped.status, 0, `${stopped.stderr}\n${stopped.stdout}`);
  const payload = JSON.parse(stopped.stdout);
  assert.equal(payload.status, 'start-ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir, 'orchestration.json'), 'utf8')).pendingDelegation.status, 'stage-completed');
  assert.equal(store.read('child').state.terminal, null);
  assert.equal(store.read('child').state.stop?.turnId, 'child-turn');
});

test('codex-lifecycle CLI rejects unknown and duplicate options', () => {
  const { root, env } = fixture();
  for (const args of [
    ['unknown'],
    ['hook-event', '--event', 'pre-tool', '--event', 'pre-tool'],
    ['consume', '--child-id', 'child']
  ]) {
    const result = run(root, env, args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
  }
});

test('codex-lifecycle resolve-stop fails until the stop hook makes evidence ready', async () => {
  const { root, env, hookDefinitionHash } = fixture();
  const task = await prepareLifecycleTask(root, hookDefinitionHash);
  for (const [event, payload] of [
    ['pre-tool', {
      sessionId: 'parent', turnId: 'turn', toolUseId: 'tool',
      nativeAgent: 'agent-infra-lifecycle-executor', requestedModel: 'model',
      requestedReasoningEffort: 'high', hookDefinitionHash, taskName: task.bindingMarker
    }],
    ['subagent-start', {
      sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
      nativeAgent: 'agent-infra-lifecycle-executor'
    }]
  ] as const) {
    const result = run(root, env, ['hook-event', '--event', event], JSON.stringify(payload));
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  }
  const start = run(root, env, ['resolve-start', '--child-id', 'child']);
  assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);

  const premature = run(root, env, ['resolve-stop', '--child-id', 'child']);
  assert.equal(premature.status, 1);
  assert.equal(JSON.parse(premature.stdout).status, 'failed');

  const stopHook = run(root, env, ['hook-event', '--event', 'subagent-stop'], JSON.stringify({
    sessionId: 'parent', turnId: 'child-turn', childThreadId: 'child',
    nativeAgent: 'agent-infra-lifecycle-executor', taskName: task.bindingMarker
  }));
  assert.equal(stopHook.status, 0, stopHook.stderr);
  const ready = run(root, env, ['resolve-stop', '--child-id', 'child']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).status, 'stop-ready');
});
