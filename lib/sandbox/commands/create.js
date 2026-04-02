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
  worktreeDirCandidates
} from '../constants.js';
import { prepareDockerfile } from '../dockerfile.js';
import { ensureDocker } from '../engine.js';
import { run, runOk, runSafe } from '../shell.js';
import { resolveTaskBranch } from '../task-resolver.js';
import { resolveTools, toolConfigDirCandidates, toolNpmPackagesArg } from '../tools.js';

const DEFAULT_SANDBOX_ALIASES = `alias claude-yolo='claude --dangerously-skip-permissions'
alias opencode-yolo='opencode --dangerously-skip-permissions'
alias codex-yolo='codex --yolo'
alias gemini-yolo='gemini --yolo'

alias cy='claude --dangerously-skip-permissions'
alias oy='opencode --dangerously-skip-permissions'
alias xy='codex --yolo'
alias gy='gemini --yolo'
`;
const CONTAINER_HOME = '/home/devuser';
const USAGE = `Usage: ai sandbox create <branch> [base] [--cpu <n>] [--memory <n>]

Host aliases:
  ${'~'}/.ai-sandbox-aliases is auto-created on first run and synced to
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

function resolveToolDirs(config, tools, branch) {
  return tools.map((tool) => {
    const candidates = toolConfigDirCandidates(tool, config.project, branch);
    return {
      tool,
      dir: candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
    };
  });
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

function syncGitConfig(container, repoRoot, home) {
  const gitconfigPath = path.join(home, '.gitconfig');
  if (!fs.existsSync(gitconfigPath)) {
    return;
  }

  let gitconfig = fs.readFileSync(gitconfigPath, 'utf8');
  gitconfig = gitconfig.replaceAll(home, CONTAINER_HOME);
  gitconfig = gitconfig.replace(/\[difftool "sourcetree"\][^\[]*/gs, '');
  gitconfig = gitconfig.replace(/\[mergetool "sourcetree"\][^\[]*/gs, '');

  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${CONTAINER_HOME}/.gitconfig`], {
    input: gitconfig,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  runSafe('docker', ['exec', container, 'git', 'config', '--global', '--add', 'safe.directory', '/workspace']);
  runSafe('docker', ['exec', container, 'git', 'config', '--global', '--add', 'safe.directory', repoRoot]);

  for (const file of ['.gitignore_global', '.stCommitMsg']) {
    const hostFile = path.join(home, file);
    if (fs.existsSync(hostFile)) {
      runSafe('docker', ['cp', hostFile, `${container}:${CONTAINER_HOME}/${file}`]);
    }
  }
}

export function syncShellAliases(container, home, execDocker = execFileSync) {
  const aliasesPath = sandboxAliasesPath(home);
  if (!fs.existsSync(aliasesPath)) {
    return false;
  }

  const aliases = fs.readFileSync(aliasesPath, 'utf8');
  execDocker('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${CONTAINER_HOME}/.bash_aliases`], {
    input: aliases,
    stdio: ['pipe', 'pipe', 'pipe']
  });
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

export function sandboxAliasesPath(home) {
  return path.join(home, '.ai-sandbox-aliases');
}

export function ensureSandboxAliasesFile(home) {
  const aliasesPath = sandboxAliasesPath(home);
  if (fs.existsSync(aliasesPath)) {
    return { created: false, path: aliasesPath };
  }

  fs.writeFileSync(aliasesPath, DEFAULT_SANDBOX_ALIASES, 'utf8');
  return { created: true, path: aliasesPath };
}

function buildImage(config, tools, dockerfilePath, imageSignature) {
  const hostUid = run('id', ['-u']);
  const hostGid = run('id', ['-g']);

  run('docker', [
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
  const tools = resolveTools(effectiveConfig);
  const container = containerName(effectiveConfig, branch);
  const worktreeCandidates = worktreeDirCandidates(effectiveConfig, branch);
  const worktree = worktreeCandidates.find((candidate) => fs.existsSync(candidate)) ?? worktreeCandidates[0];
  const preparedDockerfile = prepareDockerfile(effectiveConfig);
  const baseBranch = base ?? runSafe('git', ['-C', effectiveConfig.repoRoot, 'branch', '--show-current']);
  const resolvedTools = resolveToolDirs(effectiveConfig, tools, branch);
  const expectedImageSignature = buildSignature(preparedDockerfile, tools);

  p.intro(pc.cyan('AI Sandbox'));
  p.log.info(
    `Project: ${pc.bold(effectiveConfig.project)} | Branch: ${pc.bold(branch)} | Base: ${pc.bold(baseBranch || 'HEAD')}`
  );

  try {
    await p.tasks([
      {
        title: 'Checking container engine',
        task: async (message) => {
          await ensureDocker(effectiveConfig, (detail) => message(detail));
          return 'Docker is ready';
        }
      },
      {
        title: 'Building sandbox image',
        task: async (message) => {
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

          if (imageExists && currentImageSignature === expectedImageSignature) {
            return `Image exists (${effectiveConfig.imageName})`;
          }

          message(imageExists ? 'Rebuilding stale image...' : 'Building image for first use...');
          buildImage(
            effectiveConfig,
            tools,
            preparedDockerfile.path,
            expectedImageSignature
          );
          return imageExists ? 'Image rebuilt' : 'Image built';
        }
      },
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
            run('git', ['-C', effectiveConfig.repoRoot, 'worktree', 'add', worktree, branch]);
          } else {
            message(`Creating branch '${branch}' from '${baseBranch}'...`);
            run('git', ['-C', effectiveConfig.repoRoot, 'worktree', 'add', '-b', branch, worktree, baseBranch]);
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

          const envArgs = buildContainerEnvArgs(resolvedTools);
          const toolVolumes = resolvedTools.flatMap(({ tool, dir }) => ['-v', `${dir}:${tool.containerMount}`]);
          const workspaceDir = path.join(effectiveConfig.repoRoot, '.agents', 'workspace');
          const liveMountVolumes = resolvedTools.flatMap(({ tool }) =>
            (tool.hostLiveMounts ?? [])
              .filter(({ hostPath }) => fs.existsSync(hostPath))
              .flatMap(({ hostPath, containerSubpath }) => [
                '-v',
                `${hostPath}:${path.join(tool.containerMount, containerSubpath)}`
              ])
          );

          fs.mkdirSync(workspaceDir, { recursive: true });

          run('docker', [
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
            ...envArgs,
            '-w',
            '/workspace',
            effectiveConfig.imageName
          ]);

          message('Syncing git config...');
          syncGitConfig(container, effectiveConfig.repoRoot, effectiveConfig.home);
          syncShellAliases(container, effectiveConfig.home);

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
  Edit the host aliases file to customize shortcuts synced to ${CONTAINER_HOME}/.bash_aliases.

Tool notes:
${toolHints}
`);
}
