import { spawn } from 'node:child_process';

export type RunProcessResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
};

export async function runHostCommand(command: string[]): Promise<RunProcessResult> {
  const [file, ...args] = command;
  if (!file) throw new Error('run: missing command');
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}
