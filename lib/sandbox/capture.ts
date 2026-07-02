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
  spawn?: (
    file: string,
    args: string[],
    options?: {
      onStdoutChunk?: (chunk: string) => void | Promise<void>;
      onStderrChunk?: (chunk: string) => void | Promise<void>;
    }
  ) => Promise<SandboxCaptureResult>;
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onStderrChunk?: (chunk: string) => void | Promise<void>;
};

type SandboxChunkCallback = NonNullable<SandboxCaptureOptions['onStdoutChunk']>;

async function spawnCapture(
  file: string,
  args: string[],
  options: {
    onStdoutChunk?: SandboxChunkCallback;
    onStderrChunk?: SandboxChunkCallback;
  } = {}
): Promise<SandboxCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stdoutPending = Promise.resolve();
    let stderrPending = Promise.resolve();
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = (result: SandboxCaptureResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const enqueue = (pending: Promise<void>, callback: SandboxChunkCallback | undefined, chunk: string): Promise<void> => {
      if (!callback) return pending;
      return pending.then(() => callback(chunk)).then(undefined, (error) => {
        rejectOnce(error);
      });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      stdoutPending = enqueue(stdoutPending, options.onStdoutChunk, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      stderrPending = enqueue(stderrPending, options.onStderrChunk, chunk);
    });
    child.on('error', rejectOnce);
    child.on('close', (exitCode, signal) => {
      Promise.all([stdoutPending, stderrPending])
        .then(() => resolveOnce({ exitCode, signal, stdout, stderr }))
        .catch(rejectOnce);
    });
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
  return (options.spawn ?? spawnCapture)('docker', dockerArgs, {
    onStdoutChunk: options.onStdoutChunk,
    onStderrChunk: options.onStderrChunk
  });
}
