import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

function resolveCommand(file: string): string {
  if (process.platform !== 'win32' || path.extname(file)) {
    return file;
  }

  const pathValue = process.env.Path || process.env.PATH || '';
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const lowerCandidate = path.join(dir, `${file}${extension.toLowerCase()}`);
      if (fs.existsSync(lowerCandidate)) return lowerCandidate;
      const upperCandidate = path.join(dir, `${file}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) return upperCandidate;
    }
  }

  return file;
}

function needsShell(file: string): boolean {
  return process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(file);
}

function spawnCapture(
  file: string,
  args: string[],
  onChunk?: (chunk: string) => void | Promise<void>
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const resolvedFile = resolveCommand(file);
    const child = spawn(resolvedFile, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: needsShell(resolvedFile)
    });
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
