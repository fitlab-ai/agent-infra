import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { err, info, ok } from './log.ts';
import { needsShell, resolveCommandFromAbsolutePath } from './run/host.ts';

type CommandResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

export type SelfUpdateOptions = Readonly<{
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  run?: (command: readonly string[]) => CommandResult;
}>;

export type UpdateSource = Readonly<{
  kind: 'npm' | 'brew';
  managerPath: string;
  packageRoot: string;
  updateArgs: readonly string[];
}>;

export type UpdateSourceResult = Readonly<{
  source: UpdateSource | null;
  error?: string;
}>;

type PackageInfo = Readonly<{
  root: string;
  name: string;
}>;

function canonicalPath(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

function comparable(target: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(target).replaceAll('\\', '/');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return comparable(left, platform) === comparable(right, platform);
}

function isWithin(root: string, target: string, platform: NodeJS.Platform): boolean {
  const normalizedRoot = comparable(root, platform).replace(/\/$/, '');
  const normalizedTarget = comparable(target, platform).replace(/\/$/, '');
  return normalizedTarget === normalizedRoot
    || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function packageInfoFromRoot(root: string): PackageInfo | null {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    ) as { name?: unknown };
    return typeof packageJson.name === 'string'
      ? { root, name: packageJson.name }
      : null;
  } catch {
    return null;
  }
}

