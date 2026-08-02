import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { info, ok, err } from './log.ts';
import { prompt, select, multiSelect, closePrompt } from './prompt.ts';
import { resolveTemplateDir } from './paths.ts';
import { renderFile, copySkillDir, KNOWN_PLATFORMS } from './render.ts';
import { enginesForPlatform } from './sandbox/engines/index.ts';
import { VERSION } from './version.ts';
import { listAgentClientAdapters } from './agent-clients/registry.ts';
import { serializeAgentClients } from './agent-clients/config.ts';
import {
  applyAgentClientReconciliation,
  planAgentClientReconciliation
} from './agent-clients/reconcile.ts';
import type { AgentClientState } from './agent-clients/types.ts';

type FileRegistry = {
  managed: string[];
  merged: string[];
  ejected: string[];
};

type SourceEntry = {
  type: 'local';
  path: string;
};

type Defaults = {
  agentClients: AgentConfig['agentClients'];
  files: FileRegistry;
  sandbox: Record<string, unknown>;
  task: { shortIdLength: number };
  labels: Record<string, unknown>;
};

type AgentConfig = {
  project: string;
  org: string;
  language: string;
  platform: { type: string };
  templateVersion: string;
  sandbox: Record<string, unknown>;
  task: { shortIdLength: number };
  labels: Record<string, unknown>;
  files: FileRegistry;
  agentClients: ReturnType<typeof serializeAgentClients>;
  templates?: { sources: SourceEntry[] };
  skills?: { sources: SourceEntry[] };
};

const defaults = JSON.parse(
  fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8')
) as Defaults;

const PLATFORM_DEFAULT_ENGINES = Object.freeze({
  linux: 'native',
  darwin: 'colima',
  win32: 'wsl2'
});

function detectProjectName(): string {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim().replace(/\.git$/, '');
    return path.basename(url);
  } catch {
    return path.basename(process.cwd());
  }
}

function detectOrgName(): string {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim().replace(/\.git$/, '');
    // SSH: git@github.com:org/repo  →  org
    // HTTPS: https://github.com/org/repo  →  org
    const sshMatch = url.match(/:([^/]+)\//);
    if (sshMatch?.[1]) return sshMatch[1];
    const httpsMatch = url.match(/\/\/[^/]+\/([^/]+)\//);
    if (httpsMatch?.[1]) return httpsMatch[1];
  } catch {
    // no remote
  }
  return '';
}

const VALID_NAME_RE = /^[a-zA-Z0-9_.@-]+$/;

function parseLocalSources(input: string): SourceEntry[] {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ type: 'local', path: entry }));
}

