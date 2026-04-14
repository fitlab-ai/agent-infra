import { execFileSync, spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function normalizeOptions(opts = {}, stdio) {
  return {
    cwd: opts.cwd,
    encoding: opts.encoding,
    stdio,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS
  };
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    ...normalizeOptions(opts, ['pipe', 'pipe', 'pipe']),
    encoding: 'utf8'
  }).trim();
}

export function runOk(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, normalizeOptions(opts, 'pipe'));
  return result.status === 0;
}

export function runInteractive(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, normalizeOptions(opts, 'inherit'));
  return result.status ?? 1;
}

export function runVerbose(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, normalizeOptions(opts, 'inherit'));

  if (result.status !== 0) {
    if (result.signal === 'SIGTERM') {
      throw new Error(`Command timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms: ${cmd} ${args.join(' ')}`);
    }
    throw new Error(`Command failed with exit code ${result.status}: ${cmd} ${args.join(' ')}`);
  }
}

export function runSafe(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    ...normalizeOptions(opts, ['pipe', 'pipe', 'pipe']),
    encoding: 'utf8',
  });
  return (result.stdout ?? '').trim();
}

export function commandForEngine(engine, cmd, args = []) {
  if (engine === 'wsl2') {
    return { cmd: 'wsl.exe', args: ['--', cmd, ...args] };
  }

  return { cmd, args };
}

export function runEngine(engine, cmd, args, opts = {}) {
  const command = commandForEngine(engine, cmd, args);
  return run(command.cmd, command.args, opts);
}

export function execEngine(engine, cmd, args, opts = {}) {
  const command = commandForEngine(engine, cmd, args);
  return execFileSync(command.cmd, command.args, opts);
}

export function runOkEngine(engine, cmd, args, opts = {}) {
  const command = commandForEngine(engine, cmd, args);
  return runOk(command.cmd, command.args, opts);
}

export function runSafeEngine(engine, cmd, args, opts = {}) {
  const command = commandForEngine(engine, cmd, args);
  return runSafe(command.cmd, command.args, opts);
}

export function runVerboseEngine(engine, cmd, args, opts = {}) {
  const command = commandForEngine(engine, cmd, args);
  return runVerbose(command.cmd, command.args, opts);
}

export function runInteractiveEngine(engine, cmd, args, opts = {}) {
  const command = commandForEngine(engine, cmd, args);
  return runInteractive(command.cmd, command.args, opts);
}
