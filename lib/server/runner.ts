import { spawn } from 'node:child_process';

export type RunnerResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type RunnerOptions = {
  spawn?: (file: string, args: string[], onChunk?: (chunk: string) => void | Promise<void>) => Promise<RunnerResult>;
  onChunk?: (chunk: string) => void | Promise<void>;
};

function spawnCapture(
  file: string,
  args: string[],
  onChunk?: (chunk: string) => void | Promise<void>
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let pendingChunks = Promise.resolve();

    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const resolveOnce = (result: RunnerResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const enqueueChunk = (chunk: string): void => {
      if (!onChunk) return;
      pendingChunks = pendingChunks.then(() => onChunk(chunk));
      pendingChunks.catch(rejectOnce);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      enqueueChunk(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      enqueueChunk(chunk);
    });
    child.on('error', rejectOnce);
    child.on('close', (exitCode, signal) => {
      pendingChunks
        .then(() => resolveOnce({ exitCode, signal, stdout, stderr }))
        .catch(rejectOnce);
    });
  });
}

export async function runAi(args: string[], options: RunnerOptions = {}): Promise<RunnerResult> {
  return (options.spawn ?? spawnCapture)('ai', args, options.onChunk);
}
