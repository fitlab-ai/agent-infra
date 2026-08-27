import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import * as toml from 'smol-toml';

import {
  requestCodexControllerClose,
  requestCodexControllerOpen,
  requestCodexControllerVerify,
  requestSandboxControl
} from '../../../sandbox/control/client.ts';
import { readSandboxControlStatus } from '../../../sandbox/control/state.ts';
import { getProcessStartTime, type ProcessIdentity } from '../../../server/process-state.ts';
import { computeLifecycleBuildIdentity, verifyLifecycleBuildIdentity, type LifecycleIdentityWarning } from './build-identity.ts';
import {
  contextFromControllerLease,
  controllerProofFromContext,
  verifyCodexSandboxControllerContextWithWarnings as verifyContextFileWithWarnings,
  writeCodexSandboxControllerContext,
  computeLifecycleProfileProvenanceFromFiles,
  type CodexSandboxControllerContextV2,
  type LifecycleContextWarning
} from './controller-context.ts';

type ControllerControl = Readonly<{
  token: string;
  generation: string;
  channelDir: string;
  statusDir: string;
  runtimeDir: string;
}>;

type ControllerInput = Readonly<{
  executorModel?: string;
  executorReasoningEffort?: string;
  reviewerModel?: string;
  reviewerReasoningEffort?: string;
}>;

type ControllerOptions = Readonly<{
  repoRoot?: string;
  codexHome?: string;
  temporaryRoot?: string;
  control?: ControllerControl;
  now?: () => number;
  codexVersion?: () => string;
  verifyTaskBinding?: (taskId: string, control: ControllerControl) => void;
  openController?: typeof requestCodexControllerOpen;
  closeController?: typeof requestCodexControllerClose;
  environment?: NodeJS.ProcessEnv;
}>;

type PreparedCodexSandboxController = Readonly<{
  command: 'codex';
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  home: string;
  contextPath: string;
  context: CodexSandboxControllerContextV2;
  warnings: readonly LifecycleIdentityWarning[];
  cleanup: () => void;
}>;

type VerifyContextOptions = Readonly<{
  repoRoot?: string;
  now?: number;
  generation?: string;
  probeProcess?: (identity: ProcessIdentity) => 'alive' | 'dead' | 'unknown';
  control?: ControllerControl;
  requestControllerVerify?: typeof requestCodexControllerVerify;
}>;

function digestFiles(files: readonly string[]): string {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('CODEX_SANDBOX_CONTROLLER_BUNDLE_MISMATCH');
    }
    hash.update(path.basename(file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function copyRegular(source: string, destination: string, mode: number): void {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_INPUT_INVALID');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, mode);
}

function controlFromEnvironment(): ControllerControl {
  const token = process.env.AGENT_INFRA_CONTROL_TOKEN;
  const generation = process.env.AGENT_INFRA_CONTROL_GENERATION;
  const channelDir = process.env.AGENT_INFRA_CONTROL_DIR;
  const statusDir = process.env.AGENT_INFRA_CONTROL_STATUS_DIR;
  const runtimeDir = process.env.AGENT_INFRA_RUNTIME_DIR;
  if (!token || !generation || !channelDir || !statusDir || !runtimeDir) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTROL_MISSING');
  }
  return { token, generation, channelDir, statusDir, runtimeDir };
}

function verifyRuntime(runtimeDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(runtimeDir);
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_RUNTIME_UNAVAILABLE');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_RUNTIME_UNAVAILABLE');
  }
  const probe = path.join(runtimeDir, `.controller-${process.pid}-${crypto.randomUUID()}.probe`);
  try {
    fs.writeFileSync(probe, 'runtime-probe\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (fs.readFileSync(probe, 'utf8') !== 'runtime-probe\n') {
      throw new Error('probe mismatch');
    }
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_RUNTIME_UNAVAILABLE');
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

function verifyControl(taskId: string, control: ControllerControl): void {
  verifyRuntime(control.runtimeDir);
  let status: ReturnType<typeof readSandboxControlStatus> | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      status = readSandboxControlStatus(control.statusDir);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (!status) {
    throw new Error(`CODEX_SANDBOX_CONTROLLER_CONTROL_UNAVAILABLE: ${String(lastError)}`);
  }
  if (status.generation !== control.generation
    || status.state !== 'healthy'
    || Date.now() - status.updatedAt > 1_500) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTROL_UNAVAILABLE');
  }
  const response = requestSandboxControl({
    family: 'task-orchestration',
    args: [taskId, 'status'],
    ...control,
    timeoutMs: 30_000
  });
  let payload: { taskId?: unknown } = {};
  try {
    payload = JSON.parse(response.stdout) as { taskId?: unknown };
  } catch {
    throw new Error('CODEX_SANDBOX_CONTROLLER_TASK_BINDING_INVALID');
  }
  if (payload.taskId !== taskId) throw new Error('CODEX_SANDBOX_CONTROLLER_TASK_BINDING_INVALID');
}