function findPackageInfo(entry: string, platform: NodeJS.Platform): PackageInfo | null {
  const canonicalEntry = canonicalPath(entry);
  if (!canonicalEntry) return null;

  let current = path.dirname(canonicalEntry);
  while (true) {
    const canonicalRoot = canonicalPath(current);
    const info = canonicalRoot ? packageInfoFromRoot(canonicalRoot) : null;
    if (info && isWithin(info.root, canonicalEntry, platform)) return info;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageInfoFromCommand(commandPath: string, platform: NodeJS.Platform): PackageInfo | null {
  const direct = findPackageInfo(commandPath, platform);
  if (direct) return direct;
  if (!/\.(?:cmd|bat)$/i.test(commandPath)) return null;

  const globalPackageRoot = canonicalPath(path.join(
    path.dirname(commandPath),
    'node_modules',
    '@fitlab-ai',
    'agent-infra'
  ));
  return globalPackageRoot ? packageInfoFromRoot(globalPackageRoot) : null;
}

function visibleAliasError(
  packageRoot: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string | null {
  for (const alias of ['ai', 'agent-infra']) {
    const absolute = resolveCommandFromAbsolutePath(alias, platform, env);
    if (!absolute) continue;
    if (!canonicalPath(absolute)) continue;
    const info = packageInfoFromCommand(absolute, platform);
    if (info && !samePath(info.root, packageRoot, platform)) {
      return `PATH shadowing detected: ${alias} resolves to ${info.root}, not ${packageRoot}.`;
    }
  }
  return null;
}

function resolveManager(
  name: string,
  expectedBasenames: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): { path: string } | { error: string } | null {
  const absolute = resolveCommandFromAbsolutePath(name, platform, env);
  if (!absolute) {
    return { error: `${name} manager was not found on PATH.` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { error: `Cannot inspect manager executable: ${absolute}.` };
  }
  if (!stat.isFile()) return { error: `Manager executable is not a regular file: ${absolute}.` };
  if (!expectedBasenames.includes(path.basename(absolute).toLowerCase())) {
    return { error: `Unexpected manager executable: ${absolute}.` };
  }
  const canonical = canonicalPath(absolute);
  return canonical ? { path: canonical } : null;
}

function defaultRun(command: readonly string[], platform: NodeJS.Platform): CommandResult {
  const [file, ...args] = command;
  if (!file) return { status: null, error: new Error('run: missing command') };
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    shell: needsShell(file, platform),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

function runCommand(
  command: readonly string[],
  options: SelfUpdateOptions,
  platform: NodeJS.Platform
): CommandResult {
  return options.run ? options.run(command) : defaultRun(command, platform);
}

function probe(
  command: readonly string[],
  options: SelfUpdateOptions,
  platform: NodeJS.Platform,
  label: string
): string | { error: string } {
  const result = runCommand(command, options, platform);
  if (result.error) return { error: `${label} failed: ${result.error.message}` };
  if (result.signal) return { error: `${label} terminated by ${result.signal}.` };
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    return { error: `${label} exited with ${result.status ?? 1}${detail ? `: ${detail}` : '.'}` };
  }
  const output = result.stdout?.trim() || '';
  return output ? output : { error: `${label} returned no path.` };
}

function npmSource(
  packageInfo: PackageInfo,
  options: SelfUpdateOptions,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): UpdateSource | { error: string } | null {
  const manager = resolveManager(
    'npm',
    platform === 'win32' ? ['npm.cmd', 'npm.bat'] : ['npm'],
    platform,
    env
  );
  if (!manager) return null;
  if ('error' in manager) return manager;

  const prefixOutput = probe([manager.path, 'prefix', '--global'], options, platform, 'npm prefix --global');
  if (typeof prefixOutput !== 'string') return prefixOutput;
  const rootOutput = probe([manager.path, 'root', '--global'], options, platform, 'npm root --global');
  if (typeof rootOutput !== 'string') return rootOutput;
  const prefix = canonicalPath(prefixOutput);
  const globalRoot = canonicalPath(rootOutput);
  if (!prefix || !globalRoot) return { error: 'npm global prefix or root is not an existing directory.' };
  if (!isWithin(prefix, globalRoot, platform)) {
    return { error: `npm global root ${globalRoot} is outside prefix ${prefix}.` };
  }
  const expectedPackageRoot = canonicalPath(path.join(globalRoot, '@fitlab-ai', 'agent-infra'));
  if (!expectedPackageRoot || !samePath(expectedPackageRoot, packageInfo.root, platform)) {
    return { error: `Current CLI package is not owned by npm global root ${globalRoot}.` };
  }
  if (packageInfo.name !== '@fitlab-ai/agent-infra') {
    return { error: `Unexpected package name at ${packageInfo.root}: ${packageInfo.name}.` };
  }
  if (platform !== 'win32' && !isWithin(prefix, manager.path, platform)) {
    return { error: `npm manager ${manager.path} is outside global prefix ${prefix}.` };
  }
  return {
    kind: 'npm',
    managerPath: manager.path,
    packageRoot: packageInfo.root,
    updateArgs: ['update', '--global', '@fitlab-ai/agent-infra']
  };
}

function brewSource(
  packageInfo: PackageInfo,
  options: SelfUpdateOptions,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): UpdateSource | { error: string } | null {
  const manager = resolveManager('brew', ['brew', 'brew.exe', 'brew.cmd'], platform, env);
  if (!manager) return null;
  if ('error' in manager) return manager;

  const homebrewOutput = probe([manager.path, '--prefix'], options, platform, 'brew --prefix');
  if (typeof homebrewOutput !== 'string') return homebrewOutput;
  const formulaOutput = probe([manager.path, '--prefix', 'agent-infra'], options, platform, 'brew --prefix agent-infra');
  if (typeof formulaOutput !== 'string') return formulaOutput;
  const homebrewRoot = canonicalPath(homebrewOutput);
  const formulaRoot = canonicalPath(formulaOutput);
  if (!homebrewRoot || !formulaRoot) return { error: 'Homebrew prefix is not an existing directory.' };
  if (!isWithin(homebrewRoot, manager.path, platform)) {
    return { error: `brew manager ${manager.path} is outside Homebrew prefix ${homebrewRoot}.` };
  }
  if (!isWithin(homebrewRoot, formulaRoot, platform)) {
    return { error: `agent-infra formula prefix ${formulaRoot} is outside Homebrew prefix ${homebrewRoot}.` };
  }
  if (!isWithin(formulaRoot, packageInfo.root, platform)) {
    return { error: `Current CLI package is outside agent-infra formula prefix ${formulaRoot}.` };
  }
  if (packageInfo.name !== '@fitlab-ai/agent-infra') {
    return { error: `Unexpected package name at ${packageInfo.root}: ${packageInfo.name}.` };
  }
  return {
    kind: 'brew',
    managerPath: manager.path,
    packageRoot: packageInfo.root,
    updateArgs: ['upgrade', 'agent-infra']
  };
}

export function detectUpdateSource(options: SelfUpdateOptions = {}): UpdateSourceResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const entry = options.argv?.[1] ?? process.argv[1];
  if (!entry) return { source: null, error: 'Cannot determine the running CLI entry.' };
  const packageInfo = findPackageInfo(entry, platform);
  if (!packageInfo || packageInfo.name !== '@fitlab-ai/agent-infra') {
    return { source: null, error: 'Running CLI is not a persistent @fitlab-ai/agent-infra package installation.' };
  }
  const aliasError = visibleAliasError(packageInfo.root, platform, env);
  if (aliasError) return { source: null, error: aliasError };

  const candidates: UpdateSource[] = [];
  const errors: string[] = [];
  for (const candidate of [
    npmSource(packageInfo, options, platform, env),
    brewSource(packageInfo, options, platform, env)
  ]) {
    if (!candidate) continue;
    if ('error' in candidate) errors.push(candidate.error);
    else candidates.push(candidate);
  }
  if (candidates.length === 1) {
    const [source] = candidates;
    if (source) return { source };
  }
  if (candidates.length > 1) return { source: null, error: 'Multiple package managers claim the running CLI; refusing to choose.' };
  return {
    source: null,
    error: errors.length > 0
      ? errors.join(' ')
      : 'No supported persistent npm or Homebrew installation owns the running CLI.'
  };
}

function managerStable(source: UpdateSource, platform: NodeJS.Platform): boolean {
  const current = canonicalPath(source.managerPath);
  return current !== null && samePath(current, source.managerPath, platform);
}

export async function cmdUpdate(options: SelfUpdateOptions = {}): Promise<number> {
  const platform = options.platform ?? process.platform;
  const detected = detectUpdateSource(options);
  if (!detected.source) {
    err(`Cannot update agent-infra CLI: ${detected.error ?? 'unknown source'}`);
    err('Install persistently with "npm install -g @fitlab-ai/agent-infra" or "brew install fitlab-ai/tap/agent-infra".');
    return 1;
  }

  const source = detected.source;
  if (!managerStable(source, platform)) {
    err(`Cannot update agent-infra CLI: manager path changed: ${source.managerPath}.`);
    return 1;
  }
  info(`Updating agent-infra CLI via ${source.kind}.`);
  const result = runCommand([source.managerPath, ...source.updateArgs], options, platform);
  if (result.error) {
    err(`agent-infra CLI update failed: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    err(`agent-infra CLI update terminated by ${result.signal}.`);
    return 1;
  }
  if (result.status !== 0) {
    err(`agent-infra CLI update failed with exit code ${result.status ?? 1}.`);
    const detail = result.stderr?.trim();
    if (detail) err(detail);
    return result.status && result.status > 0 ? result.status : 1;
  }
  ok('agent-infra CLI updated successfully!');
  return 0;
}
