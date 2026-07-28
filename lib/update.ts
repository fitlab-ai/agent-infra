import fs from 'node:fs';
import path from 'node:path';
import { AGENT_CLIENT_IDS } from './agent-clients/types.ts';
import { listAgentClientAdapters } from './agent-clients/registry.ts';
import { planAgentClientProjectAssets } from './agent-clients/project-assets.ts';
import { info, ok, err } from './log.ts';
import { resolveTemplateDir } from './paths.ts';
import { renderFile, copySkillDir, KNOWN_PLATFORMS } from './render.ts';
import { resolveEnabledTUIs } from './builtin-tuis.ts';

type FileRegistry = {
  managed: string[];
  merged: string[];
  ejected: string[];
};

type UpdateConfig = {
  project: string;
  org: string;
  language: string;
  platform?: { type?: string };
  requiresPullRequest?: boolean;       // legacy field; read-only, migrated to prFlow then removed
  prFlow?: 'required' | 'disabled';
  sandbox?: Record<string, unknown>;
  task?: { shortIdLength: number };
  labels?: Record<string, unknown>;
  files?: Partial<FileRegistry>;
  tuis?: unknown;
};

type Defaults = {
  platform: { type: string };
  sandbox: Record<string, unknown>;
  task: { shortIdLength: number };
  labels: Record<string, unknown>;
  files: FileRegistry;
};

const defaults = JSON.parse(
  fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8')
) as Defaults;

const CONFIG_DIR = '.agents';
const CONFIG_PATH = path.join(CONFIG_DIR, '.airc.json');
const AGENT_INFRA_SANDBOX_TOOL = 'agent-infra';
const LEGACY_DEFAULT_SANDBOX_TOOLS = [...AGENT_CLIENT_IDS];
const DEFAULT_SANDBOX_TOOLS = [AGENT_INFRA_SANDBOX_TOOL, ...LEGACY_DEFAULT_SANDBOX_TOOLS];

// One-time migration of the legacy project-level PR switch to the three-state
// `prFlow` preference. `true` (the old default / "PR flow on") maps to the
// strong constraint `required`; `false` maps to `disabled`. A missing or
// already-migrated config is left untouched (idempotent). Returns the new
// prFlow value when a migration happened, otherwise null.
function migratePrFlow(config: UpdateConfig): 'required' | 'disabled' | null {
  if (config.requiresPullRequest === true) {
    delete config.requiresPullRequest;
    config.prFlow = 'required';
    return 'required';
  }
  if (config.requiresPullRequest === false) {
    delete config.requiresPullRequest;
    config.prFlow = 'disabled';
    return 'disabled';
  }
  return null;
}

function isLegacyDefaultSandboxTools(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length !== LEGACY_DEFAULT_SANDBOX_TOOLS.length) {
    return false;
  }
  const tools = new Set(value);
  return LEGACY_DEFAULT_SANDBOX_TOOLS.every((tool) => tools.has(tool));
}

function migrateSandboxTools(config: UpdateConfig): boolean {
  const tools = config.sandbox?.tools;
  if (!isLegacyDefaultSandboxTools(tools)) {
    return false;
  }
  config.sandbox = {
    ...config.sandbox,
    tools: [...DEFAULT_SANDBOX_TOOLS]
  };
  return true;
}

function isPathOwnedByOtherPlatform(relativePath: string, platformType: string): boolean {
  const top = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0] ?? '';
  if (!top.startsWith('.')) return false;

  const candidate = top.slice(1);
  if (!KNOWN_PLATFORMS.has(candidate)) return false;
  return candidate !== platformType;
}

function syncFileRegistry(
  config: UpdateConfig,
  platformType: string,
  enabledTUIIds: ReadonlySet<string>
) {
  config.files ||= {};
  const before = JSON.stringify({
    files: {
      managed: config.files.managed || [],
      merged: config.files.merged || [],
      ejected: config.files.ejected || []
    }
  });
  const current: FileRegistry = {
    managed: config.files.managed || [],
    merged: config.files.merged || [],
    ejected: config.files.ejected || []
  };
  const sharedDefaults: FileRegistry = {
    managed: defaults.files.managed.filter(
      (entry) => !isPathOwnedByOtherPlatform(entry, platformType)
    ),
    merged: defaults.files.merged.filter(
      (entry) => !isPathOwnedByOtherPlatform(entry, platformType)
    ),
    ejected: defaults.files.ejected
  };
  const adapters = listAgentClientAdapters();
  const plan = planAgentClientProjectAssets({
    current,
    sharedDefaults,
    enabledAdapters: adapters.filter((adapter) => enabledTUIIds.has(adapter.id)),
    allAdapters: adapters
  });
  const added: Pick<FileRegistry, 'managed' | 'merged'> = {
    managed: plan.registry.managed.filter((entry) => !current.managed.includes(entry)),
    merged: plan.registry.merged.filter((entry) => !current.merged.includes(entry))
  };
  config.files.managed = [...plan.registry.managed];
  config.files.merged = [...plan.registry.merged];
  config.files.ejected = [...plan.registry.ejected];

  const after = JSON.stringify({
    files: {
      managed: config.files.managed,
      merged: config.files.merged,
      ejected: config.files.ejected
    }
  });

  return { added, changed: before !== after };
}

