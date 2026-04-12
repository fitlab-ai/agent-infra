import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULTS = Object.freeze({
  runtimes: ['node20'],
  tools: ['claude-code', 'codex', 'opencode', 'gemini-cli'],
  dockerfile: null,
  vm: {
    cpu: null,
    memory: null,
    disk: null
  }
});

function detectRepoRoot() {
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
    runtimes: [...DEFAULTS.runtimes],
    tools: [...DEFAULTS.tools],
    dockerfile: DEFAULTS.dockerfile,
    vm: { ...DEFAULTS.vm }
  };
}

function joinHome(home, ...parts) {
  return home.startsWith('/') ? path.posix.join(home, ...parts) : path.join(home, ...parts);
}

export function loadConfig() {
  const repoRoot = detectRepoRoot();
  const home = process.env.HOME;

  if (!home) {
    throw new Error('sandbox: HOME environment variable is required');
  }

  const configPath = path.join(repoRoot, '.agents', '.airc.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('No .agents/.airc.json found. Run "ai init" first.');
  }

  const airc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const defaults = cloneDefaults();
  const sandbox = airc.sandbox ?? {};
  const project = airc.project;

  if (!project || typeof project !== 'string') {
    throw new Error('sandbox: .agents/.airc.json is missing a valid "project" field');
  }

  return {
    repoRoot,
    configPath,
    project,
    org: airc.org ?? '',
    home,
    containerPrefix: `${project}-dev`,
    imageName: `${project}-sandbox:latest`,
    worktreeBase: joinHome(home, '.agent-infra', 'worktrees', project),
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
