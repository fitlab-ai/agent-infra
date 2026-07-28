import fs from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import pc from 'picocolors';
import { normalizeAgentClients } from '../agent-clients/config.ts';
import { AGENT_CLIENT_IDS, isAgentClientId } from '../agent-clients/types.ts';
import type { AgentClientState } from '../agent-clients/types.ts';
import { validateSandboxEngine } from './engine.ts';
import { hostJoin } from './engines/wsl2-paths.ts';
import { findRuntimeEngineMismatches } from './runtime-engines.ts';
import { parseCustomTools } from './tools.ts';
import type { SandboxTool } from './tools.ts';

const DEFAULTS = Object.freeze({
  engine: null,
  runtimes: ['node22'],
  tools: ['agent-infra', ...AGENT_CLIENT_IDS],
  refreshIntervalDays: 7,
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
  customTools?: unknown;
  refreshIntervalDays?: unknown;
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
  shellConfigBase: string;
  dotfilesDir: string;
  engine: string | null;
  runtimes: string[];
  tools: string[];
  customTools: SandboxTool[];
  agentClientState: AgentClientState;
  agentClientSource: 'canonical' | 'legacy';
  refreshIntervalDays: number;
  dockerfile: string | null;
  vm: SandboxVmConfig;
};

type AircConfig = {
  project?: unknown;
  org?: unknown;
  agentClients?: unknown;
  tuis?: unknown;
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

function asNonNegativeIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function cloneDefaults(): SandboxConfigInput & { vm: SandboxVmConfig; runtimes: string[]; tools: string[]; refreshIntervalDays: number } {
  return {
    engine: DEFAULTS.engine,
    runtimes: [...DEFAULTS.runtimes],
    tools: [...DEFAULTS.tools],
    refreshIntervalDays: DEFAULTS.refreshIntervalDays,
    dockerfile: DEFAULTS.dockerfile,
    vm: { ...DEFAULTS.vm }
  };
}

function resolveSandboxToolIds(
  sandbox: SandboxConfigInput,
  agentClients: ReturnType<typeof normalizeAgentClients>,
  defaults: readonly string[]
): string[] {
  if (Array.isArray(sandbox.tools)) {
    const tools = sandbox.tools.filter((tool): tool is string => typeof tool === 'string');
    return agentClients.source === 'canonical'
      ? tools.filter((tool) => !isAgentClientId(tool))
      : tools;
  }
  if (agentClients.remainingSandboxTools !== undefined) {
    return [...agentClients.remainingSandboxTools];
  }
  return [...defaults];
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
  const sandboxInput = airc.sandbox;
  const hasCanonicalAgentClients = Object.prototype.hasOwnProperty.call(airc, 'agentClients');
  const normalizationInput = hasCanonicalAgentClients && sandboxInput
    ? {
        ...airc,
        sandbox: Object.fromEntries(
          Object.entries(sandboxInput).filter(([key]) => key !== 'tools')
        )
      }
    : airc;
  const agentClients = normalizeAgentClients(normalizationInput);
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

  const customTools = parseCustomTools(sandbox.customTools, { home });
  const tools = resolveSandboxToolIds(sandbox, agentClients, defaults.tools);

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
    shellConfigBase: hostJoin(home, '.agent-infra', 'config', project),
    dotfilesDir: hostJoin(home, '.agent-infra', 'dotfiles'),
    engine,
    runtimes,
    tools,
    customTools,
    agentClientState: agentClients.state,
    agentClientSource: agentClients.source,
    refreshIntervalDays: asNonNegativeIntegerOrDefault(
      sandbox.refreshIntervalDays,
      defaults.refreshIntervalDays
    ),
    dockerfile,
    vm: {
      cpu: asPositiveNumberOrNull(sandbox.vm?.cpu) ?? defaults.vm.cpu,
      memory: asPositiveNumberOrNull(sandbox.vm?.memory) ?? defaults.vm.memory,
      disk: asPositiveNumberOrNull(sandbox.vm?.disk) ?? defaults.vm.disk
    }
  };
}
