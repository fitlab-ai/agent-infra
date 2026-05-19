import { safeNameCandidates, sanitizeBranchName } from './constants.ts';
import { hostJoin } from './engines/wsl2-paths.ts';

export type SandboxTool = {
  id: string;
  name: string;
  npmPackage: string;
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
};

type ToolsConfig = {
  home: string;
  project: string;
  tools: string[];
};

function createBuiltinTools(home: string, project: string): Record<string, SandboxTool> {
  return {
    'claude-code': {
      id: 'claude-code',
      name: 'Claude Code',
      npmPackage: '@anthropic-ai/claude-code',
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
      npmPackage: '@openai/codex',
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'codex'),
      containerMount: '/home/devuser/.codex',
      versionCmd: 'codex --version',
      setupHint: 'Run codex once inside the container and choose Device Code login if needed.',
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
      npmPackage: 'opencode-ai',
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
      npmPackage: '@google/gemini-cli',
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

function validateTool(tool: SandboxTool): void {
  if (!tool.npmPackage || !tool.containerMount.startsWith('/')) {
    throw new Error(`Invalid sandbox tool descriptor: ${tool.id}`);
  }
}

export function resolveTools(config: ToolsConfig): SandboxTool[] {
  const builtins = createBuiltinTools(config.home, config.project);
  return config.tools.map((id) => {
    const tool = builtins[id];
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
  return tools.map((tool) => tool.npmPackage).join(' ');
}