async function cmdUpdate(): Promise<void> {
  console.log('');
  console.log('  ai update');
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
  const enabledTUIs = resolveEnabledTUIs(config.tuis);
  const replacements = { project, org };

  info(`Updating seed files for: ${project}`);
  console.log('');

  // select language-specific template filenames
  let claudeSrc, geminiSrc, opencodeSrc;
  if (language === 'zh-CN') {
    claudeSrc = 'update-agent-infra.zh-CN.md';
    geminiSrc = 'update-agent-infra.zh-CN.toml';
    opencodeSrc = 'update-agent-infra.zh-CN.md';
  } else {
    claudeSrc = 'update-agent-infra.en.md';
    geminiSrc = 'update-agent-infra.en.toml';
    opencodeSrc = 'update-agent-infra.en.md';
  }

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
  try {
    fs.unlinkSync(path.join('.agents', 'skills', 'update-agent-infra', 'scripts', 'sync-templates.cjs'));
  } catch {
    // Ignore missing legacy script from pre-ESM installs.
  }

  // update Claude command (only if enabled)
  if (enabledTUIs.has('claude-code')) {
    renderFile(
      path.join(templateDir, '.claude', 'commands', claudeSrc),
      path.join('.claude', 'commands', 'update-agent-infra.md'),
      replacements
    );
    ok('Updated .claude/commands/update-agent-infra.md');
  }

  // update Gemini command (only if enabled)
  if (enabledTUIs.has('gemini-cli')) {
    renderFile(
      path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
      path.join('.gemini', 'commands', project, 'update-agent-infra.toml'),
      replacements
    );
    ok(`Updated .gemini/commands/${project}/update-agent-infra.toml`);
  }

  // update OpenCode command (only if enabled)
  if (enabledTUIs.has('opencode')) {
    renderFile(
      path.join(templateDir, '.opencode', 'commands', opencodeSrc),
      path.join('.opencode', 'commands', 'update-agent-infra.md'),
      replacements
    );
    ok('Updated .opencode/commands/update-agent-infra.md');
  }

  // sync file registry
  const { added, changed } = syncFileRegistry(config, platformType, enabledTUIs);
  const hasNewEntries = added.managed.length > 0 || added.merged.length > 0;
  const platformAdded = !config.platform;
  const sandboxAdded = !config.sandbox;
  const taskAdded = !config.task;
  const labelsAdded = !config.labels;
  const prFlowMigrated = migratePrFlow(config);
  const sandboxToolsMigrated = !sandboxAdded && migrateSandboxTools(config);
  let configChanged = changed;

  if (platformAdded) {
    config.platform = structuredClone(defaults.platform);
    configChanged = true;
  }

  if (sandboxAdded) {
    config.sandbox = structuredClone(defaults.sandbox);
    configChanged = true;
  }

  if (taskAdded) {
    config.task = structuredClone(defaults.task);
    configChanged = true;
  }

  if (labelsAdded) {
    config.labels = structuredClone(defaults.labels);
    configChanged = true;
  }

  if (prFlowMigrated) {
    configChanged = true;
  }

  if (sandboxToolsMigrated) {
    configChanged = true;
  }

  if (configChanged) {
    console.log('');
    if (hasNewEntries) {
      info(`New file entries synced to ${CONFIG_PATH}:`);
      for (const entry of added.managed) {
        ok(`  managed: ${entry}`);
      }
      for (const entry of added.merged) {
        ok(`  merged: ${entry}`);
      }
    } else if (platformAdded || sandboxAdded || taskAdded || labelsAdded || prFlowMigrated) {
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
      if (prFlowMigrated) {
        info(`Migrated legacy requiresPullRequest to prFlow="${prFlowMigrated}" in ${CONFIG_PATH}.`);
      }
      if (sandboxToolsMigrated) {
        info(`Migrated default sandbox.tools to include ${AGENT_INFRA_SANDBOX_TOOL} in ${CONFIG_PATH}.`);
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
    if (hasNewEntries && prFlowMigrated) {
      info(`Migrated legacy requiresPullRequest to prFlow="${prFlowMigrated}" in ${CONFIG_PATH}.`);
    }
    if (hasNewEntries && sandboxToolsMigrated) {
      info(`Migrated default sandbox.tools to include ${AGENT_INFRA_SANDBOX_TOOL} in ${CONFIG_PATH}.`);
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok(`Updated ${CONFIG_PATH}`);
  }

  // done
  console.log('');
  ok('Seed files updated successfully!');
  console.log('');
  if (enabledTUIs.size === 0) {
    console.log('  No built-in TUI enabled (tuis: []).');
    console.log(`  Configure "customTUIs" in ${CONFIG_PATH} if needed.`);
    console.log('');
  } else {
    console.log('  Next step: run the full update in your AI TUI:');
    console.log('');
    const claudeOrOpencode: string[] = [];
    if (enabledTUIs.has('claude-code')) claudeOrOpencode.push('Claude Code');
    if (enabledTUIs.has('opencode')) claudeOrOpencode.push('OpenCode');
    if (claudeOrOpencode.length > 0) {
      console.log(`    ${claudeOrOpencode.join(' / ')}:  /update-agent-infra`);
    }
    if (enabledTUIs.has('gemini-cli')) {
      console.log(`    Gemini CLI:              /${project}:update-agent-infra`);
    }
    if (enabledTUIs.has('codex')) {
      console.log('    Codex CLI:               $update-agent-infra');
    }
    console.log('');
  }
}

export { cmdUpdate };
