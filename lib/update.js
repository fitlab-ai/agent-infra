import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { info, ok, err } from './log.js';
import { resolveTemplateDir, resolveInstallDir, isCloneInstall } from './paths.js';
import { renderFile, copySkillDir } from './render.js';

const defaults = JSON.parse(
  fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8')
);

function syncFileRegistry(config) {
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

  return added;
}

async function cmdUpdate() {
  console.log('');
  console.log('  agent-orchestrator update');
  console.log('  ==================================');
  console.log('');

  // check .aorc.json exists
  if (!fs.existsSync('.aorc.json')) {
    err('No .aorc.json found in current directory.');
    err('Run "ao init" first to initialize the project.');
    process.exitCode = 1;
    return;
  }

  // resolve templates
  const templateDir = resolveTemplateDir();
  if (!templateDir) {
    err('Template directory not found.');
    err('Install via npm: npm install -g @fitlab-ai/agent-orchestrator');
    err('Or via clone: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-orchestrator/main/install.sh | sh');
    process.exitCode = 1;
    return;
  }

  // auto-update: only for clone installs
  if (isCloneInstall()) {
    const installDir = resolveInstallDir();
    if (fs.existsSync(path.join(installDir, '.git'))) {
      info('Updating templates to latest version...');
      try {
        execSync('git pull --rebase --quiet', { cwd: installDir, stdio: 'pipe' });
        ok('Templates updated.');
      } catch {
        err('Failed to update templates (network issue?). Using local version.');
      }
    }
  }

  // read project config
  const config = JSON.parse(fs.readFileSync('.aorc.json', 'utf8'));
  const { project, org, language } = config;
  const replacements = { project, org };

  info(`Updating seed files for: ${project}`);
  console.log('');

  // select language-specific template filenames
  let claudeSrc, geminiSrc, opencodeSrc;
  if (language === 'zh-CN') {
    claudeSrc = 'update-agent-orchestrator.zh-CN.md';
    geminiSrc = 'update-agent-orchestrator.zh-CN.toml';
    opencodeSrc = 'update-agent-orchestrator.zh-CN.md';
  } else {
    claudeSrc = 'update-agent-orchestrator.md';
    geminiSrc = 'update-agent-orchestrator.toml';
    opencodeSrc = 'update-agent-orchestrator.md';
  }

  // update skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-orchestrator'),
    path.join('.agents', 'skills', 'update-agent-orchestrator'),
    replacements,
    language
  );
  ok('Updated .agents/skills/update-agent-orchestrator/');
  try {
    fs.unlinkSync(path.join('.agents', 'skills', 'update-agent-orchestrator', 'scripts', 'sync-templates.cjs'));
  } catch {
    // Ignore missing legacy script from pre-ESM installs.
  }

  // update Claude command
  renderFile(
    path.join(templateDir, '.claude', 'commands', claudeSrc),
    path.join('.claude', 'commands', 'update-agent-orchestrator.md'),
    replacements
  );
  ok('Updated .claude/commands/update-agent-orchestrator.md');

  // update Gemini command
  renderFile(
    path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
    path.join('.gemini', 'commands', project, 'update-agent-orchestrator.toml'),
    replacements
  );
  ok(`Updated .gemini/commands/${project}/update-agent-orchestrator.toml`);

  // update OpenCode command
  renderFile(
    path.join(templateDir, '.opencode', 'commands', opencodeSrc),
    path.join('.opencode', 'commands', 'update-agent-orchestrator.md'),
    replacements
  );
  ok('Updated .opencode/commands/update-agent-orchestrator.md');

  // sync file registry
  const added = syncFileRegistry(config);
  const hasNewEntries = added.managed.length > 0 || added.merged.length > 0;

  if (hasNewEntries) {
    console.log('');
    info('New file entries synced to .aorc.json:');
    for (const entry of added.managed) {
      ok(`  managed: ${entry}`);
    }
    for (const entry of added.merged) {
      ok(`  merged: ${entry}`);
    }
    fs.writeFileSync('.aorc.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok('Updated .aorc.json');
  }

  // done
  console.log('');
  ok('Seed files updated successfully!');
  console.log('');
  console.log('  Next step: run the full update in your AI TUI:');
  console.log('');
  console.log('    Claude Code / OpenCode:  /update-agent-orchestrator');
  console.log(`    Gemini CLI:              /${project}:update-agent-orchestrator`);
  console.log('    Codex CLI:               $update-agent-orchestrator');
  console.log('');
}

export { cmdUpdate };
