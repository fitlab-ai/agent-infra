import fs from 'node:fs';
import path from 'node:path';
import { info, ok, err } from './log.js';
import { resolveTemplateDir } from './paths.js';
import { renderFile, copySkillDir } from './render.js';

const defaults = JSON.parse(
  fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8')
);

const CONFIG_DIR = '.agents';
const CONFIG_PATH = path.join(CONFIG_DIR, '.airc.json');

function syncFileRegistry(config) {
  config.files ||= {};
  const before = JSON.stringify({
    files: {
      managed: config.files.managed || [],
      merged: config.files.merged || [],
      ejected: config.files.ejected || []
    }
  });
  config.files.managed = config.files.managed || [];
  config.files.merged = config.files.merged || [];
  config.files.ejected = config.files.ejected || [];

  const allExisting = [
    ...config.files.managed,
    ...config.files.merged,
    ...config.files.ejected
  ];
  const added = { managed: [], merged: [] };

  for (const entry of defaults.files.managed) {
    if (!allExisting.includes(entry)) {
      config.files.managed.push(entry);
      added.managed.push(entry);
    }
  }
  for (const entry of defaults.files.merged) {
    if (!allExisting.includes(entry)) {
      config.files.merged.push(entry);
      added.merged.push(entry);
    }
  }

  const after = JSON.stringify({
    files: {
      managed: config.files.managed,
      merged: config.files.merged,
      ejected: config.files.ejected
    }
  });

  return { added, changed: before !== after };
}

async function cmdUpdate() {
  console.log('');
  console.log('  agent-infra update');
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
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const { project, org, language } = config;
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
    claudeSrc = 'update-agent-infra.md';
    geminiSrc = 'update-agent-infra.toml';
    opencodeSrc = 'update-agent-infra.md';
  }

  // update skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-infra'),
    path.join('.agents', 'skills', 'update-agent-infra'),
    replacements,
    language
  );
  ok('Updated .agents/skills/update-agent-infra/');
  try {
    fs.unlinkSync(path.join('.agents', 'skills', 'update-agent-infra', 'scripts', 'sync-templates.cjs'));
  } catch {
    // Ignore missing legacy script from pre-ESM installs.
  }

  // update Claude command
  renderFile(
    path.join(templateDir, '.claude', 'commands', claudeSrc),
    path.join('.claude', 'commands', 'update-agent-infra.md'),
    replacements
  );
  ok('Updated .claude/commands/update-agent-infra.md');

  // update Gemini command
  renderFile(
    path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
    path.join('.gemini', 'commands', project, 'update-agent-infra.toml'),
    replacements
  );
  ok(`Updated .gemini/commands/${project}/update-agent-infra.toml`);

  // update OpenCode command
  renderFile(
    path.join(templateDir, '.opencode', 'commands', opencodeSrc),
    path.join('.opencode', 'commands', 'update-agent-infra.md'),
    replacements
  );
  ok('Updated .opencode/commands/update-agent-infra.md');

  // sync file registry
  const { added, changed } = syncFileRegistry(config);
  const hasNewEntries = added.managed.length > 0 || added.merged.length > 0;

  if (changed) {
    console.log('');
    if (hasNewEntries) {
      info(`New file entries synced to ${CONFIG_PATH}:`);
      for (const entry of added.managed) {
        ok(`  managed: ${entry}`);
      }
      for (const entry of added.merged) {
        ok(`  merged: ${entry}`);
      }
    } else {
      info(`File registry changed in ${CONFIG_PATH}.`);
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok(`Updated ${CONFIG_PATH}`);
  }

  // done
  console.log('');
  ok('Seed files updated successfully!');
  console.log('');
  console.log('  Next step: run the full update in your AI TUI:');
  console.log('');
  console.log('    Claude Code / OpenCode:  /update-agent-infra');
  console.log(`    Gemini CLI:              /${project}:update-agent-infra`);
  console.log('    Codex CLI:               $update-agent-infra');
  console.log('');
}

export { cmdUpdate };
