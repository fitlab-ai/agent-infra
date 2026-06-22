import { safeNameCandidates, sanitizeBranchName } from './constants.ts';
import { hostJoin } from './engines/wsl2-paths.ts';

export type SandboxToolInstall =
  | { type: 'npm'; cmd: string }
  | { type: 'shell'; cmd: string };

export type SandboxTool = {
  id: string;
  name: string;
  install: SandboxToolInstall;
  sandboxBase: string;
  containerMount: string;
  versionCmd: string;
  setupHint: string;
  envVars?: Record<string, string>;
  hostPreSeedFiles?: Array<{ hostPath: string; sandboxName: string }>;
  hostPreSeedDirs?: Array<{ hostDir: string; sandboxSubdir: string }>;
  pathRewriteFiles?: string[];
  hostLiveMounts?: Array<{ hostPath: string; containerSubpath: string }>;
  postSetupCmds?: string[];
  // When set, containerMount is mounted as an in-container tmpfs (RAM) instead
  // of bind-mounting the host config dir, keeping high-churn tool logs off the
  // host disk. `seed` lists the host-dir entries (relative to the tool's config
  // dir) to bind back over the tmpfs so seeded config stays visible — it is an
  // explicit allowlist so runtime files (e.g. logs_2.sqlite, sessions) left in
  // the host dir are NOT re-mounted, which would defeat the tmpfs.
  tmpfs?: { size?: string; seed?: string[] };
};

type ToolsConfig = {
  home: string;
  project: string;
  tools: string[];
  customTools?: SandboxTool[];
};

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function createBuiltinTools(home: string, project: string): Record<string, SandboxTool> {
  return {
    'claude-code': {
      id: 'claude-code',
      name: 'Claude Code',
      install: { type: 'npm', cmd: '@anthropic-ai/claude-code@latest' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'claude-code'),
      containerMount: '/home/devuser/.claude',
      versionCmd: 'claude --version',
      setupHint: 'Authenticates via host credentials live-mounted at ~/.claude/.credentials.json',
      // Claude Code stores user data (.claude.json — onboarding state, theme,
      // workspace trust) at $HOME/.claude.json by default, which sits OUTSIDE
      // the bind-mounted /home/devuser/.claude tree, so our preseeded
      // .claude.json never gets read and the theme picker re-runs on every
      // container start. Pinning CLAUDE_CONFIG_DIR to the tool mount relocates
      // .claude.json into the same directory as .credentials.json/settings.json,
      // letting ensureClaudeOnboarding actually take effect.
      envVars: { CLAUDE_CONFIG_DIR: '/home/devuser/.claude' },
      hostPreSeedDirs: [
        { hostDir: hostJoin(home, '.claude', 'plugins'), sandboxSubdir: 'plugins' }
      ],
      pathRewriteFiles: [
        'plugins/installed_plugins.json',
        'plugins/known_marketplaces.json'
      ],
      hostLiveMounts: [
        {
          hostPath: hostJoin(home, '.agent-infra', 'credentials', project, 'claude-code', '.credentials.json'),
          containerSubpath: '.credentials.json'
        }
      ]
    },
    codex: {
      id: 'codex',
      name: 'Codex',
      install: { type: 'npm', cmd: '@openai/codex' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'codex'),
      containerMount: '/home/devuser/.codex',
      versionCmd: 'codex --version',
      setupHint: 'Run codex once inside the container and choose Device Code login if needed.',
      // codex churns ~/.codex/logs_2.sqlite heavily (upstream openai/codex#24275);
      // a bind-mount would write-amplify onto the host SSD via virtiofs. Mount the
      // codex home as tmpfs so those logs stay in RAM and die with the container.
      // Only the seeded config (config.toml, model-catalogs) is bound back over
      // the tmpfs; runtime files like logs_2.sqlite must stay in RAM.
      tmpfs: { size: '512m', seed: ['config.toml', 'model-catalogs'] },
      hostLiveMounts: [
        { hostPath: hostJoin(home, '.codex', 'auth.json'), containerSubpath: 'auth.json' }
      ],
      postSetupCmds: [
        'test -d /workspace/.codex/commands && ln -sfn /workspace/.codex/commands /home/devuser/.codex/prompts || true'
      ]
    },
    opencode: {
      id: 'opencode',
      name: 'OpenCode',
      install: { type: 'npm', cmd: 'opencode-ai' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'opencode'),
      containerMount: '/home/devuser/.local/share/opencode',
      versionCmd: 'opencode version',
      setupHint: 'Configure OpenCode credentials inside the container before first use.',
      // OpenCode reads opencode.json from $XDG_CONFIG_HOME/opencode by default,
      // outside this tool mount. Pin the config file path so the inherited
      // sandbox opencode.json is the one the TUI actually reads.
      envVars: { OPENCODE_CONFIG: '/home/devuser/.local/share/opencode/opencode.json' },
      hostLiveMounts: [
        {
          hostPath: hostJoin(home, '.local', 'share', 'opencode', 'auth.json'),
          containerSubpath: 'auth.json'
        }
      ]
    },
    'gemini-cli': {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      install: { type: 'npm', cmd: '@google/gemini-cli' },
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'gemini-cli'),
      containerMount: '/home/devuser/.gemini',
      versionCmd: 'gemini --version',
      setupHint: 'Run gemini inside the container to finish authentication.',
      hostLiveMounts: [
        { hostPath: hostJoin(home, '.gemini', 'oauth_creds.json'), containerSubpath: 'oauth_creds.json' }
      ],
      hostPreSeedFiles: [
        { hostPath: hostJoin(home, '.gemini', 'settings.json'), sandboxName: 'settings.json' },
        { hostPath: hostJoin(home, '.gemini', 'google_accounts.json'), sandboxName: 'google_accounts.json' }
      ]
    }
  };
}

