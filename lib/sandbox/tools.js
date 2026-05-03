import path from 'node:path';
import { safeNameCandidates, sanitizeBranchName } from './constants.js';

/**
 * @typedef {Object} SandboxTool
 * @property {string} id
 * @property {string} name
 * @property {string} npmPackage
 * @property {string} sandboxBase
 * @property {string} containerMount
 * @property {string} versionCmd
 * @property {string} setupHint
 * @property {Record<string, string>=} envVars
 * @property {Array<{ hostPath: string, sandboxName: string }>=} hostPreSeedFiles
 * @property {Array<{ hostDir: string, sandboxSubdir: string }>=} hostPreSeedDirs
 * @property {string[]=} pathRewriteFiles
 * @property {Array<{ hostPath: string, containerSubpath: string }>=} hostLiveMounts
 * @property {string[]=} postSetupCmds
 */

function hostJoin(basePath, ...segments) {
  return basePath.startsWith('/') ? path.posix.join(basePath, ...segments) : path.join(basePath, ...segments);
}

function createBuiltinTools(home, project) {
  /** @type {Record<string, SandboxTool>} */
  return {
    'claude-code': {
      id: 'claude-code',
      name: 'Claude Code',
      npmPackage: '@anthropic-ai/claude-code',
      sandboxBase: hostJoin(home, '.agent-infra', 'sandboxes', 'claude-code'),
      containerMount: '/home/devuser/.claude',
      versionCmd: 'claude --version',
      setupHint: 'Authenticates via host credentials live-mounted at ~/.claude/.credentials.json',
      // Claude Code stores user data (.claude.json onboarding state, theme,
      // workspace trust) at $HOME/.claude.json by default, which sits outside
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

function validateTool(tool) {
  if (!tool.npmPackage || !tool.containerMount.startsWith('/')) {
    throw new Error(`Invalid sandbox tool descriptor: ${tool.id}`);
  }
}

export function resolveTools(config) {
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

export function toolConfigDir(tool, project, branch) {
  return hostJoin(tool.sandboxBase, project, sanitizeBranchName(branch));
}

export function toolConfigDirCandidates(tool, project, branch) {
  return safeNameCandidates(branch).map((name) => hostJoin(tool.sandboxBase, project, name));
}

export function toolProjectDirCandidates(tool, project) {
  return [hostJoin(tool.sandboxBase, project)];
}

export function toolNpmPackagesArg(tools) {
  return tools.map((tool) => tool.npmPackage).join(' ');
}
