import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type RunProcessResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
};

type CommandResolution = Readonly<{
  path: string;
  source: 'absolute' | 'path' | 'current-directory' | 'unresolved';
  pathEntry?: string;
}>;

function resolveCommandDetails(
  file: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CommandResolution {
  if (path.isAbsolute(file)) return { path: file, source: 'absolute' };

  const pathValue = platform === 'win32'
    ? env.Path || env.PATH || ''
    : env.PATH || '';
  const extensions = platform === 'win32'
    ? (path.extname(file)
      ? ['']
      : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidates = extension
        ? [`${file}${extension.toLowerCase()}`, `${file}${extension.toUpperCase()}`]
        : [file];
      for (const candidateName of candidates) {
        const candidate = path.resolve(dir || '.', candidateName);
        try {
          const stat = fs.statSync(candidate);
          if (!stat.isFile()) continue;
          if (platform !== 'win32' && (stat.mode & 0o111) === 0) continue;
          return {
            path: candidate,
            source: dir ? 'path' : 'current-directory',
            pathEntry: dir
          };
        } catch {
          // Keep searching the remaining PATH entries.
        }
      }
    }
  }

  return { path: file, source: 'unresolved' };
}

function resolveCommand(
  file: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  return resolveCommandDetails(file, platform, env).path;
}

function resolveCommandFromAbsolutePath(
  file: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const resolution = resolveCommandDetails(file, platform, env);
  return resolution.source === 'path' && resolution.pathEntry && path.isAbsolute(resolution.pathEntry)
    ? resolution.path
    : null;
}

function needsShell(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:bat|cmd)$/i.test(file);
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

export { needsShell, resolveCommand, resolveCommandFromAbsolutePath };