export function builtinToolIds(): string[] {
  return Object.keys(createBuiltinTools('', ''));
}

function validateTool(tool: SandboxTool): void {
  if (!tool.id || !TOOL_ID_PATTERN.test(tool.id)) {
    throw new Error(`Invalid sandbox tool id: ${String(tool.id)}`);
  }
  if (!tool.install || (tool.install.type !== 'npm' && tool.install.type !== 'shell')) {
    throw new Error(`Sandbox tool ${tool.id} has invalid install.type`);
  }
  if (!tool.install.cmd) {
    throw new Error(`Sandbox tool ${tool.id} has empty install.cmd`);
  }
  if (!tool.containerMount || !tool.containerMount.startsWith('/')) {
    throw new Error(`Sandbox tool ${tool.id} containerMount must be an absolute path`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context}: field "${field}" must be a string`);
  }
  return value;
}

function asOptionalNonEmptyString(value: unknown, field: string, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${context}: field "${field}" must be a string when provided`);
  }
  if (value.length === 0) {
    throw new Error(`${context}: field "${field}" must be non-empty when provided`);
  }
  return value;
}

function asStringRecord(value: unknown, field: string, context: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${context}: field "${field}" must be an object when provided`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') {
      throw new Error(`${context}: field "${field}.${key}" must be a string`);
    }
    out[key] = val;
  }
  return out;
}

function asStringArray(value: unknown, field: string, context: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "${field}" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${context}: field "${field}[${index}]" must be a string`);
    }
    return item;
  });
}

function parseInstall(value: unknown, context: string): SandboxToolInstall {
  if (!isPlainObject(value)) {
    throw new Error(`${context}: field "install" must be an object`);
  }
  const type = value.type;
  if (type !== 'npm' && type !== 'shell') {
    throw new Error(`${context}: field "install.type" must be "npm" or "shell"`);
  }
  const cmd = asString(value.cmd, 'install.cmd', context);
  if (!cmd) {
    throw new Error(`${context}: field "install.cmd" must be non-empty`);
  }
  return { type, cmd };
}

function parseHostPreSeedFiles(value: unknown, context: string): SandboxTool['hostPreSeedFiles'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "hostPreSeedFiles" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${context}: field "hostPreSeedFiles[${index}]" must be an object`);
    }
    return {
      hostPath: asString(item.hostPath, `hostPreSeedFiles[${index}].hostPath`, context),
      sandboxName: asString(item.sandboxName, `hostPreSeedFiles[${index}].sandboxName`, context)
    };
  });
}

function parseHostPreSeedDirs(value: unknown, context: string): SandboxTool['hostPreSeedDirs'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "hostPreSeedDirs" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${context}: field "hostPreSeedDirs[${index}]" must be an object`);
    }
    return {
      hostDir: asString(item.hostDir, `hostPreSeedDirs[${index}].hostDir`, context),
      sandboxSubdir: asString(item.sandboxSubdir, `hostPreSeedDirs[${index}].sandboxSubdir`, context)
    };
  });
}

function parseHostLiveMounts(value: unknown, context: string): SandboxTool['hostLiveMounts'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "hostLiveMounts" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${context}: field "hostLiveMounts[${index}]" must be an object`);
    }
    return {
      hostPath: asString(item.hostPath, `hostLiveMounts[${index}].hostPath`, context),
      containerSubpath: asString(item.containerSubpath, `hostLiveMounts[${index}].containerSubpath`, context)
    };
  });
}

function parseTmpfs(value: unknown, context: string): SandboxTool['tmpfs'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${context}: field "tmpfs" must be an object when provided`);
  }
  return {
    size: asOptionalNonEmptyString(value.size, 'tmpfs.size', context),
    seed: asStringArray(value.seed, 'tmpfs.seed', context)
  };
}

