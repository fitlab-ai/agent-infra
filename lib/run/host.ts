import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type RunProcessResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
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

export async function runHostCommand(command: string[]): Promise<RunProcessResult> {
  const [file, ...args] = command;
  if (!file) throw new Error('run: missing command');
  return new Promise((resolve, reject) => {
    const resolvedFile = resolveCommand(file);
    const child = spawn(resolvedFile, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: needsShell(resolvedFile)
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}
