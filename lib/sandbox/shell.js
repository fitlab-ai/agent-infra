import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function normalizeOptions(opts = {}, stdio) {
  return {
    cwd: opts.cwd,
    encoding: opts.encoding,
    stdio,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS
  };
}

function resolveCommand(cmd) {
  if (process.platform !== 'win32' || path.extname(cmd)) {
    return cmd;
  }

  const pathValue = process.env.Path || process.env.PATH || '';
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${cmd}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const upperCandidate = path.join(dir, `${cmd}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) {
        return upperCandidate;
      }
    }
  }

  return cmd;
}

function commandOptions(cmd, opts) {
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(cmd)) {
    return { ...opts, shell: true };
  }
  return opts;
}

export function run(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd);
  return execFileSync(resolved, args, commandOptions(resolved, {
    ...normalizeOptions(opts, ['pipe', 'pipe', 'pipe']),
    encoding: 'utf8'
  })).trim();
}

export function runOk(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, normalizeOptions(opts, 'pipe')));
  return result.status === 0;
}

export function runInteractive(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, normalizeOptions(opts, 'inherit')));
  return result.status ?? 1;
}

export function runVerbose(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, normalizeOptions(opts, 'inherit')));

  if (result.status !== 0) {
    if (result.signal === 'SIGTERM') {
      throw new Error(`Command timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms: ${cmd} ${args.join(' ')}`);
    }
    throw new Error(`Command failed with exit code ${result.status}: ${cmd} ${args.join(' ')}`);
  }
}

export function runSafe(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd);
  const result = spawnSync(resolved, args, commandOptions(resolved, {
    ...normalizeOptions(opts, ['pipe', 'pipe', 'pipe']),
    encoding: 'utf8',
  }));
  return (result.stdout ?? '').trim();
}
