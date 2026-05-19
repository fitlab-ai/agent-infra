import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptions, StdioOptions } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as toml from 'smol-toml';
import { loadConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerName,
  containerNameCandidates,
  parsePositiveIntegerOption,
  sandboxBranchLabel,
  sandboxImageConfigLabel,
  sandboxLabel,
  sanitizeBranchName,
  shareBranchDir,
  shareCommonDir,
  worktreeDirCandidates
} from '../constants.ts';
import { prepareDockerfile } from '../dockerfile.ts';
import { detectEngine, ensureDocker } from '../engine.ts';
import {
  commandForEngine,
  execEngine,
  run,
  runEngine,
  runOk,
  runOkEngine,
  runSafe,
  runSafeEngine,
  runVerboseEngine
} from '../shell.ts';
import { resolveTaskBranch } from '../task-resolver.ts';
import { resolveTools, toolConfigDirCandidates, toolNpmPackagesArg } from '../tools.ts';
import type { SandboxTool } from '../tools.ts';
import { hostJoin, toEnginePath, volumeArg } from '../engines/wsl2-paths.ts';
import { validateSelinuxDisableEnv } from '../engines/selinux.ts';
import { resolveBuildUid } from '../engines/native.ts';
import { dotfilesCacheDir, materializeDotfiles } from '../dotfiles.ts';
import {
  assertClaudeCredentialsAvailable,
  redactCommandError,
  validateClaudeCredentialsEnvOverride
} from '../credentials.ts';

const OPENCODE_YOLO_PERMISSION = '{"*":"allow","read":"allow","bash":"allow","edit":"allow","webfetch":"allow","external_directory":"allow","doom_loop":"allow"}';
const SANDBOX_ALIAS_BLOCK_BEGIN = '# >>> agent-infra managed aliases >>>';
const SANDBOX_ALIAS_BLOCK_END = '# <<< agent-infra managed aliases <<<';
const SANDBOX_ALIAS_NAMES = [
  'claude-yolo',
  'opencode-yolo',
  'codex-yolo',
  'gemini-yolo',
  'cy',
  'oy',
  'xy',
  'gy'
];
const DEFAULT_SANDBOX_ALIASES = `alias claude-yolo='claude --dangerously-skip-permissions; tput ed'
alias opencode-yolo='OPENCODE_PERMISSION='\\''${OPENCODE_YOLO_PERMISSION}'\\'' opencode; tput ed'
alias codex-yolo='codex --yolo; tput ed'
alias gemini-yolo='gemini --yolo; tput ed'

alias cy='claude --dangerously-skip-permissions; tput ed'
alias oy='OPENCODE_PERMISSION='\\''${OPENCODE_YOLO_PERMISSION}'\\'' opencode; tput ed'
alias xy='codex --yolo; tput ed'
alias gy='gemini --yolo; tput ed'
`;
const CONTAINER_HOME = '/home/devuser';
const CONTAINER_SHELL_CONFIG_MOUNT = `${CONTAINER_HOME}/.host-shell-config`;
const USAGE = `Usage: ai sandbox create <branch> [base] [--cpu <n>] [--memory <n>]

Host aliases:
  ${'~'}/.agent-infra/aliases/sandbox.sh is auto-created on first run and exposed
  as ${CONTAINER_HOME}/.bash_aliases inside the sandbox container (the host
  shell-config directory is bind-mounted at ${CONTAINER_SHELL_CONFIG_MOUNT} and
  symlinked into $HOME).`;

type SandboxCreateConfig = ReturnType<typeof loadConfig>;
type PreparedDockerfile = ReturnType<typeof prepareDockerfile>;
type ResolvedTool = { tool: SandboxTool; dir: string };
type RuntimeCheck = { name: string; cmd: string[] };
type JsonObject = Record<string, unknown>;
type GpgCache = { pub: Buffer; sec: Buffer } | null;
type ExecSyncOptions = ExecFileSyncOptions & {
  input?: Buffer | string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  encoding?: BufferEncoding;
};
type ExecSyncFn = (cmd: string, args: string[], options?: ExecSyncOptions) => Buffer | string;
type EngineExecFn = (engine: string, cmd: string, args: string[], opts?: ExecFileSyncOptions) => Buffer | string;
type EngineRunFn = (engine: string, cmd: string, args: string[], opts?: { cwd?: string }) => string;
type EngineRunSafeFn = EngineRunFn;
type EngineRunVerboseFn = (engine: string, cmd: string, args: string[], opts?: { cwd?: string }) => void;
type DirectRunFn = (cmd: string, args: string[], opts?: { cwd?: string }) => string;
type DirectRunSafeFn = DirectRunFn;
type DirectRunVerboseFn = (cmd: string, args: string[], opts?: { cwd?: string }) => void;
type HostShellConfig = {
  hostDir: string;
  mounts: Array<{ hostPath: string; containerPath: string }>;
};

function buildSignature(preparedDockerfile: PreparedDockerfile, tools: SandboxTool[]): string {
  return createHash('sha256')
    .update(JSON.stringify({
      dockerfile: preparedDockerfile.signature,
      tools: tools.map((tool) => tool.npmPackage)
    }))
    .digest('hex')
    .slice(0, 12);
}

function resolveToolDirs(config: Pick<SandboxCreateConfig, 'project'>, tools: SandboxTool[], branch: string): ResolvedTool[] {
  return tools.map((tool) => {
    const candidates = toolConfigDirCandidates(tool, config.project, branch);
    return {
      tool,
      dir: candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? ''
    };
  });
}

export function hostShellConfigDir(home: string, project: string, branch: string): string {
  return hostJoin(home, '.agent-infra', 'config', project, sanitizeBranchName(branch));
}

function runtimeChecks(runtimes: string[]): RuntimeCheck[] {
  const checks: RuntimeCheck[] = [];
  if (runtimes.some((runtime) => runtime.startsWith('node'))) {
    checks.push({ name: 'Node.js', cmd: ['node', '--version'] });
  }
  if (runtimes.some((runtime) => runtime.startsWith('java'))) {
    checks.push({ name: 'Java', cmd: ['java', '-version'] });
    checks.push({ name: 'Maven', cmd: ['mvn', '--version'] });
  }
  if (runtimes.includes('python3')) {
    checks.push({ name: 'Python', cmd: ['python3', '--version'] });
  }
  return checks;
}

