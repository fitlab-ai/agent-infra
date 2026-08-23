import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  prepareCodexSandboxController,
  verifyCodexSandboxControllerContext
} from '../../../lib/agent-clients/adapters/codex-lifecycle/sandbox-controller.ts';

const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});
function trackedTemporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureRoots.add(root);
  return root;
}

function fixture() {
  const root = trackedTemporaryRoot('codex-controller-project-');
  const codexHome = trackedTemporaryRoot('codex-controller-home-');
  const runtimeDir = trackedTemporaryRoot('codex-controller-runtime-store-');
  fs.mkdirSync(path.join(root, '.codex', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'run-task'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'internal'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'task'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'agent-clients', 'adapters', 'codex-lifecycle'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  for (const file of [
    'bin/internal-cli.ts',
    'lib/internal/codex-lifecycle.ts',
    'lib/internal/codex-sandbox-controller.ts',
    'lib/internal/task-orchestration.ts',
    'lib/task/codex-orchestration.ts',
    'lib/task/delegation-receipts.ts',
    'lib/task/orchestration.ts',
    'lib/agent-clients/adapters/codex-lifecycle/build-identity.ts',
    'lib/agent-clients/adapters/codex-lifecycle/capability-store.ts',
    'lib/agent-clients/adapters/codex-lifecycle/sandbox-controller.ts',
    'lib/agent-clients/adapters/codex-lifecycle/app-server.ts',
    'lib/agent-clients/adapters/codex-lifecycle/evidence.ts',
    'lib/agent-clients/adapters/codex-lifecycle/store.ts'
  ]) fs.writeFileSync(path.join(root, file), `// ${file}\n`);
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(root, '.codex', 'agents', 'agent-infra-lifecycle-executor.toml'), 'name="executor"\n');
  fs.writeFileSync(path.join(root, '.codex', 'agents', 'agent-infra-lifecycle-reviewer.toml'), 'name="reviewer"\n');
  fs.writeFileSync(path.join(root, '.agents', 'hooks', 'lifecycle-delegation.js'), '// hook\n');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'run-task', 'SKILL.md'), '# run\n');
  fs.writeFileSync(path.join(root, '.agents', 'rules', 'lifecycle-orchestration.md'), '# lifecycle\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"secret"}\n', { mode: 0o600 });
  return { root, codexHome, runtimeDir };
}

test('sandbox controller prepares an isolated allowlisted home and fixed launch flags', () => {
  const f = fixture();
  const prepared = prepareCodexSandboxController({
    taskId: 'TASK-20260101-000001',
    taskRef: '01'
  }, {
    repoRoot: f.root,
    codexHome: f.codexHome,
    temporaryRoot: trackedTemporaryRoot('codex-controller-runtime-'),
    control: {
      token: 'control-token',
      generation: 'generation',
      channelDir: '/control',
      statusDir: '/status',
      runtimeDir: f.runtimeDir
    },
    verifyTaskBinding: () => {},
    codexVersion: () => '0.147.0',
    environment: { ...process.env, UNRELATED_CONTROLLER_SECRET: 'must-not-leak' }
  });
  assert.equal(prepared.command, 'codex');
  assert.deepEqual(prepared.args.slice(0, 7), [
    'exec',
    '--enable', 'hooks',
    '--enable', 'multi_agent',
    '--dangerously-bypass-hook-trust',
    '--dangerously-bypass-approvals-and-sandbox'
  ]);
  assert.equal(prepared.args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
  assert.equal(prepared.args.includes('--json'), true);
  assert.equal(prepared.env.CODEX_HOME, prepared.home);
  assert.equal(prepared.env.HOME, prepared.home);
  assert.equal(prepared.env.UNRELATED_CONTROLLER_SECRET, undefined);
  assert.equal(prepared.env.AGENT_INFRA_CONTROL_TOKEN, 'control-token');
  assert.equal(prepared.env.PATH?.split(path.delimiter)[0], path.join(prepared.home, 'bin'));
  const shim = fs.readFileSync(path.join(prepared.home, 'bin', 'agent-infra-internal'), 'utf8');
  const expectedExecutable = path.resolve(process.argv[1] ?? path.join(f.root, 'bin', 'internal-cli.ts'));
  assert.equal(shim.includes(expectedExecutable), true);
  if (expectedExecutable.endsWith('.ts')) assert.match(shim, /--experimental-strip-types/u);
  assert.match(shim, /"\$@"/u);
  assert.doesNotMatch(shim, /"\\\$@"/u);
  const homeStat = fs.lstatSync(prepared.home);
  const authStat = fs.lstatSync(path.join(prepared.home, 'auth.json'));
  assert.equal(homeStat.isDirectory(), true);
  assert.equal(homeStat.isSymbolicLink(), false);
  assert.equal(authStat.isFile(), true);
  assert.equal(authStat.isSymbolicLink(), false);
  if (process.platform !== 'win32') {
    assert.equal(homeStat.mode & 0o777, 0o700);
    assert.equal(authStat.mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(path.join(prepared.home, 'history.jsonl')), false);
  assert.equal(prepared.context.taskId, 'TASK-20260101-000001');
  prepared.cleanup();
  assert.equal(fs.existsSync(prepared.home), false);
});

test('sandbox controller rejects symlinked credentials before launch', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.codexHome, 'auth.json'));
  fs.symlinkSync(path.join(f.root, 'package.json'), path.join(f.codexHome, 'auth.json'));
  assert.throws(() => prepareCodexSandboxController({
    taskId: 'TASK-20260101-000001', taskRef: '01'
  }, {
    repoRoot: f.root,
    codexHome: f.codexHome,
    temporaryRoot: trackedTemporaryRoot('codex-controller-runtime-'),
    control: { token: 'token', generation: 'generation', channelDir: '/control', statusDir: '/status', runtimeDir: f.runtimeDir },
    verifyTaskBinding: () => {},
    codexVersion: () => '0.147.0'
  }), /INPUT_INVALID/);
});

test('sandbox controller enforces a task lease and controller context binding', () => {
  const f = fixture();
  const temporaryRoot = trackedTemporaryRoot('codex-controller-runtime-');
  const options = {
    repoRoot: f.root,
    codexHome: f.codexHome,
    temporaryRoot,
    control: { token: 'token', generation: 'generation', channelDir: '/control', statusDir: '/status', runtimeDir: f.runtimeDir },
    verifyTaskBinding: () => {},
    codexVersion: () => '0.147.0'
  } as const;
  const prepared = prepareCodexSandboxController({
    taskId: 'TASK-20260101-000001', taskRef: '01'
  }, options);
  assert.throws(() => prepareCodexSandboxController({
    taskId: 'TASK-20260101-000001', taskRef: '01'
  }, options), /CONTROLLER_BUSY/);
  assert.throws(() => verifyCodexSandboxControllerContext(
    prepared.contextPath,
    'TASK-20260101-000002',
    { repoRoot: f.root, generation: 'generation' }
  ), /CONTEXT_INVALID/);
  assert.throws(() => verifyCodexSandboxControllerContext(
    prepared.contextPath,
    'TASK-20260101-000001',
    { repoRoot: f.root, generation: 'other' }
  ), /CONTEXT_INVALID/);
  prepared.cleanup();
});
