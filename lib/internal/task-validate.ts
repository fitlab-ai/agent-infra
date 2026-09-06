import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../sandbox/config.ts';
import { detectEngine } from '../sandbox/engine.ts';
import { runEngine } from '../sandbox/shell.ts';
import { sandboxBranchLabel, sandboxLabel } from '../sandbox/constants.ts';
import { fetchSandboxRows, selectSandboxContainer } from '../sandbox/commands/list-running.ts';
import { containerNameCandidates } from '../sandbox/constants.ts';
import { resolveSandboxTarget } from '../sandbox/workspace-identity.ts';
import { sandboxControlPaths } from '../sandbox/workspace-view.ts';
import {
  appendSandboxControlAudit,
  readActiveLease,
  readSandboxControlStatus
} from '../sandbox/control/state.ts';
import type { SandboxControlLease } from '../sandbox/control/protocol.ts';
import { readSandboxControlManifest } from '../sandbox/control/lifecycle.ts';
import {
  SANDBOX_CONTROL_FUTURE_SKEW_MS,
  SANDBOX_CONTROL_STATUS_STALE_MS
} from '../sandbox/control/protocol.ts';
import { getProcessStartTime } from '../server/process-state.ts';
import { assertGitWorktreeBinding } from '../git/worktree-identity.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-validate <branch | TASK-id | N> [--scope snapshot|inplace] [--timeout <ms>] [--format text|json] -- <command> [args...]`;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const RECOVERY_GRACE_MS = 30_000;

type ValidateOptions = {
  target: string;
  scope: 'snapshot' | 'inplace';
  timeoutMs: number;
  format: 'text' | 'json';
  command: string[];
  help: boolean;
};

export function parseValidateArgs(args: string[]): ValidateOptions {
  if (args.includes('--help') || args.includes('-h')) {
    return { target: '', scope: 'snapshot', timeoutMs: 300_000, format: 'text', command: [], help: true };
  }
  const separator = args.indexOf('--');
  if (separator < 0) throw new Error(`${USAGE}\nA literal -- must separate validation options from the command.`);
  const optionArgs = args.slice(0, separator);
  const command = args.slice(separator + 1);
  let scope: ValidateOptions['scope'] = 'snapshot';
  let timeoutMs = 300_000;
  let format: ValidateOptions['format'] = 'text';
  const positionals: string[] = [];
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index]!;
    if (arg === '--scope') {
      const value = optionArgs[++index];
      if (value !== 'snapshot' && value !== 'inplace') throw new Error('validate --scope must be snapshot or inplace');
      scope = value;
    } else if (arg === '--timeout') {
      const value = Number(optionArgs[++index]);
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) throw new Error(`validate --timeout must be 1..${MAX_TIMEOUT_MS}`);
      timeoutMs = value;
    } else if (arg === '--format') {
      const value = optionArgs[++index];
      if (value !== 'text' && value !== 'json') throw new Error('validate --format must be text or json');
      format = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1 || command.length === 0) throw new Error(USAGE);
  return { target: positionals[0]!, scope, timeoutMs, format, command, help: false };
}