export function detectGpgConfig(gitconfig: string): boolean {
  return /\bgpgsign\s*=\s*true\b/i.test(gitconfig) || /^\s*\[gpg(?:\s|"|\])/im.test(gitconfig);
}

function appendSafeDirectories(lines: string[], repoRoot: string): string[] {
  if (!repoRoot) {
    return lines;
  }

  const requiredDirectories = ['/workspace', repoRoot];
  const existingDirectories = new Set<string>();
  let firstSafeSectionIndex = -1;
  let inSafeSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSafeSection = (sectionMatch[1] ?? '').trim().toLowerCase() === 'safe';
      if (inSafeSection && firstSafeSectionIndex === -1) {
        firstSafeSectionIndex = index;
      }
      continue;
    }

    if (!inSafeSection) {
      continue;
    }

    const directoryMatch = line.match(/^\s*directory\s*=\s*(.+?)\s*$/i);
    if (directoryMatch) {
      existingDirectories.add((directoryMatch[1] ?? '').trim());
    }
  }

  const missingDirectories = requiredDirectories
    .filter((directory) => !existingDirectories.has(directory));
  if (missingDirectories.length === 0) {
    return lines;
  }

  if (firstSafeSectionIndex === -1) {
    return [
      ...lines,
      '[safe]',
      ...missingDirectories.map((directory) => `\tdirectory = ${directory}`)
    ];
  }

  const updatedLines = [...lines];
  let insertIndex = updatedLines.length;
  for (let index = firstSafeSectionIndex + 1; index < updatedLines.length; index += 1) {
    if (/^\s*\[([^\]]+)\]\s*$/.test(updatedLines[index] ?? '')) {
      insertIndex = index;
      break;
    }
  }

  updatedLines.splice(
    insertIndex,
    0,
    ...missingDirectories.map((directory) => `\tdirectory = ${directory}`)
  );
  return updatedLines;
}

function normalizeContainerHomeSeparators(content: string): string {
  const containerHomePattern = new RegExp(`${escapeRegExp(CONTAINER_HOME)}\\S*`, 'g');
  return content.replace(containerHomePattern, (value) => value.replaceAll('\\', '/'));
}

