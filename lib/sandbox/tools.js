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

function createBuiltinTools(home) {
  /** @type {Record<string, SandboxTool>} */
  return {
    'claude-code': {
      id: 'claude-code',
      name: 'Claude Code',
      npmPackage: '@anthropic-ai/claude-code',
      sandboxBase: path.join(home, '.claude-sandboxes'),
      containerMount: '/home/devuser/.claude',
      versionCmd: 'claude --version',
      setupHint: 'OAuth token is auto-injected from host when available. Otherwise run: claude login',
      envVars: { CLAUDE_CONFIG_DIR: '/home/devuser/.claude' },
      hostPreSeedDirs: [
        { hostDir: path.join(home, '.claude', 'plugins'), sandboxSubdir: 'plugins' }
      ],
      pathRewriteFiles: [
        'plugins/installed_plugins.json',
        'plugins/known_marketplaces.json'
      ]
    },
    codex: {
      id: 'codex',
      name: 'Codex',
      npmPackage: '@openai/codex',
      sandboxBase: path.join(home, '.codex-sandboxes'),
      containerMount: '/home/devuser/.codex',
      versionCmd: 'codex --version',
      setupHint: 'Run codex once inside the container and choose Device Code login if needed.',
      hostLiveMounts: [
        { hostPath: path.join(home, '.codex', 'auth.json'), containerSubpath: 'auth.json' }
      ],
      postSetupCmds: [
        'test -d /workspace/.codex/commands && ln -sfn /workspace/.codex/commands /home/devuser/.codex/prompts || true'
      ]
    },
    opencode: {
      id: 'opencode',
      name: 'OpenCode',
      npmPackage: 'opencode-ai',
      sandboxBase: path.join(home, '.opencode-sandboxes'),
      containerMount: '/home/devuser/.local/share/opencode',
      versionCmd: 'opencode version',
      setupHint: 'Configure OpenCode credentials inside the container before first use.',
      hostLiveMounts: [
        {
          hostPath: path.join(home, '.local', 'share', 'opencode', 'auth.json'),
          containerSubpath: 'auth.json'
        }
      ]
    },
    'gemini-cli': {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      npmPackage: '@google/gemini-cli',
      sandboxBase: path.join(home, '.gemini-sandboxes'),
      containerMount: '/home/devuser/.gemini',
      versionCmd: 'gemini --version',
      setupHint: 'Run gemini inside the container to finish authentication.',
      hostLiveMounts: [
        { hostPath: path.join(home, '.gemini', 'oauth_creds.json'), containerSubpath: 'oauth_creds.json' }
      ],
      hostPreSeedFiles: [
        { hostPath: path.join(home, '.gemini', 'settings.json'), sandboxName: 'settings.json' },
        { hostPath: path.join(home, '.gemini', 'google_accounts.json'), sandboxName: 'google_accounts.json' }
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
  const builtins = createBuiltinTools(config.home);
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
  return path.join(tool.sandboxBase, project, sanitizeBranchName(branch));
}

export function toolConfigDirCandidates(tool, project, branch) {
  return safeNameCandidates(branch).map((name) => path.join(tool.sandboxBase, project, name));
}

export function toolNpmPackagesArg(tools) {
  return tools.map((tool) => tool.npmPackage).join(' ');
}