function runValidationCommand(command: string[], cwd: string, scope: string, timeoutMs: number, json: boolean) {
  const [file, ...args] = command;
  const result = spawnSync(file!, args, {
    cwd,
    env: { ...process.env, AGENT_INFRA_VALIDATION_SCOPE: scope },
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(file!)
  });
  if (json) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return { exitCode: result.status ?? 1, signal: result.signal ?? null };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function waitForState(statusDir: string, predicate: (state: ReturnType<typeof readSandboxControlStatus>) => boolean, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = readSandboxControlStatus(statusDir);
      if (predicate(status)) return;
    } catch {
      // Atomic status publication may be between renames.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error('SANDBOX_VALIDATION_BROKER_STATE_TIMEOUT');
}

function snapshotValidation(repoRoot: string, commit: string, options: ValidateOptions) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-validation-'));
  const worktree = path.join(tempRoot, 'worktree');
  let cleanup = 'not-created';
  try {
    git(repoRoot, ['worktree', 'add', '--detach', worktree, commit]);
    cleanup = 'pending';
    return { ...runValidationCommand(options.command, worktree, 'snapshot', options.timeoutMs, options.format === 'json'), cleanup: () => cleanup };
  } finally {
    let cleanupError: unknown = null;
    if (fs.existsSync(worktree)) {
      try {
        git(repoRoot, ['worktree', 'remove', '--force', worktree]);
        cleanup = 'completed';
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      git(repoRoot, ['worktree', 'prune']);
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
}

function inplaceValidation(config: ReturnType<typeof loadConfig>, target: ReturnType<typeof resolveSandboxTarget>, options: ValidateOptions) {
  const engine = detectEngine(config);
  const { running, nonRunning } = fetchSandboxRows(engine, sandboxLabel(config), sandboxBranchLabel(config));
  const row = selectSandboxContainer([...running, ...nonRunning], containerNameCandidates(config, target.branch));
  if (!row) throw new Error('SANDBOX_VALIDATION_CONTAINER_NOT_FOUND');
  const control = sandboxControlPaths({
    base: config.controlBase, project: config.project,
    container: row.name, identity: target.workspace
  });
  const manifest = readSandboxControlManifest(control.manifestPath);
  const initial = readSandboxControlStatus(control.statusDir);
  const now = Date.now();
  if (initial.generation !== manifest.generation
    || now - initial.updatedAt > SANDBOX_CONTROL_STATUS_STALE_MS
    || initial.updatedAt > now + SANDBOX_CONTROL_FUTURE_SKEW_MS) {
    throw new Error('SANDBOX_VALIDATION_BROKER_STATUS_STALE');
  }
  if (initial.state !== 'healthy' || initial.activeRequestId !== null) {
    throw new Error('SANDBOX_VALIDATION_BROKER_NOT_IDLE');
  }
  const startTime = getProcessStartTime(process.pid);
  if (!startTime) throw new Error('SANDBOX_VALIDATION_OWNER_IDENTITY_UNAVAILABLE');
  const leasePath = path.join(control.root, 'lease.json');
  const nonce = randomUUID();
  const issuedAt = Date.now();
  const lease: SandboxControlLease = {
    version: 2, generation: manifest.generation, nonce,
    owner: { pid: process.pid, startTime }, issuedAt,
    expiresAt: issuedAt + Math.min(options.timeoutMs + RECOVERY_GRACE_MS, MAX_TIMEOUT_MS + RECOVERY_GRACE_MS),
    taskId: target.workspace.mode === 'task-bound' ? target.workspace.taskId : null,
    branch: target.branch, reason: 'manual-validation'
  };
  const originalBranch = git(manifest.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const originalHead = git(manifest.worktreeRoot, ['rev-parse', 'HEAD']);
  fs.writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { flag: 'wx', mode: 0o600 });
  let stopped = false;
  let restored = false;
  try {
    appendSandboxControlAudit(manifest, 'lease-acquire', { ownerPid: process.pid });
    waitForState(control.statusDir, (status) => status.state === 'parked' && status.reasonCode === 'SANDBOX_CONTROL_HANDOFF_ACTIVE');
    if (row.running) {
      runEngine(engine, 'docker', ['stop', row.name]);
      stopped = true;
    }
    const refreshedRows = fetchSandboxRows(engine, sandboxLabel(config), sandboxBranchLabel(config));
    const refreshed = selectSandboxContainer(
      [...refreshedRows.running, ...refreshedRows.nonRunning],
      containerNameCandidates(config, target.branch)
    );
    if (!refreshed || refreshed.running) throw new Error('SANDBOX_VALIDATION_CONTAINER_STILL_RUNNING');
    const activeLease = readActiveLease(manifest);
    if (!activeLease || activeLease.nonce !== nonce) throw new Error('SANDBOX_VALIDATION_LEASE_OWNERSHIP_LOST');
    assertGitWorktreeBinding(config.repoRoot, manifest.worktreeRoot, target.branch);
    const result = runValidationCommand(options.command, manifest.worktreeRoot, 'inplace', options.timeoutMs, options.format === 'json');
    return { ...result, cleanup: () => restored ? 'completed' : 'pending' };
  } finally {
    const recoveryErrors: string[] = [];
    try {
      const currentBranch = git(manifest.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (currentBranch !== originalBranch) git(manifest.worktreeRoot, ['switch', originalBranch]);
    } catch {
      try {
        git(manifest.worktreeRoot, ['checkout', '--detach', originalHead]);
        git(manifest.worktreeRoot, ['switch', originalBranch]);
      } catch (fallbackError) {
        recoveryErrors.push(`git binding restore failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      }
    }
    if (stopped) {
      try {
        runEngine(engine, 'docker', ['start', row.name]);
      } catch (error) {
        recoveryErrors.push(`container start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const currentLease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { nonce?: unknown };
      if (currentLease.nonce !== nonce) throw new Error('SANDBOX_VALIDATION_LEASE_OWNERSHIP_LOST');
    } catch (error) {
      recoveryErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (recoveryErrors.length === 0) {
      try {
        fs.unlinkSync(leasePath);
        appendSandboxControlAudit(manifest, 'lease-release', { ownerPid: process.pid });
        waitForState(control.statusDir, (status) => status.state === 'healthy');
        restored = true;
      } catch (error) {
        try {
          if (!fs.existsSync(leasePath)) {
            fs.writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { flag: 'wx', mode: 0o600 });
          }
          appendSandboxControlAudit(manifest, 'lease-release-failed', { ownerPid: process.pid });
        } catch (leaseError) {
          recoveryErrors.push(`lease preservation failed: ${leaseError instanceof Error ? leaseError.message : String(leaseError)}`);
        }
        recoveryErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (recoveryErrors.length > 0) {
      throw new Error(
        `SANDBOX_VALIDATION_RECOVERY_INCOMPLETE: ${recoveryErrors.join('; ')}; run 'ai sandbox start ${target.branch}'`
      );
    }
  }
}

function errorCode(message: string): string {
  const match = message.match(/^([A-Z][A-Z0-9_]*)/);
  return match && match[1]!.length >= 3 ? match[1]! : 'TASK_VALIDATE_FAILED';
}

function fail(format: 'text' | 'json', code: string, message: string): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
}

function sniffFormat(args: string[]): 'text' | 'json' {
  const index = args.indexOf('--format');
  return index >= 0 && args[index + 1] === 'json' ? 'json' : 'text';
}

function taskValidate(args: string[]): void {
  if (!ensureInternalHandlerRoute('task-validate', args)) return;
  let options: ValidateOptions;
  try {
    options = parseValidateArgs(args);
  } catch (error) {
    fail(sniffFormat(args), 'TASK_VALIDATE_ARGS_INVALID', error instanceof Error ? error.message : String(error));
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const config = loadConfig();
    const target = resolveSandboxTarget(options.target, config.repoRoot);
    const commit = git(config.repoRoot, ['rev-parse', target.branch]);
    const startedAt = new Date().toISOString();
    const result = options.scope === 'snapshot'
      ? snapshotValidation(config.repoRoot, commit, options)
      : inplaceValidation(config, target, options);
    const evidence = {
      version: 1,
      taskId: target.workspace.mode === 'task-bound' ? target.workspace.taskId : null,
      branch: target.branch,
      scope: options.scope,
      commit,
      command: path.basename(options.command[0]!),
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      cleanup: result.cleanup()
    };
    if (options.format === 'json') {
      process.stdout.write(`${JSON.stringify({ status: 'applied', changed: false, evidence, error: null })}\n`);
    } else {
      process.stdout.write(`Validation ${result.exitCode === 0 ? 'passed' : 'failed'} (${options.scope}, ${evidence.command}, cleanup=${evidence.cleanup}).\n`);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(options.format, errorCode(message), message);
  }
}

export { taskValidate };
