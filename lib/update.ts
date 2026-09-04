import fs from 'node:fs';
import path from 'node:path';
import { normalizeAgentClients } from './agent-clients/config.ts';
import {
  applyAgentClientReconciliation,
  planAgentClientReconciliation
} from './agent-clients/reconcile.ts';
import { info, ok, err } from './log.ts';
import { resolveTemplateDir } from './paths.ts';
import { renderFile, copySkillDir } from './render.ts';

type FileRegistry = {
  managed: string[];
  merged: string[];
  ejected: string[];
};

type UpdateConfig = {
  project: string;
  org: string;
  language: string;
  platform?: { type?: string; providers?: Record<string, unknown> };
  prFlow?: 'required' | 'disabled';
  sandbox?: Record<string, unknown>;
  task?: { shortIdLength: number };
  delivery?: { remote?: string; baseRef?: string };
  labels?: Record<string, unknown>;
  files?: Partial<FileRegistry>;
  agentClients?: unknown;
  customTUIs?: unknown;
};

type Defaults = {
  platform: { type: string };
  sandbox: Record<string, unknown>;
  task: { shortIdLength: number };
  delivery: { remote: string; baseRef: string };
  labels: Record<string, unknown>;
  files: FileRegistry;
};

const defaults = JSON.parse(
  fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8')
) as Defaults;

const CONFIG_DIR = '.agents';
const CONFIG_PATH = path.join(CONFIG_DIR, '.airc.json');

async function cmdSync(): Promise<void> {
  console.log('');
  console.log('  ai sync');
  console.log('  ==================================');
  console.log('');

  // check config exists
  if (!fs.existsSync(CONFIG_PATH)) {
    err(`No ${CONFIG_PATH} found in current directory.`);
    err('Run "ai init" first to initialize the project.');
    process.exitCode = 1;
    return;
  }

  // resolve templates
  const templateDir = resolveTemplateDir();
  if (!templateDir) {
    err('Template directory not found.');
    err('Install via npm: npm install -g @fitlab-ai/agent-infra');
    process.exitCode = 1;
    return;
  }

  // read project config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as UpdateConfig;
  const { project, org, language } = config;
  const platformType = config.platform?.type || defaults.platform.type;
  const replacements = { project, org };

  const normalizedOriginal = normalizeAgentClients(config);
  const currentRegistry: FileRegistry = {
    managed: config.files?.managed || [],
    merged: config.files?.merged || [],
    ejected: config.files?.ejected || []
  };
  const platformAdded = !config.platform;
  const sandboxAdded = !config.sandbox;
  const taskAdded = !config.task;
  const labelsAdded = !config.labels;
  const deliveryAdded = !config.delivery;
  if (platformAdded) config.platform = structuredClone(defaults.platform);
  if (sandboxAdded) config.sandbox = structuredClone(defaults.sandbox);
  if (taskAdded) config.task = structuredClone(defaults.task);
  if (labelsAdded) config.labels = structuredClone(defaults.labels);
  if (deliveryAdded) config.delivery = structuredClone(defaults.delivery);

  const workflowPlan = planAgentClientReconciliation({
    config: config as unknown as Record<string, unknown>,
    mutation: { type: 'replace-state', state: normalizedOriginal.state },
    projectRoot: process.cwd(),
    templateRoot: templateDir,
    platformType,
    language
  });

  info(`Syncing seed files for: ${project}`);
  console.log('');

  // update skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-infra'),
    path.join('.agents', 'skills', 'update-agent-infra'),
    replacements,
    language,
    platformType
  );
  ok('Updated .agents/skills/update-agent-infra/');
  renderFile(
    path.join(templateDir, '.agents', 'scripts', 'lib', 'agent-infra-package.js'),
    path.join('.agents', 'scripts', 'lib', 'agent-infra-package.js'),
    replacements
  );
  ok('Updated .agents/scripts/lib/agent-infra-package.js');
  const added = {
    managed: workflowPlan.projectAssets.registry.managed.filter(
      (entry) => !currentRegistry.managed.includes(entry)
    ),
    merged: workflowPlan.projectAssets.registry.merged.filter(
      (entry) => !currentRegistry.merged.includes(entry)
    )
  };
  const hasNewEntries = added.managed.length > 0 || added.merged.length > 0;
  const reconcileResult = applyAgentClientReconciliation(workflowPlan);
  for (const target of reconcileResult.applied) ok(`Updated ${target}`);

  if (reconcileResult.configUpdated) {
    console.log('');
    if (hasNewEntries) {
      info(`New file entries synced to ${CONFIG_PATH}:`);
      for (const entry of added.managed) {
        ok(`  managed: ${entry}`);
      }
      for (const entry of added.merged) {
        ok(`  merged: ${entry}`);
      }
    } else if (platformAdded || sandboxAdded || taskAdded || labelsAdded) {
      if (platformAdded) {
        info(`Default platform config added to ${CONFIG_PATH}.`);
      }
      if (sandboxAdded) {
        info(`Default sandbox config added to ${CONFIG_PATH}.`);
      }
      if (taskAdded) {
        info(`Default task.shortIdLength=${defaults.task.shortIdLength} added to ${CONFIG_PATH}.`);
      }
      if (labelsAdded) {
        info(`Default labels.in config added to ${CONFIG_PATH}.`);
      }
      if (deliveryAdded) {
        info(`Default delivery target added to ${CONFIG_PATH}.`);
      }
    } else {
      info(`File registry changed in ${CONFIG_PATH}.`);
    }
    if (hasNewEntries && sandboxAdded) {
      info(`Default sandbox config added to ${CONFIG_PATH}.`);
    }
    if (hasNewEntries && taskAdded) {
      info(`Default task.shortIdLength=${defaults.task.shortIdLength} added to ${CONFIG_PATH}.`);
    }
    if (hasNewEntries && labelsAdded) {
      info(`Default labels.in config added to ${CONFIG_PATH}.`);
    }
    if (hasNewEntries && platformAdded) {
      info(`Default platform config added to ${CONFIG_PATH}.`);
    }
    if (hasNewEntries && deliveryAdded) {
      info(`Default delivery target added to ${CONFIG_PATH}.`);
    }
    ok(`Updated ${CONFIG_PATH}`);
  }

  // done
  console.log('');
  ok('Seed files synced successfully!');
  console.log('');
  if (workflowPlan.nextSteps.length === 0) {
    console.log('  No Agent Client project integration enabled.');
    console.log(`  Configure "customTUIs" in ${CONFIG_PATH} if needed.`);
    console.log('');
  } else {
    console.log('  Next step: run the full update in your AI TUI:');
    console.log('');
    for (const nextStep of workflowPlan.nextSteps) {
      console.log(`    ${nextStep.displayName}: ${nextStep.command}`);
    }
    console.log('');
  }
}

export { cmdSync };