export function parseCustomTool(
  entry: unknown,
  index: number,
  options: { home: string }
): SandboxTool {
  const context = `customTools[${index}]`;
  if (!isPlainObject(entry)) {
    throw new Error(`${context} must be an object`);
  }

  const id = asString(entry.id, 'id', context);
  if (!TOOL_ID_PATTERN.test(id)) {
    throw new Error(`${context}: field "id" must match ${TOOL_ID_PATTERN.source}`);
  }

  const containerMount = asOptionalNonEmptyString(entry.containerMount, 'containerMount', context)
    ?? `/home/devuser/.${id}`;
  if (!containerMount.startsWith('/')) {
    throw new Error(`${context}: field "containerMount" must be an absolute path`);
  }

  const tool: SandboxTool = {
    id,
    name: asOptionalNonEmptyString(entry.name, 'name', context) ?? id,
    install: parseInstall(entry.install, context),
    sandboxBase: hostJoin(options.home, '.agent-infra', 'sandboxes', id),
    containerMount,
    versionCmd: asOptionalNonEmptyString(entry.versionCmd, 'versionCmd', context) ?? `which ${id}`,
    setupHint: asOptionalNonEmptyString(entry.setupHint, 'setupHint', context)
      ?? `Run \`${id}\` inside the container to set up.`,
    envVars: asStringRecord(entry.envVars, 'envVars', context),
    hostPreSeedFiles: parseHostPreSeedFiles(entry.hostPreSeedFiles, context),
    hostPreSeedDirs: parseHostPreSeedDirs(entry.hostPreSeedDirs, context),
    pathRewriteFiles: asStringArray(entry.pathRewriteFiles, 'pathRewriteFiles', context),
    hostLiveMounts: parseHostLiveMounts(entry.hostLiveMounts, context),
    postSetupCmds: asStringArray(entry.postSetupCmds, 'postSetupCmds', context),
    tmpfs: parseTmpfs(entry.tmpfs, context)
  };

  validateTool(tool);
  return tool;
}

export function parseCustomTools(value: unknown, options: { home: string }): SandboxTool[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('sandbox: "customTools" must be an array');
  }
  return value.map((entry, index) => parseCustomTool(entry, index, options));
}

export function resolveTools(config: ToolsConfig): SandboxTool[] {
  const builtins = createBuiltinTools(config.home, config.project);
  const customs = config.customTools ?? [];

  const seen = new Set<string>();
  for (const tool of customs) {
    if (builtins[tool.id]) {
      throw new Error(`Custom sandbox tool id "${tool.id}" collides with a built-in tool`);
    }
    if (seen.has(tool.id)) {
      throw new Error(`Duplicate sandbox tool id "${tool.id}" in customTools`);
    }
    seen.add(tool.id);
  }

  const merged: Record<string, SandboxTool> = { ...builtins };
  for (const tool of customs) {
    merged[tool.id] = tool;
  }

  return config.tools.map((id) => {
    const tool = merged[id];
    if (!tool) {
      throw new Error(`Unknown sandbox tool: ${id}`);
    }
    validateTool(tool);
    return tool;
  });
}

export function toolConfigDir(tool: SandboxTool, project: string, branch: string): string {
  return hostJoin(tool.sandboxBase, project, sanitizeBranchName(branch));
}

export function toolConfigDirCandidates(tool: SandboxTool, project: string, branch: string): string[] {
  return safeNameCandidates(branch).map((name) => hostJoin(tool.sandboxBase, project, name));
}

export function toolProjectDirCandidates(tool: SandboxTool, project: string): string[] {
  return [hostJoin(tool.sandboxBase, project)];
}

export function toolNpmPackagesArg(tools: SandboxTool[]): string {
  return tools
    .filter((tool) => tool.install.type === 'npm')
    .map((tool) => tool.install.cmd)
    .join(' ');
}

export function toolShellInstallScript(tools: SandboxTool[]): string {
  const blocks = tools
    .filter((tool) => tool.install.type === 'shell')
    .map((tool) => `# install: ${tool.id}\n${tool.install.cmd}`);

  if (blocks.length === 0) {
    return '';
  }

  return ['#!/bin/bash', 'set -e', '', ...blocks, ''].join('\n');
}

export function toolShellInstallScriptBase64(tools: SandboxTool[]): string {
  const script = toolShellInstallScript(tools);
  return script ? Buffer.from(script, 'utf8').toString('base64') : '';
}

export function imageSignatureFields(tools: SandboxTool[]): Array<{ id: string; install: SandboxToolInstall }> {
  return tools.map((tool) => ({ id: tool.id, install: tool.install }));
}
