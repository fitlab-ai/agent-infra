import fs from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateSandboxEngine } from './engine.ts';
import { hostJoin } from './engines/wsl2-paths.ts';

const DEFAULTS = Object.freeze({
  engine: null,
  runtimes: ['node20'],
  tools: ['claude-code', 'codex', 'opencode', 'gemini-cli'],
  dockerfile: null,
  vm: {
    cpu: null,
    memory: null,
    disk: null
  }
});

type PlatformFn = typeof platform;

type SandboxConfigInput = {
  engine?: string | null;
  runtimes?: string[];
  tools?: string[];
  dockerfile?: string | null;
  vm?: Record<string, unknown>;
};

type AircConfig = {
  project?: unknown;
  org?: unknown;
  sandbox?: SandboxConfigInput;
};

function detectRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    throw new Error('sandbox: current directory is not inside a git repository');
  }
}

function cloneDefaults() {
  return {
    engine: DEFAULTS.engine,
    runtimes: [...DEFAULTS.runtimes],
    tools: [...DEFAULTS.tools],
    dockerfile: DEFAULTS.dockerfile,
    vm: { ...DEFAULTS.vm }
  };
}

export function loadConfig({ platformFn = platform }: { platformFn?: PlatformFn } = {}) {
  const repoRoot = detectRepoRoot();
  const home = homedir();

  if (!home) {
    throw new Error('sandbox: home directory is required');
  }

  const configPath = path.join(repoRoot, '.agents', '.airc.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('No .agents/.airc.json found. Run "ai init" first.');
  }

  const airc = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AircConfig;
  const defaults = cloneDefaults();
  const sandbox = airc.sandbox ?? {};
  const engine = validateSandboxEngine(sandbox.engine ?? defaults.engine, { platformFn });
  const project = airc.project;

  if (!project || typeof project !== 'string') {
    throw new Error('sandbox: .agents/.airc.json is missing a valid "project" field');
  }

  return {
    repoRoot,
    configPath,
    project,
    org: typeof airc.org === 'string' ? airc.org : '',
    home,
    containerPrefix: `${project}-dev`,
    imageName: `${project}-sandbox:latest`,
    worktreeBase: hostJoin(home, '.agent-infra', 'worktrees', project),
    shareBase: hostJoin(home, '.agent-infra', 'share', project),
    dotfilesDir: hostJoin(home, '.agent-infra', 'dotfiles'),
    engine,
    runtimes: Array.isArray(sandbox.runtimes) && sandbox.runtimes.length > 0
      ? [...sandbox.runtimes]
      : defaults.runtimes,
    tools: Array.isArray(sandbox.tools) && sandbox.tools.length > 0
      ? [...sandbox.tools]
      : defaults.tools,
    dockerfile: sandbox.dockerfile ?? defaults.dockerfile,
    vm: {
      ...defaults.vm,
      ...(sandbox.vm ?? {})
    }
  };
}