export function sanitizeGitConfig(
  gitconfig: string,
  home: string,
  { stripGpg = false, repoRoot = '' }: { stripGpg?: boolean; repoRoot?: string } = {}
): string {
  const posixHome = home.replaceAll('\\', '/');
  const normalizedGitconfig = gitconfig
    .replaceAll(home, CONTAINER_HOME)
    .replaceAll(posixHome, CONTAINER_HOME);
  const lines = normalizeContainerHomeSeparators(normalizedGitconfig)
    .replace(/\[difftool "sourcetree"\][^\[]*/gs, '')
    .replace(/\[mergetool "sourcetree"\][^\[]*/gs, '')
    .split(/\r?\n/);

  const sanitized = [];
  let inGpgSection = false;
  let currentSection = '';

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      const sectionName = (sectionMatch[1] ?? '').trim();
      currentSection = ((sectionName.match(/^([^\s"]+)/)?.[1]) ?? '').toLowerCase();
      inGpgSection = /^gpg(?:\s+"[^"]+")?$/i.test(sectionName);
      if (stripGpg && inGpgSection) {
        continue;
      }
      sanitized.push(line);
      continue;
    }

    if (inGpgSection) {
      if (stripGpg) {
        continue;
      }
      if (/^\s*program\s*=.*$/i.test(line)) {
        continue;
      }
    }

    if (stripGpg && currentSection === 'commit' && /^\s*gpgsign\s*=.*$/i.test(line)) {
      continue;
    }
    if (stripGpg && currentSection === 'tag' && /^\s*gpgsign\s*=.*$/i.test(line)) {
      continue;
    }
    if (stripGpg && currentSection === 'user' && /^\s*signingKey\s*=.*$/i.test(line)) {
      continue;
    }

    sanitized.push(line);
  }

  return appendSafeDirectories(sanitized, repoRoot).join('\n');
}

export function hostHasGpgKeys(home: string, execFn: ExecSyncFn = execFileSync): boolean {
  return currentKeyringFingerprint(home, execFn) !== null;
}

export function writeSanitizedGitconfig({
  home,
  hostConfigDir,
  stripGpg,
  repoRoot
}: {
  home: string;
  hostConfigDir: string;
  stripGpg: boolean;
  repoRoot: string;
}): string {
  const gitconfigPath = hostJoin(home, '.gitconfig');
  // Always emit a sanitized .gitconfig, even when the host has none. The
  // container ~/.gitconfig is a symlink into the bound shell-config directory;
  // a missing file would leave the symlink dangling and drop the default
  // safe.directory entries the image relies on.
  const sourceContent = fs.existsSync(gitconfigPath)
    ? fs.readFileSync(gitconfigPath, 'utf8')
    : '';

  fs.mkdirSync(hostConfigDir, { recursive: true });
  const targetPath = path.join(hostConfigDir, '.gitconfig');
  const gitconfig = sanitizeGitConfig(sourceContent, home, { stripGpg, repoRoot });
  fs.writeFileSync(targetPath, gitconfig, 'utf8');
  return targetPath;
}

// Files inside the host shell-config bind that need to be exposed in $HOME.
// Keep in sync with the symlink block in lib/sandbox/runtimes/ai-tools.dockerfile.
const SHELL_CONFIG_SYMLINKS = ['.gitconfig', '.gitignore_global', '.stCommitMsg', '.bash_aliases'];

export function ensureShellConfigSymlinks(engine: string, container: string, execFn: EngineExecFn = execEngine): void {
  // Idempotent symlink setup. Runs against a started container so it also
  // covers custom Dockerfiles that don't bake the symlinks into the image.
  const script = SHELL_CONFIG_SYMLINKS
    .map((file) => `ln -sf .host-shell-config/${file} ${CONTAINER_HOME}/${file}`)
    .join(' && ');
  execFn(engine, 'docker', ['exec', container, 'bash', '-lc', script], { stdio: 'ignore' });
}

export function prepareHostShellConfig({
  home,
  project,
  branch,
  repoRoot
}: {
  home: string;
  project: string;
  branch: string;
  repoRoot: string;
}): HostShellConfig {
  const hostDir = hostShellConfigDir(home, project, branch);
  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.mkdirSync(hostDir, { recursive: true });

  writeSanitizedGitconfig({
    home,
    hostConfigDir: hostDir,
    stripGpg: true,
    repoRoot
  });

  for (const file of ['.gitignore_global', '.stCommitMsg']) {
    const hostPath = hostJoin(home, file);
    if (!fs.existsSync(hostPath)) {
      continue;
    }

    fs.copyFileSync(hostPath, path.join(hostDir, file));
  }

  const aliasesPath = sandboxAliasesPath(home);
  if (fs.existsSync(aliasesPath)) {
    fs.copyFileSync(aliasesPath, path.join(hostDir, '.bash_aliases'));
  }

  // Single directory bind keeps virtiofs happy: per-file rewrites inside no
  // longer race the bind layer like individual single-file binds do.
  const mounts = [{ hostPath: hostDir, containerPath: CONTAINER_SHELL_CONFIG_MOUNT }];

  return { hostDir, mounts };
}

function gpgCacheDir(home: string, project: string): string {
  return hostJoin(home, '.agent-infra', 'gpg-cache', project);
}

function normalizeSigningKey(signingKey: unknown): string | null {
  if (typeof signingKey !== 'string') {
    return null;
  }

  const trimmed = signingKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorktreePath(worktreePath: string): string {
  if (!worktreePath) {
    return '';
  }

  try {
    return fs.existsSync(worktreePath) ? fs.realpathSync(worktreePath) : path.resolve(worktreePath);
  } catch {
    return path.resolve(worktreePath);
  }
}

export function getGitSigningKey({
  home,
  repoPath = null,
  execFn = execFileSync
}: {
  home?: string;
  repoPath?: string | null;
  execFn?: ExecSyncFn;
} = {}): string | null {
  if (!home) {
    return null;
  }
  try {
    const output = execFn('git', [
      ...(repoPath ? ['-C', repoPath] : []),
      'config',
      ...(repoPath ? [] : ['--global']),
      'user.signingKey'
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return normalizeSigningKey(output.toString());
  } catch {
    return null;
  }
}

export function currentKeyringFingerprint(home: string, execFn: ExecSyncFn = execFileSync): string | null {
  const hostEnv = { ...process.env, HOME: home };
  try {
    const keyring = execFn('gpg', ['--list-secret-keys', '--with-colons'], {
      encoding: 'utf8',
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const keyringText = keyring.toString();
    if (!keyringText || keyringText.trim().length === 0) {
      return null;
    }
    return createHash('sha256').update(keyringText).digest('hex');
  } catch {
    return null;
  }
}

export function readGpgCache(
  home: string,
  project: string,
  execFn: ExecSyncFn = execFileSync,
  signingKey: string | null = null
): GpgCache {
  const cacheDir = gpgCacheDir(home, project);
  const pubPath = path.join(cacheDir, 'public.asc');
  const secPath = path.join(cacheDir, 'secret.asc');
  const statePath = path.join(cacheDir, 'state.json');

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { fingerprint?: unknown; signingKey?: unknown };
    if (typeof state?.fingerprint !== 'string' || state.fingerprint.length === 0) {
      return null;
    }
    if (normalizeSigningKey(state?.signingKey) !== normalizeSigningKey(signingKey)) {
      return null;
    }

    const currentFingerprint = currentKeyringFingerprint(home, execFn);
    if (!currentFingerprint || currentFingerprint !== state.fingerprint) {
      return null;
    }

    const pub = fs.readFileSync(pubPath);
    const sec = fs.readFileSync(secPath);
    if (pub.length === 0 || sec.length === 0) {
      return null;
    }

    return { pub, sec };
  } catch {
    return null;
  }
}

export function writeGpgCache(
  home: string,
  project: string,
  pub: Buffer | string,
  sec: Buffer | string,
  fingerprint: string | null,
  signingKey: string | null = null
): boolean {
  if (!fingerprint) {
    return false;
  }

  const cacheDir = gpgCacheDir(home, project);
  const pubPath = path.join(cacheDir, 'public.asc');
  const secPath = path.join(cacheDir, 'secret.asc');
  const statePath = path.join(cacheDir, 'state.json');

  try {
    const state: { fingerprint: string; signingKey?: string } = { fingerprint };
    const normalizedSigningKey = normalizeSigningKey(signingKey);
    if (normalizedSigningKey) {
      state.signingKey = normalizedSigningKey;
    }

    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(cacheDir, 0o700);

    fs.writeFileSync(pubPath, pub, { mode: 0o600 });
    fs.chmodSync(pubPath, 0o600);

    fs.writeFileSync(secPath, sec, { mode: 0o600 });
    fs.chmodSync(secPath, 0o600);

    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);

    return true;
  } catch {
    return false;
  }
}

export function syncGpgKeys(
  container: string,
  home: string,
  project: string,
  execFn: ExecSyncFn = execFileSync,
  runSafeFn: DirectRunSafeFn = runSafe,
  options: {
    cachedOverride?: GpgCache;
    repoPath?: string | null;
    signingKey?: string | null;
    dockerExecFn?: ExecSyncFn;
    dockerRunSafeFn?: DirectRunSafeFn;
  } = {}
): boolean {
  const {
    cachedOverride = null,
    repoPath = null,
    signingKey: signingKeyOverride,
    dockerExecFn = execFn,
    dockerRunSafeFn = runSafeFn
  } = options;
  const hostEnv = { ...process.env, HOME: home };
  let signingKey = normalizeSigningKey(signingKeyOverride);
  let resolvedSigningKey = Object.hasOwn(options, 'signingKey');
  // Allow callers to supply a pre-computed cache read so we don't re-invoke
  // `gpg --list-secret-keys` just to decide the progress message.
  if (cachedOverride === null && !resolvedSigningKey) {
    signingKey = getGitSigningKey({ repoPath, home, execFn });
    resolvedSigningKey = true;
  }
  const cached = cachedOverride ?? readGpgCache(home, project, execFn, signingKey);
  let pubKeys = cached?.pub ?? null;
  let secKeys = cached?.sec ?? null;

  if (!cached && !resolvedSigningKey) {
    signingKey = getGitSigningKey({ repoPath, home, execFn });
    resolvedSigningKey = true;
  }

  if (!cached) {
    const exportArgs = signingKey ? ['--export', signingKey] : ['--export'];
    const exportSecretArgs = signingKey
      ? ['--export-secret-keys', signingKey]
      : ['--export-secret-keys'];

    pubKeys = Buffer.from(execFn('gpg', exportArgs, {
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
    if (!pubKeys || pubKeys.length === 0) {
      return false;
    }

    secKeys = Buffer.from(execFn('gpg', exportSecretArgs, {
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
    if (!secKeys || secKeys.length === 0) {
      return false;
    }

    const fingerprint = currentKeyringFingerprint(home, execFn);
    if (fingerprint) {
      const written = writeGpgCache(home, project, pubKeys, secKeys, fingerprint, signingKey);
      if (!written) {
        process.stderr.write(
          'Warning: failed to cache GPG keys; next sandbox create may prompt again.\n'
        );
      }
    }
  }

  dockerExecFn('docker', ['exec', '-i', container, 'gpg', '--import'], {
    input: pubKeys ?? undefined,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  dockerExecFn('docker', ['exec', '-i', container, 'gpg', '--batch', '--import'], {
    input: secKeys ?? undefined,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  dockerRunSafeFn('docker', ['exec', container, 'gpgconf', '--launch', 'gpg-agent']);
  return true;
}

// Docker `--env-file` parsing has no quoting/escaping support and treats
// leading '#' as a comment. Newlines split entries, so reject them outright.
// Other shell metacharacters are safe because the values are not expanded.
function formatEnvFileEntry(key: string, value: string): string {
  if (String(key).includes('\n') || String(value).includes('\n')) {
    throw new Error(`Container environment variable ${key} must not contain newlines`);
  }
  return `${key}=${value}`;
}

export function buildContainerEnvFile(
  resolvedTools: ResolvedTool[],
  engine: string,
  runSafeEngineFn: EngineRunSafeFn = runSafeEngine,
  options: {
    mkdtempFn?: typeof fs.mkdtempSync;
    writeFileFn?: typeof fs.writeFileSync;
    chmodFn?: typeof fs.chmodSync;
    rmFn?: typeof fs.rmSync;
    tmpDir?: string;
  } = {}
): { dockerArgs: string[]; cleanup: () => void } {
  const {
    mkdtempFn = fs.mkdtempSync,
    writeFileFn = fs.writeFileSync,
    chmodFn = fs.chmodSync,
    rmFn = fs.rmSync,
    tmpDir = os.tmpdir()
  } = options;

  const entries: Array<[string, string]> = resolvedTools.flatMap(({ tool }) => Object.entries(tool.envVars ?? {}));
  const ghToken = runSafeEngineFn(engine, 'gh', ['auth', 'token']);
  if (ghToken) {
    entries.push(['GH_TOKEN', ghToken]);
  }

  if (entries.length === 0) {
    return { dockerArgs: [], cleanup: () => {} };
  }

  const dir = mkdtempFn(path.join(tmpDir, 'agent-infra-env-'));
  try {
    chmodFn(dir, 0o700);
    const envPath = path.join(dir, 'env');
    const content = `${entries.map(([key, value]) => formatEnvFileEntry(key, value)).join('\n')}\n`;
    writeFileFn(envPath, content, { mode: 0o600 });
    chmodFn(envPath, 0o600);

    return {
      dockerArgs: ['--env-file', toEnginePath(engine, envPath)],
      cleanup: () => {
        try {
          rmFn(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }
    };
  } catch (error) {
    try {
      rmFn(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

export function buildDotfilesVolumeArgs(
  engine: string,
  snapshotDir: string | null | undefined,
  existsFn: typeof fs.existsSync = fs.existsSync
): string[] {
  if (!snapshotDir || !existsFn(snapshotDir)) {
    return [];
  }
  return ['-v', volumeArg(engine, snapshotDir, '/dotfiles', ':ro')];
}

export function assertBranchAvailable(
  repoRoot: string,
  branch: string,
  { allowedWorktrees = [], runFn = runSafe }: { allowedWorktrees?: string[]; runFn?: DirectRunSafeFn } = {}
): void {
  const normalizedAllowedWorktrees = new Set(allowedWorktrees.map((worktree) => normalizeWorktreePath(worktree)));
  const output = runFn('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  if (!output) {
    return;
  }

  let currentWorktree = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktree = line.slice('worktree '.length).trim();
      continue;
    }
    if (!line.startsWith('branch refs/heads/')) {
      continue;
    }

    const usedBranch = line.slice('branch refs/heads/'.length).trim();
    if (usedBranch === branch) {
      if (normalizedAllowedWorktrees.has(normalizeWorktreePath(currentWorktree))) {
        continue;
      }
      throw new Error(
        `Branch '${branch}' is already checked out at '${currentWorktree}'.\n`
        + `Use a different branch name, or run 'git switch <other>' in that worktree first.`
      );
    }
  }
}

function readHostJsonSafe(filePath: string): JsonObject | null {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

export function ensureClaudeOnboarding(toolDir: string, hostHomeDir?: string): void {
  const claudeJsonPath = path.join(toolDir, '.claude.json');
  let data: JsonObject & {
    hasCompletedOnboarding?: boolean;
    projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    model?: string;
  } = {};
  if (fs.existsSync(claudeJsonPath)) {
    try {
      data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as typeof data;
    } catch {
      // malformed JSON, start fresh
    }
  }
  let changed = false;
  if (!data.hasCompletedOnboarding) {
    data.hasCompletedOnboarding = true;
    changed = true;
  }
  if (!data.projects) {
    data.projects = {};
    changed = true;
  }
  if (!data.projects['/workspace']) {
    data.projects['/workspace'] = {};
    changed = true;
  }
  if (!data.projects['/workspace'].hasTrustDialogAccepted) {
    data.projects['/workspace'].hasTrustDialogAccepted = true;
    changed = true;
  }
  if (hostHomeDir) {
    const hostClaudeJson = readHostJsonSafe(path.join(hostHomeDir, '.claude.json'));
    if (
      hostClaudeJson
      && typeof hostClaudeJson.model === 'string'
      && hostClaudeJson.model !== ''
      && !Object.hasOwn(data, 'model')
    ) {
      data.model = hostClaudeJson.model;
      changed = true;
    }
    // Claude Code launch-pins a default effort per model generation (for
    // example xhigh for Opus 4.7). The saved effortLevel is honored only after
    // a top-level boolean `unpin*LaunchEffort: true` flag unlocks it, so mirror
    // those flags here with the existing first-write semantics.
    //
    // Pattern matching avoids one patch per future model generation. If
    // Anthropic changes the naming convention, this block will no-op and should
    // be revisited.
    if (hostClaudeJson) {
      for (const key of Object.keys(hostClaudeJson)) {
        if (
          /^unpin.*LaunchEffort$/.test(key)
          && hostClaudeJson[key] === true
          && !Object.hasOwn(data, key)
        ) {
          data[key] = true;
          changed = true;
        }
      }
    }
  }
  if (changed) {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 4), 'utf8');
  }
}

export function ensureClaudeSettings(toolDir: string, hostHomeDir?: string): void {
  const settingsPath = path.join(toolDir, 'settings.json');
  let data: JsonObject & { skipDangerousModePermissionPrompt?: boolean; effortLevel?: string } = {};
  if (fs.existsSync(settingsPath)) {
    try {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as typeof data;
    } catch {
      // malformed JSON, start fresh
    }
  }
  let changed = false;
  if (data.skipDangerousModePermissionPrompt !== true) {
    data.skipDangerousModePermissionPrompt = true;
    changed = true;
  }
  if (hostHomeDir) {
    const hostSettings = readHostJsonSafe(path.join(hostHomeDir, '.claude', 'settings.json'));
    if (
      hostSettings
      && typeof hostSettings.effortLevel === 'string'
      && hostSettings.effortLevel !== ''
      && !Object.hasOwn(data, 'effortLevel')
    ) {
      data.effortLevel = hostSettings.effortLevel;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 4), 'utf8');
  }
}

export function ensureCodexModelInheritance(toolDir: string, hostHomeDir?: string): void {
  if (!hostHomeDir) {
    return;
  }

  const hostConfigPath = path.join(hostHomeDir, '.codex', 'config.toml');
  if (!fs.existsSync(hostConfigPath)) {
    return;
  }

  let hostParsed: JsonObject;
  try {
    hostParsed = toml.parse(fs.readFileSync(hostConfigPath, 'utf8')) as JsonObject;
  } catch {
    return;
  }

  const sandboxConfigPath = path.join(toolDir, 'config.toml');
  // This rewrites sandbox-side TOML and drops comments; the host config stays untouched.
  let sandboxParsed: JsonObject = {};
  if (fs.existsSync(sandboxConfigPath)) {
    try {
      sandboxParsed = toml.parse(fs.readFileSync(sandboxConfigPath, 'utf8')) as JsonObject;
    } catch {
      return;
    }
  }

  let changed = false;
  for (const key of ['model', 'model_reasoning_effort']) {
    if (Object.hasOwn(sandboxParsed, key)) {
      continue;
    }
    const value = hostParsed[key];
    if (typeof value !== 'string' || value === '') {
      continue;
    }
    sandboxParsed[key] = value;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(sandboxConfigPath, `${toml.stringify(sandboxParsed)}\n`, 'utf8');
  }
}

export function ensureCodexWorkspaceTrust(toolDir: string): void {
  const configPath = path.join(toolDir, 'config.toml');
  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf8');
  }
  if (!content.includes('[projects."/workspace"]')) {
    const entry = '\n[projects."/workspace"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(configPath, content + entry, 'utf8');
  }
}

export function ensureOpenCodeModelInheritance(toolDir: string, hostHomeDir?: string): void {
  if (!hostHomeDir) {
    return;
  }

  const hostConfigPath = path.join(hostHomeDir, '.config', 'opencode', 'opencode.json');
  const hostJson = readHostJsonSafe(hostConfigPath);
  if (!hostJson) {
    return;
  }

  const sandboxConfigPath = path.join(toolDir, 'opencode.json');
  let sandboxJson: JsonObject = {};
  if (fs.existsSync(sandboxConfigPath)) {
    const existing = readHostJsonSafe(sandboxConfigPath);
    if (!existing) {
      return;
    }
    sandboxJson = existing;
  }
  let changed = false;
  for (const key of ['model', 'small_model']) {
    if (Object.hasOwn(sandboxJson, key)) {
      continue;
    }
    const value = hostJson[key];
    if (typeof value !== 'string' || value === '') {
      continue;
    }
    sandboxJson[key] = value;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(sandboxConfigPath, JSON.stringify(sandboxJson, null, 2), 'utf8');
  }
}

export function ensureGeminiWorkspaceTrust(toolDir: string): void {
  const trustPath = path.join(toolDir, 'trustedFolders.json');
  let data: Record<string, string> = {};
  if (fs.existsSync(trustPath)) {
    try {
      data = JSON.parse(fs.readFileSync(trustPath, 'utf8')) as Record<string, string>;
    } catch {
      // malformed JSON, start fresh
    }
  }
  if (data['/workspace'] !== 'TRUST_FOLDER') {
    data['/workspace'] = 'TRUST_FOLDER';
    fs.writeFileSync(trustPath, JSON.stringify(data, null, 2), 'utf8');
  }
}

export function sandboxAliasesPath(home: string): string {
  return hostJoin(home, '.agent-infra', 'aliases', 'sandbox.sh');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripManagedSandboxAliasBlocks(content: string): string {
  const blockPattern = new RegExp(
    `${escapeRegExp(SANDBOX_ALIAS_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(SANDBOX_ALIAS_BLOCK_END)}\\n?`,
    'g'
  );
  return content.replace(blockPattern, '').trimEnd();
}

function isLegacyManagedSandboxAliasFile(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  const aliasPattern = new RegExp(`^alias (${SANDBOX_ALIAS_NAMES.map(escapeRegExp).join('|')})=`);
  return lines.every((line) => aliasPattern.test(line));
}

export function ensureSandboxAliasesFile(home: string): { created: boolean; path: string } {
  const aliasesPath = sandboxAliasesPath(home);
  const managedBlock = `${SANDBOX_ALIAS_BLOCK_BEGIN}\n${DEFAULT_SANDBOX_ALIASES}${SANDBOX_ALIAS_BLOCK_END}\n`;
  fs.mkdirSync(path.dirname(aliasesPath), { recursive: true });
  const created = !fs.existsSync(aliasesPath);
  let existing = '';

  if (!created) {
    existing = fs.readFileSync(aliasesPath, 'utf8');
  }

  const userContent = isLegacyManagedSandboxAliasFile(existing)
    ? ''
    : stripManagedSandboxAliasBlocks(existing);
  const nextContent = userContent
    ? `${userContent}\n\n${managedBlock}`
    : managedBlock;

  if (created || nextContent !== existing) {
    fs.writeFileSync(aliasesPath, nextContent, 'utf8');
  }

  return { created, path: aliasesPath };
}

export function commandErrorMessage(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error
    ? String(error.stderr).trim()
    : '';
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : 'Command failed';
  return redactCommandError(stderr || message);
}

function runTaskCommand(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  try {
    return run(cmd, args, opts);
  } catch (error) {
    throw new Error(commandErrorMessage(error));
  }
}

function runEngineTaskCommand(engine: string, cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  const command = commandForEngine(engine, cmd, args);
  return runTaskCommand(command.cmd, command.args, opts);
}

export function buildImage(
  config: SandboxCreateConfig,
  tools: SandboxTool[],
  dockerfilePath: string,
  imageSignature: string,
  {
    engine,
    runFn = runEngine,
    runSafeFn = runSafeEngine,
    runVerboseFn = runVerboseEngine,
    env = process.env
  }: {
    engine?: string;
    runFn?: EngineRunFn;
    runSafeFn?: EngineRunSafeFn;
    runVerboseFn?: EngineRunVerboseFn;
    env?: NodeJS.ProcessEnv;
  } = {}
): void {
  const selectedEngine = engine ?? detectEngine(config);
  const { uid: hostUid, gid: hostGid } = resolveBuildUid({
    engine: selectedEngine,
    runFn,
    runSafeFn,
    env
  });

  runVerboseFn(selectedEngine, 'docker', [
    'build',
    '-t',
    config.imageName,
    '--build-arg',
    `HOST_UID=${hostUid}`,
    '--build-arg',
    `HOST_GID=${hostGid}`,
    '--build-arg',
    `AI_TOOL_PACKAGES=${toolNpmPackagesArg(tools)}`,
    '--label',
    sandboxLabel(config),
    '--label',
    `${sandboxImageConfigLabel(config)}=${imageSignature}`,
    '-f',
    toEnginePath(selectedEngine, dockerfilePath),
    toEnginePath(selectedEngine, config.repoRoot)
  ], { cwd: config.repoRoot });
}

export async function create(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      cpu: { type: 'string' },
      memory: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error(USAGE);
  }

  validateSelinuxDisableEnv();
  validateClaudeCredentialsEnvOverride();

  const config = loadConfig();
  const [branchOrTaskId = '', base] = positionals;
  const branch = resolveTaskBranch(branchOrTaskId, config.repoRoot);
  assertValidBranchName(branch);
  const effectiveConfig = {
    ...config,
    vm: {
      ...config.vm,
      cpu: parsePositiveIntegerOption(values.cpu, '--cpu') ?? config.vm.cpu,
      memory: parsePositiveIntegerOption(values.memory, '--memory') ?? config.vm.memory
    }
  };
  const worktreeCandidates = worktreeDirCandidates(effectiveConfig, branch);
  assertBranchAvailable(config.repoRoot, branch, { allowedWorktrees: worktreeCandidates });
  const tools = resolveTools(effectiveConfig);
  const resolvedTools = resolveToolDirs(effectiveConfig, tools, branch);
  // Fail fast before any filesystem/docker side effects so a missing
  // Claude Code credential blob doesn't leave the user with a stale
  // worktree, docker image, or temporary Dockerfile they need to manually
  // clean up.
  assertClaudeCredentialsAvailable(
    effectiveConfig.home,
    effectiveConfig.project,
    resolvedTools
  );
  const container = containerName(effectiveConfig, branch);
  const worktree = worktreeCandidates.find((candidate) => fs.existsSync(candidate)) ?? worktreeCandidates[0] ?? '';
  const shareCommon = shareCommonDir(effectiveConfig);
  const shareBranch = shareBranchDir(effectiveConfig, branch);
  const preparedDockerfile = prepareDockerfile(effectiveConfig);
  const baseBranch = base ?? runSafe('git', ['-C', effectiveConfig.repoRoot, 'branch', '--show-current']);
  const expectedImageSignature = buildSignature(preparedDockerfile, tools);
  const engine = detectEngine(effectiveConfig);

  p.intro(pc.cyan('AI Sandbox'));
  p.log.info(
    `Project: ${pc.bold(effectiveConfig.project)} | Branch: ${pc.bold(branch)} | Base: ${pc.bold(baseBranch || 'HEAD')}`
  );

  try {
    p.log.step('Checking container engine...');
    await ensureDocker(effectiveConfig, (detail: string) => {
      p.log.info(`  ${detail}`);
    });
    p.log.success('Docker is ready');

    const imageExists = runOkEngine(engine, 'docker', ['image', 'inspect', effectiveConfig.imageName]);
    const currentImageSignature = imageExists
      ? runSafeEngine(engine, 'docker', [
        'image',
        'inspect',
        '--format',
        `{{ index .Config.Labels "${sandboxImageConfigLabel(effectiveConfig)}" }}`,
        effectiveConfig.imageName
      ])
      : '';
    const needsImageBuild = !imageExists || currentImageSignature !== expectedImageSignature;

    if (needsImageBuild) {
      p.log.step(imageExists ? 'Rebuilding stale image...' : 'Building image for first use...');
      buildImage(
        effectiveConfig,
        tools,
        preparedDockerfile.path,
        expectedImageSignature,
        { engine }
      );
      p.log.success(imageExists ? 'Image rebuilt' : 'Image built');
    } else {
      p.log.step(`Using existing image ${effectiveConfig.imageName}`);
    }

    await p.tasks([
      {
        title: 'Setting up git worktree',
        task: async (message: (text: string) => void) => {
          if (fs.existsSync(worktree)) {
            if (fs.readdirSync(worktree).length > 0) {
              return `Worktree exists at ${worktree}`;
            }
            fs.rmSync(worktree, { recursive: true, force: true });
          }

          const branchExists = runOk('git', [
            '-C',
            effectiveConfig.repoRoot,
            'show-ref',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`
          ]);

          if (branchExists) {
            message(`Using existing branch '${branch}'...`);
            runEngineTaskCommand(engine, 'git', [
              '-C',
              toEnginePath(engine, effectiveConfig.repoRoot),
              'worktree',
              'add',
              toEnginePath(engine, worktree),
              branch
            ]);
          } else {
            message(`Creating branch '${branch}' from '${baseBranch}'...`);
            runEngineTaskCommand(engine, 'git', [
              '-C',
              toEnginePath(engine, effectiveConfig.repoRoot),
              'worktree',
              'add',
              '-b',
              branch,
              toEnginePath(engine, worktree),
              baseBranch
            ]);
          }

          return `Worktree ready at ${worktree}`;
        }
      },
      {
        title: 'Preparing tool state',
        task: async () => {
          for (const { tool, dir } of resolvedTools) {
            fs.mkdirSync(dir, { recursive: true });

            for (const { hostPath, sandboxName } of tool.hostPreSeedFiles ?? []) {
              const destination = path.join(dir, sandboxName);
              if (fs.existsSync(hostPath) && !fs.existsSync(destination)) {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.copyFileSync(hostPath, destination);
              }
            }

            for (const { hostDir, sandboxSubdir } of tool.hostPreSeedDirs ?? []) {
              const destination = path.join(dir, sandboxSubdir);
              if (fs.existsSync(hostDir) && !fs.existsSync(destination)) {
                fs.cpSync(hostDir, destination, { recursive: true });
              }
            }

            for (const relativePath of tool.pathRewriteFiles ?? []) {
              const filePath = path.join(dir, relativePath);
              if (!fs.existsSync(filePath)) {
                continue;
              }
              let content = fs.readFileSync(filePath, 'utf8');
              const containerHome = path.posix.dirname(tool.containerMount);
              for (const hostPath of [effectiveConfig.repoRoot, effectiveConfig.home]) {
                const replacement = hostPath === effectiveConfig.repoRoot ? '/workspace' : containerHome;
                content = content.replaceAll(hostPath, replacement);
                const posixHostPath = hostPath.replaceAll('\\', '/');
                if (posixHostPath !== hostPath) {
                  content = content.replaceAll(posixHostPath, replacement);
                }
              }
              fs.writeFileSync(filePath, content, 'utf8');
            }
          }

          return `${resolvedTools.length} tool config directories ready`;
        }
      },
      {
        title: `Starting container '${container}'`,
        task: async (message: (text: string) => void) => {
          const existing = runSafeEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
          const matchedContainers = containerNameCandidates(effectiveConfig, branch)
            .filter((name) => existing.includes(name));

          if (matchedContainers.length > 0) {
            message('Removing old container instance...');
            for (const name of matchedContainers) {
              runSafeEngine(engine, 'docker', ['stop', name]);
              runSafeEngine(engine, 'docker', ['rm', name]);
            }
          }

          const aliasesFile = ensureSandboxAliasesFile(effectiveConfig.home);
          if (aliasesFile.created) {
            message(`Created default sandbox aliases at ${aliasesFile.path}`);
          }

          const gitconfigPath = path.join(effectiveConfig.home, '.gitconfig');
          const gitconfigContent = fs.existsSync(gitconfigPath)
            ? fs.readFileSync(gitconfigPath, 'utf8')
            : '';
          const needsGpg = detectGpgConfig(gitconfigContent);
          const hasHostGpgKeys = needsGpg && hostHasGpgKeys(effectiveConfig.home);
          const signingKey = needsGpg
            ? getGitSigningKey({ repoPath: worktree, home: effectiveConfig.home })
            : null;
          const cachedGpg = needsGpg
            ? readGpgCache(
              effectiveConfig.home,
              effectiveConfig.project,
              undefined,
              signingKey
            )
            : null;
          const envFile = buildContainerEnvFile(resolvedTools, engine);
          let hostShellConfig: HostShellConfig;
          try {
            const claudeCodeEntry = resolvedTools.find(({ tool }) => tool.id === 'claude-code');
            if (claudeCodeEntry) {
              ensureClaudeOnboarding(claudeCodeEntry.dir, effectiveConfig.home);
              ensureClaudeSettings(claudeCodeEntry.dir, effectiveConfig.home);
              // Credential availability is asserted up-front in create() so we
              // know the shared credentials file already exists at this point.
            }
            const codexEntry = resolvedTools.find(({ tool }) => tool.id === 'codex');
            if (codexEntry) {
              ensureCodexModelInheritance(codexEntry.dir, effectiveConfig.home);
              ensureCodexWorkspaceTrust(codexEntry.dir);
            }
            const geminiEntry = resolvedTools.find(({ tool }) => tool.id === 'gemini-cli');
            if (geminiEntry) {
              ensureGeminiWorkspaceTrust(geminiEntry.dir);
            }
            const opencodeEntry = resolvedTools.find(({ tool }) => tool.id === 'opencode');
            if (opencodeEntry) {
              // The TUI reads <toolDir>/opencode.json via OPENCODE_CONFIG pinned in tools.js.
              ensureOpenCodeModelInheritance(opencodeEntry.dir, effectiveConfig.home);
            }
            const toolVolumes = resolvedTools.flatMap(({ tool, dir }) => [
              '-v',
              volumeArg(engine, dir, tool.containerMount)
            ]);
            const workspaceDir = path.join(effectiveConfig.repoRoot, '.agents', 'workspace');
            hostShellConfig = prepareHostShellConfig({
              home: effectiveConfig.home,
              project: effectiveConfig.project,
              branch,
              repoRoot: effectiveConfig.repoRoot
            });
            const shellConfigVolumes = hostShellConfig.mounts.flatMap(({ hostPath, containerPath }) => [
              '-v',
              volumeArg(engine, hostPath, containerPath, ':ro')
            ]);
            const liveMountVolumes = resolvedTools.flatMap(({ tool }) =>
              (tool.hostLiveMounts ?? [])
                .filter(({ hostPath }) => fs.existsSync(hostPath))
                .flatMap(({ hostPath, containerSubpath }) => [
                  '-v',
                  volumeArg(engine, hostPath, path.posix.join(tool.containerMount, containerSubpath))
                ])
            );

            fs.mkdirSync(workspaceDir, { recursive: true });
            fs.mkdirSync(shareCommon, { recursive: true });
            fs.mkdirSync(shareBranch, { recursive: true });

            const dotfilesSnapshot = materializeDotfiles(
              effectiveConfig.dotfilesDir,
              dotfilesCacheDir(effectiveConfig.home, effectiveConfig.project)
            );
            const dotfilesMount = dotfilesSnapshot
              ? buildDotfilesVolumeArgs(engine, dotfilesSnapshot.cacheDir)
              : [];

            runEngineTaskCommand(engine, 'docker', [
              'run',
              '-d',
              '--name',
              container,
              '--hostname',
              `${effectiveConfig.project}-sandbox`,
              '--label',
              sandboxLabel(effectiveConfig),
              '--label',
              `${sandboxBranchLabel(effectiveConfig)}=${branch}`,
              '-v',
              volumeArg(engine, worktree, '/workspace'),
              '-v',
              volumeArg(engine, workspaceDir, '/workspace/.agents/workspace'),
              '-v',
              volumeArg(engine, shareCommon, '/share/common'),
              '-v',
              volumeArg(engine, shareBranch, '/share/branch'),
              '-v',
              volumeArg(
                engine,
                path.join(effectiveConfig.repoRoot, '.git'),
                `${toEnginePath(engine, effectiveConfig.repoRoot)}/.git`
              ),
              '-v',
              volumeArg(engine, hostJoin(effectiveConfig.home, '.ssh'), '/home/devuser/.ssh', ':ro'),
              ...dotfilesMount,
              ...toolVolumes,
              ...liveMountVolumes,
              ...shellConfigVolumes,
              ...envFile.dockerArgs,
              '-w',
              '/workspace',
              effectiveConfig.imageName
            ]);
          } finally {
            envFile.cleanup();
          }

          // Belt-and-suspenders: re-create the four shell-config symlinks at
          // runtime so users with a custom `sandbox.dockerfile` (which won't
          // include the ai-tools.dockerfile symlink fragment) still get
          // ~/.gitconfig and friends pointing into the host bind-mount.
          // `ln -sf` is idempotent for the default image.
          ensureShellConfigSymlinks(engine, container);

          if (needsGpg) {
            message(
              cachedGpg
                ? 'Syncing GPG keys from cache...'
                : hasHostGpgKeys
                  ? 'Syncing GPG keys (you may be prompted for your passphrase)...'
                  : 'Checking GPG cache before falling back to stripped git config...'
            );
            try {
              if (syncGpgKeys(
                container,
                effectiveConfig.home,
                effectiveConfig.project,
                undefined,
                undefined,
                {
                  cachedOverride: cachedGpg,
                  repoPath: worktree,
                  signingKey,
                  dockerExecFn: (cmd: string, args: string[], opts?: ExecSyncOptions) => execEngine(engine, cmd, args, opts),
                  dockerRunSafeFn: (cmd: string, args: string[], opts?: { cwd?: string }) => runSafeEngine(engine, cmd, args, opts)
                }
              )) {
                writeSanitizedGitconfig({
                  home: effectiveConfig.home,
                  hostConfigDir: hostShellConfig.hostDir,
                  stripGpg: false,
                  repoRoot: effectiveConfig.repoRoot
                });
              } else {
                message(
                  hasHostGpgKeys
                    ? 'GPG key sync failed; using stripped git config fallback...'
                    : 'Host GPG keys unavailable; using stripped git config fallback...'
                );
              }
            } catch {
              message(
                hasHostGpgKeys
                  ? 'GPG key sync failed; using stripped git config fallback...'
                  : 'Host GPG keys unavailable; using stripped git config fallback...'
              );
            }
          }

          for (const { tool } of resolvedTools) {
            for (const command of tool.postSetupCmds ?? []) {
              runSafeEngine(engine, 'docker', ['exec', container, 'bash', '-lc', command]);
            }
          }

          return 'Container started';
        }
      }
    ]);
  } finally {
    preparedDockerfile.cleanup();
  }

  p.log.step('Verifying setup...');
  const runningContainers = runSafeEngine(engine, 'docker', ['ps', '--format', '{{.Names}}']).split('\n');
  const checks = [
    { name: 'Container running', ok: runningContainers.includes(container) },
    ...runtimeChecks(effectiveConfig.runtimes).map((check) => ({
      name: check.name,
      ok: runOkEngine(engine, 'docker', ['exec', container, ...check.cmd])
    })),
    { name: 'GitHub CLI', ok: runOkEngine(engine, 'docker', ['exec', container, 'gh', '--version']) }
  ];
  const toolChecks = tools.map((tool) => ({
    name: tool.name,
    ok: runOkEngine(engine, 'docker', ['exec', container, 'bash', '-lc', tool.versionCmd]),
    hint: tool.setupHint
  }));

  for (const check of checks) {
    p.log.info(`  ${check.ok ? pc.green('✓') : pc.yellow('?')} ${check.name}`);
  }
  for (const check of toolChecks) {
    p.log.info(`  ${check.ok ? pc.green('✓') : pc.yellow('?')} ${check.name}`);
    if (!check.ok) {
      p.log.warn(`    ${check.hint}`);
    }
  }

  p.outro(pc.green('Sandbox ready'));

  const toolHints = resolvedTools.map(({ tool, dir }) => {
    const hasLiveMount = (tool.hostLiveMounts ?? []).some(({ hostPath }) => fs.existsSync(hostPath));
    const hint = hasLiveMount
      ? 'Live-mounted auth/config files stay in sync with the host.'
      : tool.setupHint;
    return `${tool.name}: ${hint} Config dir: ${dir}`;
  }).join('\n');

  process.stdout.write(`
Container: ${container}
Image: ${effectiveConfig.imageName}
Worktree: ${worktree}
Host aliases: ${sandboxAliasesPath(effectiveConfig.home)}
Share (common): ${shareCommon} -> /share/common
Share (branch): ${shareBranch} -> /share/branch

Management:
  ai sandbox ls
  ai sandbox exec ${branch}
  ai sandbox rm ${branch}

Sandbox aliases:
  Edit the host aliases file to customize shortcuts exposed at ${CONTAINER_HOME}/.bash_aliases inside the sandbox container.

Tool notes:
${toolHints}
`);
}