function verifyCodexSandboxControllerContextWithWarnings(
  contextPath: string,
  options: VerifyContextOptions = {}
): Readonly<{ context: CodexSandboxControllerContextV2; warnings: readonly (LifecycleIdentityWarning | LifecycleContextWarning)[] }> {
  const control = options.control ?? controlFromEnvironment();
  const fileVerification = verifyContextFileWithWarnings(contextPath, {
    repoRoot: options.repoRoot,
    now: options.now,
    generation: control.generation,
    probeProcess: options.probeProcess
  });
  const context = fileVerification.context;
  const verified = (options.requestControllerVerify ?? requestCodexControllerVerify)({
    controllerProof: controllerProofFromContext(context),
    ...control,
    timeoutMs: 30_000
  });
  if (verified.binding.taskId !== context.taskId
    || verified.binding.controlGeneration !== context.controlGeneration
    || verified.binding.controllerInstanceDigest !== context.controllerInstanceDigest) {
    throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_INVALID');
  }
  return Object.freeze({
    context,
    warnings: Object.freeze([...new Map(
      [...fileVerification.warnings, ...(verified.warnings ?? [])].map((warning) => [warning.code, warning])
    ).values()])
  });
}

function verifyCodexSandboxControllerContext(
  contextPath: string,
  options: VerifyContextOptions = {}
): CodexSandboxControllerContextV2 {
  return verifyCodexSandboxControllerContextWithWarnings(contextPath, options).context;
}

function detectedCodexVersion(): string {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  const version = /codex-cli\s+(\d+\.\d+\.\d+)/u.exec(result.stdout ?? '')?.[1];
  if (result.status !== 0 || !version) throw new Error('CODEX_SANDBOX_CONTROLLER_CODEX_UNAVAILABLE');
  return version;
}

function sanitizedConfig(source: string, destination: string, sourceHome: string, targetHome: string): readonly string[] {
  if (!fs.existsSync(source)) return [];
  const parsed = toml.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
  const allowed = new Set([
    'model',
    'model_provider',
    'model_providers',
    'model_reasoning_effort',
    'model_auto_compact_token_limit',
    'preferred_auth_method'
  ]);
  const output = Object.fromEntries(Object.entries(parsed).filter(([key]) => allowed.has(key)));
  const catalog = parsed.model_catalog_json;
  if (typeof catalog === 'string' && catalog.trim()) {
    const resolved = path.resolve(sourceHome, catalog.replace(/^~[/\\]/u, ''));
    const relative = path.relative(sourceHome, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('CODEX_SANDBOX_CONTROLLER_CONFIG_PATH_INVALID');
    }
    const target = path.join(targetHome, 'model-catalogs', path.basename(resolved));
    copyRegular(resolved, target, 0o600);
    output.model_catalog_json = target;
  }
  fs.writeFileSync(destination, `${toml.stringify(output)}\n`, { mode: 0o600 });
  const providerEnvironment = new Set<string>();
  const providers = output.model_providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const provider of Object.values(providers)) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
      for (const key of ['env_key', 'envKey']) {
        const name = (provider as Record<string, unknown>)[key];
        if (typeof name === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/u.test(name)) {
          providerEnvironment.add(name);
        }
      }
    }
  }
  return Object.freeze([...providerEnvironment]);
}