async function cmdInit(): Promise<void> {
  console.log('');
  console.log('  ai init');
  console.log('  ================================');
  console.log('  Optional template and skill sources can be added now or later in .agents/.airc.json.');
  console.log('');

  // resolve templates
  const templateDir = resolveTemplateDir();
  if (!templateDir) {
    err('Template directory not found.');
    err('Install via npm: npm install -g @fitlab-ai/agent-infra');
    process.exitCode = 1;
    return;
  }

  const configPath = path.join('.agents', '.airc.json');

  // check existing config
  if (fs.existsSync(configPath)) {
    err('This project already has agent-infra configuration.');
    err('Use /update-agent-infra in your AI TUI to update.');
    process.exitCode = 1;
    return;
  }

  // collect project info
  const defaultProject = detectProjectName();
  const projectName = await prompt('Project name', defaultProject);
  if (!projectName) {
    err('Project name is required.');
    closePrompt();
    process.exitCode = 1;
    return;
  }
  if (!VALID_NAME_RE.test(projectName)) {
    err('Project name may only contain letters, digits, hyphens, underscores, dots, and @.');
    err(`Got: ${projectName}`);
    closePrompt();
    process.exitCode = 1;
    return;
  }

  const defaultOrg = detectOrgName();
  const orgName = await prompt('Organization / owner (optional)', defaultOrg);
  if (orgName && !VALID_NAME_RE.test(orgName)) {
    err('Organization name may only contain letters, digits, hyphens, underscores, dots, and @.');
    err(`Got: ${orgName}`);
    closePrompt();
    process.exitCode = 1;
    return;
  }

  let language = await prompt('Language (en / zh)', 'zh');
  if (language === 'zh') language = 'zh-CN';
  if (language !== 'en' && language !== 'zh-CN') {
    closePrompt();
    err(`Language must be 'en' or 'zh'. Got: ${language}`);
    process.exitCode = 1;
    return;
  }

  const currentPlatform = platform();
  const defaultEngine = PLATFORM_DEFAULT_ENGINES[currentPlatform as keyof typeof PLATFORM_DEFAULT_ENGINES];
  const engineChoices = enginesForPlatform(currentPlatform).sort((left, right) => {
    if (left === defaultEngine) return -1;
    if (right === defaultEngine) return 1;
    return 0;
  });
  let sandboxEngine = null;
  if (engineChoices.length > 0) {
    sandboxEngine = await select(
      `Sandbox engine (${currentPlatform})`,
      engineChoices,
      defaultEngine
    );
  }

  const platformChoices = [...KNOWN_PLATFORMS, 'other'];
  let platformType = await select('Platform', platformChoices, 'github');

  if (platformType === 'other') {
    platformType = (await prompt('Custom platform type', '')).trim();
    if (!platformType) {
      closePrompt();
      err('Custom platform type is required.');
      process.exitCode = 1;
      return;
    }
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(platformType)) {
    closePrompt();
    err(`Platform type must match /^[a-z0-9][a-z0-9-]*$/. Got: ${platformType}`);
    process.exitCode = 1;
    return;
  }

  if (!KNOWN_PLATFORMS.has(platformType)) {
    info(
      `Custom platform '${platformType}' selected. Built-in templates are only complete for github;`
      + ` provide matching '.${platformType}.' or generic templates before running update-agent-infra.`
    );
  }

  const adapters = listAgentClientAdapters();
  let enabledClientIds: string[];
  try {
    enabledClientIds = await multiSelect(
      'Agent Client project integrations to enable',
      adapters.map((adapter) => ({ id: adapter.id, label: adapter.displayName }))
    );
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    closePrompt();
    process.exitCode = 1;
    return;
  }
  const enabledClientSet = new Set(enabledClientIds);

  const templateSources = parseLocalSources(await prompt(
    'Template sources (optional, comma-separated local paths, e.g. ~/my-templates; Enter to skip)',
    ''
  ));
  const skillSources = parseLocalSources(await prompt(
    'Skill sources (optional, comma-separated local paths, e.g. ~/my-skills; Enter to skip)',
    ''
  ));
  closePrompt();

  const project = projectName;
  const replacements = { project, org: orgName };

  const defaultState = Object.fromEntries(defaults.agentClients.map((entry) => [
    entry.id,
    {
      enabled: enabledClientSet.has(entry.id),
      installInSandbox: entry.installInSandbox
    }
  ])) as AgentClientState;
  const config: AgentConfig = {
    project: projectName,
    org: orgName,
    language,
    platform: { type: platformType },
    templateVersion: VERSION,
    sandbox: structuredClone(defaults.sandbox),
    task: structuredClone(defaults.task),
    labels: structuredClone(defaults.labels),
    files: { managed: [], merged: [], ejected: [] },
    agentClients: serializeAgentClients(defaultState)
  };

  if (sandboxEngine) config.sandbox.engine = sandboxEngine;
  if (templateSources.length > 0) config.templates = { sources: templateSources };
  if (skillSources.length > 0) config.skills = { sources: skillSources };

  const workflowPlan = planAgentClientReconciliation({
    config: config as unknown as Record<string, unknown>,
    mutation: { type: 'none' },
    projectRoot: process.cwd(),
    templateRoot: templateDir,
    platformType,
    language
  });

  console.log('');
  if (orgName) {
    info(`Installing update-agent-infra seed command for: ${projectName} (${orgName})`);
  } else {
    info(`Installing update-agent-infra seed command for: ${projectName}`);
  }
  console.log('');

  // install skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-infra'),
    path.join('.agents', 'skills', 'update-agent-infra'),
    replacements,
    language,
    platformType
  );
  ok('Installed .agents/skills/update-agent-infra/');
  renderFile(
    path.join(templateDir, '.agents', 'scripts', 'lib', 'agent-infra-package.js'),
    path.join('.agents', 'scripts', 'lib', 'agent-infra-package.js'),
    replacements
  );
  ok('Installed .agents/scripts/lib/agent-infra-package.js');

  const reconcileResult = applyAgentClientReconciliation(workflowPlan);
  for (const target of reconcileResult.applied) ok(`Installed ${target}`);
  ok(`Generated ${configPath}`);

  // done
  console.log('');
  ok('Project initialized successfully!');
  console.log('');
  console.log('  If this init used npx, install agent-infra persistently before update or validation:');
  console.log('    npm install -g @fitlab-ai/agent-infra');
  console.log('');
  if (workflowPlan.nextSteps.length === 0) {
    console.log('  No Agent Client project integration enabled.');
    console.log(`  Configure "customTUIs" in ${configPath} before running update-agent-infra.`);
    console.log('');
  } else {
    console.log('  Next step: open this project in any AI TUI and run:');
    console.log('');
    for (const nextStep of workflowPlan.nextSteps) {
      console.log(`    ${nextStep.displayName}: ${nextStep.command}`);
    }
    console.log('');
    console.log('  This will render all templates and set up the full');
    console.log('  AI collaboration infrastructure.');
    console.log('');
  }
}

export { cmdInit };
