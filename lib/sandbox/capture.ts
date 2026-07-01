import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { containerNameCandidates, sandboxBranchLabel, sandboxLabel } from './constants.ts';
import { detectEngine } from './engine.ts';
import { hostTimezoneEnvFlags, terminalEnvFlags } from './commands/enter.ts';
import {
  fetchSandboxRows,
  selectSandboxContainer,
  startSandboxContainer,
  type SandboxRow
} from './commands/list-running.ts';

export type SandboxCaptureRequest = {
  taskRef: string;
  branch: string;
  command: string[];
  timeoutMs?: number;
};

export type SandboxCaptureResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type SandboxCaptureOptions = {
  engine?: string;
  repoRoot?: string;
  containerCandidates?: string[];
  rows?: SandboxRow[];
  startContainer?: (name: string) => void;
  spawn?: (file: string, args: string[]) => Promise<SandboxCaptureResult>;
};

async function spawnCapture(file: string, args: string[]): Promise<SandboxCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

export async function runInSandbox(
  request: SandboxCaptureRequest,
  options: SandboxCaptureOptions = {}
): Promise<SandboxCaptureResult> {
  const config = options.engine ? null : loadConfig();
  const engine = options.engine ?? detectEngine(config!);
  const rows =
    options.rows ??
    (() => {
      const fetched = fetchSandboxRows(engine, sandboxLabel(config!), sandboxBranchLabel(config!));
      return [...fetched.running, ...fetched.nonRunning];
    })();
  const candidates = options.containerCandidates ?? containerNameCandidates(config!, request.branch);
  const found = selectSandboxContainer(rows, candidates);
  if (!found) {
    throw new Error(
      `Sandbox for ${request.branch} not found. Create it first with ai sandbox create ${request.taskRef}.`
    );
  }
  if (!found.running) {
    (options.startContainer ?? ((name: string) => startSandboxContainer(engine, name)))(found.name);
  }
  const dockerArgs = [
    'exec',
    ...terminalEnvFlags(),
    ...hostTimezoneEnvFlags(),
    found.name,
    ...request.command
  ];
  return (options.spawn ?? spawnCapture)('docker', dockerArgs);
}
