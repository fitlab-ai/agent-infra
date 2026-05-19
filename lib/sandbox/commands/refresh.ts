import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  buildLockedGuidance,
  discoverProjects,
  formatCredentialWarnings,
  formatRemaining,
  reconcileClaudeCredentials,
  redactCommandError,
  validateClaudeCredentialsEnvOverride
} from '../credentials.ts';
import { runProbe } from '../shell.ts';

const USAGE = 'Usage: ai sandbox refresh';

type ReconcileOptions = NonNullable<Parameters<typeof reconcileClaudeCredentials>[1]>;

type RefreshDeps = Partial<ReconcileOptions> & {
  spawnFn?: typeof runProbe;
  discoverFn?: typeof discoverProjects;
  writeStdout?: (chunk: string) => unknown;
  writeStderr?: (chunk: string) => unknown;
};

export function probeClaudeStatus(spawnFn: typeof runProbe = runProbe): { ok: boolean; stderr: string; error: string | null } {
  const result = spawnFn('claude', ['/status'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000
  });
  return {
    ok: result.status === 0,
    stderr: result.stderr?.toString() ?? '',
    error: result.error?.message ?? null
  };
}

export async function refresh(args: string[], deps: RefreshDeps = {}): Promise<number> {
  const {
    spawnFn = runProbe,
    execFn,
    readFn,
    existsFn,
    writeFn,
    writeHostFn,
    discoverFn = discoverProjects,
    writeStdout = (chunk: string) => process.stdout.write(chunk),
    writeStderr = (chunk: string) => process.stderr.write(chunk)
  } = deps;

  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    writeStdout(`${USAGE}\n`);
    return 0;
  }

  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  if (positionals.length > 0) {
    throw new Error(USAGE);
  }
  validateClaudeCredentialsEnvOverride();

  const home = homedir();
  if (!home) {
    throw new Error('sandbox: home directory is required');
  }

  const projects = discoverFn(home);
  if (projects.length === 0) {
    writeStdout('No project credentials to refresh.\n');
    return 0;
  }

  const reconcileOptions = { execFn, readFn, existsFn, writeFn, writeHostFn, projects };
  let result = reconcileClaudeCredentials(home, reconcileOptions);
  if (result.status === 'STALE_ACCESS' && result.authoritative === null) {
    writeStdout('Host credentials appear stale; probing claude /status to trigger refresh...\n');
    const probe = probeClaudeStatus(spawnFn);
    if (!probe.ok) {
      writeStderr(`Probe failed: ${redactCommandError(probe.stderr || probe.error || 'unknown error')}\n`);
      writeStderr('Run "claude /login" on the host to renew credentials.\n');
      return 1;
    }
    writeStdout('Probe succeeded; re-inspecting host credentials.\n');
    result = reconcileClaudeCredentials(home, reconcileOptions);
  }

  if (result.status === 'MISSING') {
    writeStderr('No Claude Code credentials found on host.\n');
    writeStderr('Run "claude /login" on the host to authenticate.\n');
    return 1;
  }

  if (result.status === 'KEYCHAIN_LOCKED') {
    writeStderr(`${buildLockedGuidance()}\n`);
    return 1;
  }

  if (result.status === 'KEYCHAIN_ERROR') {
    writeStderr(`Host keychain error: ${redactCommandError(result.detail || 'unknown error')}\n`);
    writeStderr(`${buildLockedGuidance()}\n`);
    return 1;
  }

  if (result.status === 'KEYCHAIN_WRITE_FAILED') {
    writeStderr(`[host] keychain write failed: ${formatCredentialWarnings(result.warnings) || 'unknown error'}\n`);
    return 1;
  }

  if (result.status !== 'OK') {
    writeStderr('Host credentials still invalid after probe; run "claude /login".\n');
    return 1;
  }

  if (result.authoritative && result.authoritative !== 'host' && result.hostWritten) {
    writeStdout(`[host] reconciled from ${result.authoritative}\n`);
  }

  for (const project of projects) {
    const action = result.filesWritten.includes(project) ? 'updated' : 'unchanged';
    writeStdout(`[${project}] ${action}; expires in ${formatRemaining(result.expiresAt)}\n`);
  }

  for (const failure of result.fileErrors) {
    writeStderr(`[${failure.project}] sync failed: ${failure.error}\n`);
  }

  return result.fileErrors.length > 0 ? 1 : 0;
}
