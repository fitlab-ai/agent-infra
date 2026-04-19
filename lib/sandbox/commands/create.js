import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import {
  assertValidBranchName,
  containerName,
  containerNameCandidates,
  parsePositiveIntegerOption,
  sandboxBranchLabel,
  sandboxImageConfigLabel,
  sandboxLabel,
  sanitizeBranchName,
  worktreeDirCandidates
} from '../constants.js';
import { prepareDockerfile } from '../dockerfile.js';
import { ensureDocker } from '../engine.js';
import { run, runOk, runSafe, runVerbose } from '../shell.js';
import { resolveTaskBranch } from '../task-resolver.js';
import { resolveTools, toolConfigDirCandidates, toolNpmPackagesArg } from '../tools.js';

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
const USAGE = `Usage: ai sandbox create <branch> [base] [--cpu <n>] [--memory <n>]

Host aliases:
  ${'~'}/.agent-infra/aliases/sandbox.sh is auto-created on first run and mounted at
  ${CONTAINER_HOME}/.bash_aliases inside the sandbox container.`;

function buildSignature(preparedDockerfile, tools) {
  return createHash('sha256')
    .update(JSON.stringify({
      dockerfile: preparedDockerfile.signature,
      tools: tools.map((tool) => tool.npmPackage)
    }))
    .digest('hex')
    .slice(0, 12);
}

function hostJoin(basePath, ...segments) {
  return basePath.startsWith('/') ? path.posix.join(basePath, ...segments) : path.join(basePath, ...segments);
}

function resolveToolDirs(config, tools, branch) {
  return tools.map((tool) => {
    const candidates = toolConfigDirCandidates(tool, config.project, branch);
    return {
      tool,
      dir: candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
    };
  });
}

export function hostShellConfigDir(home, project, branch) {
  return path.join(home, '.agent-infra', 'config', project, sanitizeBranchName(branch));
}

