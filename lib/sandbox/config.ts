import fs from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import pc from 'picocolors';
import { validateSandboxEngine } from './engine.ts';
import { hostJoin } from './engines/wsl2-paths.ts';
import { findRuntimeEngineMismatches } from './runtime-engines.ts';

const DEFAULTS = Object.freeze({
  engine: null,
  runtimes: ['node22'],
  tools: ['claude-code', 'codex', 'gemini-cli', 'opencode'],
  dockerfile: null,
  vm: {
    cpu: null,
    memory: null,
    disk: null
  }
});

type PlatformFn = typeof platform;
type WriteStderr = (chunk: string) => unknown;

type SandboxConfigInput = {
  engine?: string | null;
  runtimes?: string[];
  tools?: string[];
  dockerfile?: string | null;
  vm?: Record<string, unknown>;
};

type SandboxVmConfig = {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
};

export type SandboxConfig = {
  repoRoot: string;
  configPath: string;
  project: string;
  org: string;
  home: string;
  containerPrefix: string;
  imageName: string;
  worktreeBase: string;
  shareBase: string;
  dotfilesDir: string;
  engine: string | null;
  runtimes: string[];
  tools: string[];
  dockerfile: string | null;
  vm: SandboxVmConfig;
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

function asPositiveNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function cloneDefaults(): SandboxConfigInput & { vm: SandboxVmConfig; runtimes: string[]; tools: string[] } {
  return {
    engine: DEFAULTS.engine,
    runtimes: [...DEFAULTS.runtimes],
    tools: [...DEFAULTS.tools],
    dockerfile: DEFAULTS.dockerfile,
    vm: { ...DEFAULTS.vm }
  };
}

export function loadConfig({
  platformFn = platform,
  writeStderr = (chunk) => process.stderr.write(chunk)
}: { platformFn?: PlatformFn; writeStderr?: WriteStderr } = {}): SandboxConfig {
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

  const runtimes = Array.isArray(sandbox.runtimes) && sandbox.runtimes.length > 0
    ? [...sandbox.runtimes]
    : defaults.runtimes;
  const dockerfile = typeof sandbox.dockerfile === 'string' ? sandbox.dockerfile : defaults.dockerfile ?? null;

  if (!dockerfile) {
    let enginesNode: string | undefined;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        engines?: { node?: unknown };
      };
      enginesNode = typeof pkg.engines?.node === 'string' ? pkg.engines.node : undefined;
    } catch {
      enginesNode = undefined;
    }

    for (const { runtimes: invalidRuntimes, enginesNode: range } of findRuntimeEngineMismatches(runtimes, enginesNode)) {
      writeStderr(pc.yellow(
        `Warning: sandbox runtimes ${invalidRuntimes.map((runtime) => `"${runtime}"`).join(', ')} do not satisfy this project's package.json "engines.node" ("${range}").\n` +
        '  Update "sandbox.runtimes" in .agents/.airc.json (e.g. "node22"), or relax "engines.node".\n'
      ));
    }
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
    runtimes,
    tools: Array.isArray(sandbox.tools) && sandbox.tools.length > 0
      ? [...sandbox.tools]
      : defaults.tools,
    dockerfile,
    vm: {
      cpu: asPositiveNumberOrNull(sandbox.vm?.cpu) ?? defaults.vm.cpu,
      memory: asPositiveNumberOrNull(sandbox.vm?.memory) ?? defaults.vm.memory,
      disk: asPositiveNumberOrNull(sandbox.vm?.disk) ?? defaults.vm.disk
    }
  };
}