function isolatedEnvironment(
  home: string,
  shimDir: string,
  contextPath: string,
  taskId: string,
  control: ControllerControl,
  providerEnvironment: readonly string[],
  sourceEnvironment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const inherited = new Set([
    'LANG', 'LC_ALL', 'TERM', 'COLORTERM',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'CODEX_CI',
    ...providerEnvironment
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) {
    if (sourceEnvironment[key] !== undefined) env[key] = sourceEnvironment[key];
  }
  return {
    ...env,
    HOME: home,
    CODEX_HOME: home,
    PATH: `${shimDir}${path.delimiter}${sourceEnvironment.PATH ?? ''}`,
    AGENT_INFRA_TASK_ID: taskId,
    AGENT_INFRA_CONTROL_TOKEN: control.token,
    AGENT_INFRA_CONTROL_GENERATION: control.generation,
    AGENT_INFRA_CONTROL_DIR: control.channelDir,
    AGENT_INFRA_CONTROL_STATUS_DIR: control.statusDir,
    AGENT_INFRA_RUNTIME_DIR: control.runtimeDir,
    AGENT_INFRA_CODEX_CONTROLLER_CONTEXT: contextPath
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function prepareCodexSandboxController(
  input: ControllerInput,
  options: ControllerOptions = {}
): PreparedCodexSandboxController {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const sourceHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const control = options.control ?? controlFromEnvironment();
  const version = (options.codexVersion ?? detectedCodexVersion)();
  if (!semver.gte(version, '0.147.0')) throw new Error('CODEX_SANDBOX_CONTROLLER_CODEX_UNSUPPORTED');

  const runtimeRoot = path.resolve(options.temporaryRoot
    ?? path.join(os.tmpdir(), 'agent-infra-codex-controllers'));
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeRoot, 0o700);
  const key = crypto.createHash('sha256')
    .update(`${process.pid}\0${control.generation}`)
    .digest('hex');
  const parentStartTime = getProcessStartTime(process.pid);
  if (!parentStartTime) throw new Error('CODEX_SANDBOX_CONTROLLER_PROCESS_IDENTITY_INVALID');
  const home = fs.mkdtempSync(path.join(runtimeRoot, `${key}-`));
  fs.chmodSync(home, 0o700);
  let cleaned = false;
  let context: CodexSandboxControllerContextV2 | null = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (context) {
      try {
        (options.closeController ?? requestCodexControllerClose)({
          controllerProcess: context.controllerProcess,
          controllerProof: controllerProofFromContext(context),
          ...control,
          timeoutMs: 30_000
        });
      } catch {
        // The wrapper is exiting; dead-process recovery safely handles an unknown close result.
      }
    }
    const relative = path.relative(runtimeRoot, home);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  try {
    const auth = path.join(sourceHome, 'auth.json');
    if (fs.existsSync(auth)) copyRegular(auth, path.join(home, 'auth.json'), 0o600);
    const providerEnvironment = sanitizedConfig(
      path.join(sourceHome, 'config.toml'),
      path.join(home, 'config.toml'),
      sourceHome,
      home
    );

    const hooks = path.join(repoRoot, '.codex', 'hooks.json');
    const executor = path.join(repoRoot, '.codex', 'agents', 'agent-infra-lifecycle-executor.toml');
    const reviewer = path.join(repoRoot, '.codex', 'agents', 'agent-infra-lifecycle-reviewer.toml');
    copyRegular(hooks, path.join(home, 'hooks.json'), 0o600);
    copyRegular(executor, path.join(home, 'agents', path.basename(executor)), 0o600);
    copyRegular(reviewer, path.join(home, 'agents', path.basename(reviewer)), 0o600);
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(home, 'hooks.json'))).digest('hex')
      !== crypto.createHash('sha256').update(fs.readFileSync(hooks)).digest('hex')
      || digestFiles([
        path.join(home, 'agents', path.basename(executor)),
        path.join(home, 'agents', path.basename(reviewer))
      ]) !== digestFiles([executor, reviewer])) {
      throw new Error('CODEX_SANDBOX_CONTROLLER_BUNDLE_MISMATCH');
    }

    const buildIdentity = computeLifecycleBuildIdentity(repoRoot);
    const profileProvenance = computeLifecycleProfileProvenanceFromFiles({
      executor: path.join(home, 'agents', path.basename(executor)),
      reviewer: path.join(home, 'agents', path.basename(reviewer))
    }, buildIdentity.packageVersion, 'isolated-user');
    const opened = (options.openController ?? requestCodexControllerOpen)({
      controllerProcess: { pid: process.pid, startTime: parentStartTime },
      ...control,
      timeoutMs: 30_000
    });
    const taskId = opened.lease.taskId;
    const identity = verifyLifecycleBuildIdentity(opened.lease.buildIdentity, buildIdentity);
    if (!identity.ok) throw new Error(`${identity.code}: ${identity.message}`);
    const warnings = Object.freeze([...(opened.warnings ?? []), ...identity.warnings]);
    context = contextFromControllerLease(opened.lease, {
      hookDefinitionHash: crypto.createHash('sha256').update(fs.readFileSync(hooks)).digest('hex'),
      lifecycleProfilesHash: digestFiles([executor, reviewer]),
      profileProvenance
    });
    if (opened.lease.controlGeneration !== control.generation
      || opened.lease.controllerProcess.pid !== process.pid
      || opened.lease.controllerProcess.startTime !== parentStartTime) {
      throw new Error('SANDBOX_CONTROL_RESULT_INVALID');
    }
    (options.verifyTaskBinding ?? verifyControl)(taskId, control);
    const contextPath = path.join(home, 'controller-context.json');
    writeCodexSandboxControllerContext(contextPath, context);

    const shimDir = path.join(home, 'bin');
    fs.mkdirSync(shimDir, { mode: 0o700 });
    const internalCli = path.resolve(process.argv[1] ?? path.join(repoRoot, 'bin', 'internal-cli.ts'));
    const source = internalCli.endsWith('.ts')
      ? `#!/bin/sh\nexec ${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(internalCli)} "$@"\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(internalCli)} "$@"\n`;
    fs.writeFileSync(path.join(shimDir, 'agent-infra-internal'), source, { mode: 0o700 });

    const policy = [
      input.executorModel ? `--executor-model ${input.executorModel}` : '',
      input.executorReasoningEffort ? `--executor-reasoning-effort ${input.executorReasoningEffort}` : '',
      input.reviewerModel ? `--reviewer-model ${input.reviewerModel}` : '',
      input.reviewerReasoningEffort ? `--reviewer-reasoning-effort ${input.reviewerReasoningEffort}` : ''
    ].filter(Boolean).join(' ');
    const prompt = `$run-task ${taskId}${policy ? ` ${policy}` : ''}`;
    const args = Object.freeze([
      'exec',
      '--enable', 'hooks',
      '--enable', 'multi_agent',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '-C', repoRoot,
      prompt
    ]);
    const env = isolatedEnvironment(
      home,
      shimDir,
      contextPath,
      taskId,
      control,
      providerEnvironment,
      options.environment ?? process.env
    );
    return Object.freeze({
      command: 'codex' as const,
      args,
      env,
      home,
      contextPath,
      context,
      warnings,
      cleanup
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function runCodexSandboxController(
  input: ControllerInput,
  options: ControllerOptions = {}
): Promise<number> {
  const prepared = prepareCodexSandboxController(input, options);
  try {
    const child = spawn(prepared.command, [...prepared.args], {
      cwd: options.repoRoot ?? process.cwd(),
      env: prepared.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32'
    });
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else child.kill('SIGTERM');
      forceKill = setTimeout(() => {
        if (child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      }, 5_000);
      forceKill.unref();
    };
    process.once('SIGINT', terminate);
    process.once('SIGTERM', terminate);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
    } finally {
      if (forceKill) clearTimeout(forceKill);
      process.off('SIGINT', terminate);
      process.off('SIGTERM', terminate);
    }
  } finally {
    prepared.cleanup();
  }
}

export {
  prepareCodexSandboxController,
  runCodexSandboxController,
  verifyCodexSandboxControllerContext,
  verifyCodexSandboxControllerContextWithWarnings,
  controllerProofFromContext
};
export type {
  CodexSandboxControllerContextV2 as CodexSandboxControllerContext,
  ControllerControl,
  ControllerInput,
  ControllerOptions,
  PreparedCodexSandboxController
};