function runtimeChecks(runtimes) {
  const checks = [];
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

export function detectGpgConfig(gitconfig) {
  return /\bgpgsign\s*=\s*true\b/i.test(gitconfig) || /^\s*\[gpg(?:\s|"|\])/im.test(gitconfig);
}

function appendSafeDirectories(lines, repoRoot) {
  if (!repoRoot) {
    return lines;
  }

  const requiredDirectories = ['/workspace', repoRoot];
  const existingDirectories = new Set();
  let firstSafeSectionIndex = -1;
  let inSafeSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSafeSection = sectionMatch[1].trim().toLowerCase() === 'safe';
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
      existingDirectories.add(directoryMatch[1].trim());
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
    if (/^\s*\[([^\]]+)\]\s*$/.test(updatedLines[index])) {
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

export function sanitizeGitConfig(gitconfig, home, { stripGpg = false, repoRoot = '' } = {}) {
  const lines = gitconfig
    .replaceAll(home, CONTAINER_HOME)
    .replace(/\[difftool "sourcetree"\][^\[]*/gs, '')
    .replace(/\[mergetool "sourcetree"\][^\[]*/gs, '')
    .split(/\r?\n/);

  const sanitized = [];
  let inGpgSection = false;
  let currentSection = '';

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim();
      currentSection = (sectionName.match(/^([^\s"]+)/)?.[1] ?? '').toLowerCase();
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

export function hostHasGpgKeys(home, execFn = execFileSync) {
  return currentKeyringFingerprint(home, execFn) !== null;
}

export function writeSanitizedGitconfig({ home, hostConfigDir, stripGpg, repoRoot }) {
  const gitconfigPath = path.join(home, '.gitconfig');
  if (!fs.existsSync(gitconfigPath)) {
    return null;
  }

  fs.mkdirSync(hostConfigDir, { recursive: true });
  const targetPath = path.join(hostConfigDir, '.gitconfig');
  const gitconfig = sanitizeGitConfig(fs.readFileSync(gitconfigPath, 'utf8'), home, {
    stripGpg,
    repoRoot
  });
  fs.writeFileSync(targetPath, gitconfig, 'utf8');
  return targetPath;
}

export function prepareHostShellConfig({ home, project, branch, repoRoot }) {
  const hostDir = hostShellConfigDir(home, project, branch);
  fs.rmSync(hostDir, { recursive: true, force: true });
  fs.mkdirSync(hostDir, { recursive: true });

  /** @type {Array<{ hostPath: string, containerPath: string }>} */
  const mounts = [];
  const gitconfigPath = writeSanitizedGitconfig({
    home,
    hostConfigDir: hostDir,
    stripGpg: true,
    repoRoot
  });
  if (gitconfigPath) {
    mounts.push({ hostPath: gitconfigPath, containerPath: `${CONTAINER_HOME}/.gitconfig` });
  }

  for (const file of ['.gitignore_global', '.stCommitMsg']) {
    const hostPath = path.join(home, file);
    if (!fs.existsSync(hostPath)) {
      continue;
    }

    const targetPath = path.join(hostDir, file);
    fs.copyFileSync(hostPath, targetPath);
    mounts.push({ hostPath: targetPath, containerPath: `${CONTAINER_HOME}/${file}` });
  }

  const aliasesPath = sandboxAliasesPath(home);
  if (fs.existsSync(aliasesPath)) {
    const targetPath = path.join(hostDir, '.bash_aliases');
    fs.copyFileSync(aliasesPath, targetPath);
    mounts.push({ hostPath: targetPath, containerPath: `${CONTAINER_HOME}/.bash_aliases` });
  }

  return { hostDir, mounts };
}

function gpgCacheDir(home, project) {
  return hostJoin(home, '.agent-infra', 'gpg-cache', project);
}

function normalizeSigningKey(signingKey) {
  if (typeof signingKey !== 'string') {
    return null;
  }

  const trimmed = signingKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorktreePath(worktreePath) {
  if (!worktreePath) {
    return '';
  }

  try {
    return fs.existsSync(worktreePath) ? fs.realpathSync(worktreePath) : path.resolve(worktreePath);
  } catch {
    return path.resolve(worktreePath);
  }
}

export function getGitSigningKey({ home, repoPath = null, execFn = execFileSync } = {}) {
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
    return normalizeSigningKey(output);
  } catch {
    return null;
  }
}

export function currentKeyringFingerprint(home, execFn = execFileSync) {
  const hostEnv = { ...process.env, HOME: home };
  try {
    const keyring = execFn('gpg', ['--list-secret-keys', '--with-colons'], {
      encoding: 'utf8',
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!keyring || keyring.trim().length === 0) {
      return null;
    }
    return createHash('sha256').update(keyring).digest('hex');
  } catch {
    return null;
  }
}

export function readGpgCache(home, project, execFn = execFileSync, signingKey = null) {
  const cacheDir = gpgCacheDir(home, project);
  const pubPath = path.join(cacheDir, 'public.asc');
  const secPath = path.join(cacheDir, 'secret.asc');
  const statePath = path.join(cacheDir, 'state.json');

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
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

export function writeGpgCache(home, project, pub, sec, fingerprint, signingKey = null) {
  if (!fingerprint) {
    return false;
  }

  const cacheDir = gpgCacheDir(home, project);
  const pubPath = path.join(cacheDir, 'public.asc');
  const secPath = path.join(cacheDir, 'secret.asc');
  const statePath = path.join(cacheDir, 'state.json');

  try {
    const state = { fingerprint };
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
  container,
  home,
  project,
  execFn = execFileSync,
  runSafeFn = runSafe,
  options = {}
) {
  const {
    cachedOverride = null,
    repoPath = null,
    signingKey: signingKeyOverride
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

    pubKeys = execFn('gpg', exportArgs, {
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!pubKeys || pubKeys.length === 0) {
      return false;
    }

    secKeys = execFn('gpg', exportSecretArgs, {
      env: hostEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
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

  execFn('docker', ['exec', '-i', container, 'gpg', '--import'], {
    input: pubKeys,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  execFn('docker', ['exec', '-i', container, 'gpg', '--batch', '--import'], {
    input: secKeys,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  runSafeFn('docker', ['exec', container, 'gpgconf', '--launch', 'gpg-agent']);
  return true;
}

export function buildContainerEnvArgs(resolvedTools, runSafeCommand = runSafe) {
  const envArgs = resolvedTools.flatMap(({ tool }) =>
    Object.entries(tool.envVars ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  );
  const ghToken = runSafeCommand('gh', ['auth', 'token']);
  if (ghToken) {
    envArgs.push('-e', `GH_TOKEN=${ghToken}`);
  }
  return envArgs;
}

export function assertBranchAvailable(
  repoRoot,
  branch,
  { allowedWorktrees = [], runFn = runSafe } = {}
) {
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

export function ensureClaudeOnboarding(toolDir) {
  const claudeJsonPath = path.join(toolDir, '.claude.json');
  let data = {};
  if (fs.existsSync(claudeJsonPath)) {
    try {
      data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
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
  if (changed) {
    fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 4), 'utf8');
  }
}

export function ensureClaudeSettings(toolDir) {
  const settingsPath = path.join(toolDir, 'settings.json');
  let data = {};
  if (fs.existsSync(settingsPath)) {
    try {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      // malformed JSON, start fresh
    }
  }
  if (data.skipDangerousModePermissionPrompt !== true) {
    data.skipDangerousModePermissionPrompt = true;
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 4), 'utf8');
  }
}

export function ensureCodexWorkspaceTrust(toolDir) {
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

export function ensureGeminiWorkspaceTrust(toolDir) {
  const trustPath = path.join(toolDir, 'trustedFolders.json');
  let data = {};
  if (fs.existsSync(trustPath)) {
    try {
      data = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
    } catch {
      // malformed JSON, start fresh
    }
  }
  if (data['/workspace'] !== 'TRUST_FOLDER') {
    data['/workspace'] = 'TRUST_FOLDER';
    fs.writeFileSync(trustPath, JSON.stringify(data, null, 2), 'utf8');
  }
}

export function extractClaudeCredentialsBlob(home, execFn = execFileSync) {
  if (process.platform === 'darwin') {
    try {
      const keychainAccount = path.basename(home);
      const credentials = execFn('security', [
        'find-generic-password',
        '-a',
        keychainAccount,
        '-s',
        'Claude Code-credentials',
        '-w'
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const trimmed = typeof credentials === 'string' ? credentials.trim() : '';
      if (!trimmed) {
        return null;
      }

      const parsed = JSON.parse(trimmed);
      const payload = parsed?.claudeAiOauth ?? parsed;
      const scopes = Array.isArray(payload?.scopes) ? payload.scopes : [];
      const hasRequiredScopes = scopes.includes('user:profile')
        && scopes.includes('user:sessions:claude_code');
      if (!payload?.accessToken || !payload?.refreshToken || !hasRequiredScopes) {
        return null;
      }
      return trimmed;
    } catch {
      return null;
    }
  }

  const credentialsPath = path.join(home, '.claude', '.credentials.json');
  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(credentialsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const payload = parsed?.claudeAiOauth ?? parsed;
    const scopes = Array.isArray(payload?.scopes) ? payload.scopes : [];
    const hasRequiredScopes = scopes.includes('user:profile')
      && scopes.includes('user:sessions:claude_code');
    if (!payload?.accessToken || !payload?.refreshToken || !hasRequiredScopes) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function claudeCredentialsDir(home, project) {
  return hostJoin(home, '.agent-infra', 'credentials', project, 'claude-code');
}

export function claudeCredentialsPath(home, project) {
  return hostJoin(claudeCredentialsDir(home, project), '.credentials.json');
}

export function writeClaudeCredentialsFile(home, project, blob) {
  const dir = claudeCredentialsDir(home, project);
  const filePath = claudeCredentialsPath(home, project);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(filePath, blob, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function assertClaudeCredentialsAvailable(
  home,
  project,
  resolvedTools,
  extractFn = extractClaudeCredentialsBlob,
  writeFn = writeClaudeCredentialsFile
) {
  const claudeCodeEntry = resolvedTools.find(({ tool }) => tool.id === 'claude-code');
  if (!claudeCodeEntry) {
    return;
  }

  const blob = extractFn(home);
  if (!blob) {
    throw new Error([
      'Claude Code credentials not found on host.',
      '',
      'The sandbox needs your Claude Code OAuth credentials so the container can use Claude Code.',
      '',
      'To fix:',
      '  1. On the host, run "claude" once and complete the OAuth login flow.',
      '  2. Verify with "claude /status" that you see your subscription.',
      '  3. Re-run "ai sandbox create".',
      '',
      'Alternatively, if you do not need Claude Code in this sandbox,',
      'remove "claude-code" from the "sandbox.tools" array in .agents/.airc.json.'
    ].join('\n'));
  }

  writeFn(home, project, blob);
}

export function sandboxAliasesPath(home) {
  return path.join(home, '.agent-infra', 'aliases', 'sandbox.sh');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripManagedSandboxAliasBlocks(content) {
  const blockPattern = new RegExp(
    `${escapeRegExp(SANDBOX_ALIAS_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(SANDBOX_ALIAS_BLOCK_END)}\\n?`,
    'g'
  );
  return content.replace(blockPattern, '').trimEnd();
}

function isLegacyManagedSandboxAliasFile(content) {
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

export function ensureSandboxAliasesFile(home) {
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

export function commandErrorMessage(error) {
  const stderr = error?.stderr?.toString().trim();
  return stderr || error?.message || 'Command failed';
}

function runTaskCommand(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts);
  } catch (error) {
    throw new Error(commandErrorMessage(error));
  }
}

export function buildImage(
  config,
  tools,
  dockerfilePath,
  imageSignature,
  { runFn = run, runVerboseFn = runVerbose } = {}
) {
  const hostUid = runFn('id', ['-u']);
  const hostGid = runFn('id', ['-g']);

  runVerboseFn('docker', [
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
    dockerfilePath,
    config.repoRoot
  ], { cwd: config.repoRoot });
}

export async function create(args) {
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

  const config = loadConfig();
  const [branchOrTaskId, base] = positionals;
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
  const worktree = worktreeCandidates.find((candidate) => fs.existsSync(candidate)) ?? worktreeCandidates[0];
  const preparedDockerfile = prepareDockerfile(effectiveConfig);
  const baseBranch = base ?? runSafe('git', ['-C', effectiveConfig.repoRoot, 'branch', '--show-current']);
  const expectedImageSignature = buildSignature(preparedDockerfile, tools);

  p.intro(pc.cyan('AI Sandbox'));
  p.log.info(
    `Project: ${pc.bold(effectiveConfig.project)} | Branch: ${pc.bold(branch)} | Base: ${pc.bold(baseBranch || 'HEAD')}`
  );

  try {
    p.log.step('Checking container engine...');
    await ensureDocker(effectiveConfig, (detail) => {
      p.log.info(`  ${detail}`);
    });
    p.log.success('Docker is ready');

    const imageExists = runOk('docker', ['image', 'inspect', effectiveConfig.imageName]);
    const currentImageSignature = imageExists
      ? runSafe('docker', [
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
        expectedImageSignature
      );
      p.log.success(imageExists ? 'Image rebuilt' : 'Image built');
    } else {
      p.log.step(`Using existing image ${effectiveConfig.imageName}`);
    }

    await p.tasks([
      {
        title: 'Setting up git worktree',
        task: async (message) => {
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
            runTaskCommand('git', ['-C', effectiveConfig.repoRoot, 'worktree', 'add', worktree, branch]);
          } else {
            message(`Creating branch '${branch}' from '${baseBranch}'...`);
            runTaskCommand('git', ['-C', effectiveConfig.repoRoot, 'worktree', 'add', '-b', branch, worktree, baseBranch]);
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
              content = content.replaceAll(effectiveConfig.repoRoot, '/workspace');
              content = content.replaceAll(effectiveConfig.home, path.dirname(tool.containerMount));
              fs.writeFileSync(filePath, content, 'utf8');
            }
          }

          return `${resolvedTools.length} tool config directories ready`;
        }
      },
      {
        title: `Starting container '${container}'`,
        task: async (message) => {
          const existing = runSafe('docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
          const matchedContainers = containerNameCandidates(effectiveConfig, branch)
            .filter((name) => existing.includes(name));

          if (matchedContainers.length > 0) {
            message('Removing old container instance...');
            for (const name of matchedContainers) {
              runSafe('docker', ['stop', name]);
              runSafe('docker', ['rm', name]);
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
          const envArgs = buildContainerEnvArgs(resolvedTools);
          const claudeCodeEntry = resolvedTools.find(({ tool }) => tool.id === 'claude-code');
          if (claudeCodeEntry) {
            ensureClaudeOnboarding(claudeCodeEntry.dir);
            ensureClaudeSettings(claudeCodeEntry.dir);
            // Credential availability is asserted up-front in create() so we
            // know the shared credentials file already exists at this point.
          }
          const codexEntry = resolvedTools.find(({ tool }) => tool.id === 'codex');
          if (codexEntry) {
            ensureCodexWorkspaceTrust(codexEntry.dir);
          }
          const geminiEntry = resolvedTools.find(({ tool }) => tool.id === 'gemini-cli');
          if (geminiEntry) {
            ensureGeminiWorkspaceTrust(geminiEntry.dir);
          }
          // OpenCode has no workspace trust mechanism, so no preseed step is needed.
          const toolVolumes = resolvedTools.flatMap(({ tool, dir }) => ['-v', `${dir}:${tool.containerMount}`]);
          const workspaceDir = path.join(effectiveConfig.repoRoot, '.agents', 'workspace');
          const hostShellConfig = prepareHostShellConfig({
            home: effectiveConfig.home,
            project: effectiveConfig.project,
            branch,
            repoRoot: effectiveConfig.repoRoot
          });
          const shellConfigVolumes = hostShellConfig.mounts.flatMap(({ hostPath, containerPath }) => [
            '-v',
            `${hostPath}:${containerPath}:ro`
          ]);
          const liveMountVolumes = resolvedTools.flatMap(({ tool }) =>
            (tool.hostLiveMounts ?? [])
              .filter(({ hostPath }) => fs.existsSync(hostPath))
              .flatMap(({ hostPath, containerSubpath }) => [
                '-v',
                `${hostPath}:${path.join(tool.containerMount, containerSubpath)}`
              ])
          );

          fs.mkdirSync(workspaceDir, { recursive: true });

          runTaskCommand('docker', [
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
            `${worktree}:/workspace`,
            '-v',
            `${workspaceDir}:/workspace/.agents/workspace`,
            '-v',
            `${effectiveConfig.repoRoot}/.git:${effectiveConfig.repoRoot}/.git`,
            '-v',
            `${path.join(effectiveConfig.home, '.ssh')}:/home/devuser/.ssh:ro`,
            ...toolVolumes,
            ...liveMountVolumes,
            ...shellConfigVolumes,
            ...envArgs,
            '-w',
            '/workspace',
            effectiveConfig.imageName
          ]);

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
                  signingKey
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
              runSafe('docker', ['exec', container, 'bash', '-lc', command]);
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
  const runningContainers = runSafe('docker', ['ps', '--format', '{{.Names}}']).split('\n');
  const checks = [
    { name: 'Container running', ok: runningContainers.includes(container) },
    ...runtimeChecks(effectiveConfig.runtimes).map((check) => ({
      name: check.name,
      ok: runOk('docker', ['exec', container, ...check.cmd])
    })),
    { name: 'GitHub CLI', ok: runOk('docker', ['exec', container, 'gh', '--version']) }
  ];
  const toolChecks = tools.map((tool) => ({
    name: tool.name,
    ok: runOk('docker', ['exec', container, 'bash', '-lc', tool.versionCmd]),
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

Management:
  ai sandbox ls
  ai sandbox exec ${branch}
  ai sandbox rm ${branch}

Sandbox aliases:
  Edit the host aliases file to customize shortcuts mounted at ${CONTAINER_HOME}/.bash_aliases.

Tool notes:
${toolHints}
`);
}
