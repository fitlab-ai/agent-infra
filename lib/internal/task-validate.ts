import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../sandbox/config.ts';
import { resolveSandboxTarget } from '../sandbox/workspace-identity.ts';
import { assertGitWorktreeBinding } from '../git/worktree-identity.ts';
import { createManualValidationEvidence, manualValidationEvidenceSummary } from '../task/manual-validation-evidence.ts';
import type { ManualValidationCleanup } from '../task/manual-validation-evidence.ts';
import { writeJsonAtomic } from '../task/manual-validation-shared.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-validate <branch | TASK-id | N> [--scope snapshot|inplace] [--timeout <ms>] [--format text|json] [--evidence-file <path>] -- <command> [args...]`;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

type ValidateOptions = {
  target: string;
  scope: 'snapshot' | 'inplace';
  timeoutMs: number;
  format: 'text' | 'json';
  evidenceFile: string | null;
  command: string[];
  help: boolean;
};

export function parseValidateArgs(args: string[]): ValidateOptions {
  if (args.includes('--help') || args.includes('-h')) {
    return { target: '', scope: 'snapshot', timeoutMs: 300_000, format: 'text', evidenceFile: null, command: [], help: true };
  }
  const separator = args.indexOf('--');
  if (separator < 0) throw new Error(`${USAGE}\nA literal -- must separate validation options from the command.`);
  const optionArgs = args.slice(0, separator);
  const command = args.slice(separator + 1);
  let scope: ValidateOptions['scope'] = 'snapshot';
  let timeoutMs = 300_000;
  let format: ValidateOptions['format'] = 'text';
  let evidenceFile: string | null = null;
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
    } else if (arg === '--evidence-file') {
      const value = optionArgs[++index];
      if (!value || value.startsWith('-')) throw new Error('validate --evidence-file requires a path');
      evidenceFile = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1 || command.length === 0) throw new Error(USAGE);
  return { target: positionals[0]!, scope, timeoutMs, format, evidenceFile, command, help: false };
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
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
}

function inplaceValidation(config: ReturnType<typeof loadConfig>, target: ReturnType<typeof resolveSandboxTarget>, options: ValidateOptions) {
  const worktree = assertGitWorktreeBinding(config.repoRoot, config.repoRoot, target.branch);
  const originalBranch = git(worktree.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const originalHead = git(worktree.worktreeRoot, ['rev-parse', 'HEAD']);
  let restored = false;
  try {
    const result = runValidationCommand(options.command, worktree.worktreeRoot, 'inplace', options.timeoutMs, options.format === 'json');
    return { ...result, cleanup: () => restored ? 'completed' : 'pending' };
  } finally {
    try {
      const currentBranch = git(worktree.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (currentBranch !== originalBranch) git(worktree.worktreeRoot, ['switch', originalBranch]);
    } catch {
      try {
        git(worktree.worktreeRoot, ['checkout', '--detach', originalHead]);
        git(worktree.worktreeRoot, ['switch', originalBranch]);
      } catch (error) {
        throw new Error(`TASK_VALIDATION_WORKTREE_RESTORE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    restored = true;
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
    const result = internalHandlerRoute('task-validate', 'snapshot', options.scope)
      ? snapshotValidation(config.repoRoot, commit, options)
      : internalHandlerRoute('task-validate', 'inplace', options.scope)
        ? inplaceValidation(config, target, options)
        : (() => { throw new Error('TASK_VALIDATE_SCOPE_UNREGISTERED'); })();
    const cleanup = result.cleanup() as ManualValidationCleanup;
    const evidence = createManualValidationEvidence({
      mode: target.workspace.mode,
      taskId: target.workspace.mode === 'task-bound' ? target.workspace.taskId : null,
      branch: target.branch,
      commit,
      recoverable: target.workspace.mode === 'task-bound',
      scope: options.scope,
      command: path.basename(options.command[0]!),
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      cleanup
    });
    if (options.evidenceFile) {
      try { writeJsonAtomic(path.resolve(options.evidenceFile), evidence); }
      catch (error) { throw new Error(`MANUAL_VALIDATION_EVIDENCE_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const evidenceSummary = manualValidationEvidenceSummary(evidence);
    if (options.format === 'json') {
      process.stdout.write(`${JSON.stringify({ status: 'applied', changed: false, evidence: evidenceSummary, evidenceFile: options.evidenceFile, error: null })}\n`);
    } else {
      process.stdout.write(`Validation ${result.exitCode === 0 ? 'passed' : 'failed'} (${options.scope}, ${evidenceSummary.command}, cleanup=${evidenceSummary.cleanup}).\n`);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(options.format, errorCode(message), message);
  }
}

export { taskValidate };
