'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { info, ok, err } = require('./log');
const { resolveTemplateDir, resolveInstallDir, isCloneInstall } = require('./paths');
const { renderFile, copyFile } = require('./render');
const defaults = require('./defaults.json');

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
  console.log('  ai-collaboration-installer update');
  console.log('  ==================================');
  console.log('');

  // check collaborator.json exists
  if (!fs.existsSync('collaborator.json')) {
    err('No collaborator.json found in current directory.');
    err('Run "aci init" first to initialize the project.');
    process.exitCode = 1;
    return;
  }

  // resolve templates
  const templateDir = resolveTemplateDir();
  if (!templateDir) {
    err('Template directory not found.');
    err('Install via npm: npm install -g ai-collaboration-installer');
    err('Or via clone: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh');
    process.exitCode = 1;
    return;
  }

  // auto-update: only for clone installs
  if (isCloneInstall()) {
    const installDir = resolveInstallDir();
    if (fs.existsSync(path.join(installDir, '.git'))) {
      info('Updating templates to latest version...');
      try {
        execSync('git pull --quiet', { cwd: installDir, stdio: 'pipe' });
        ok('Templates updated.');
      } catch {
        err('Failed to update templates (network issue?). Using local version.');
      }
    }
  }

  // read project config
  const config = JSON.parse(fs.readFileSync('collaborator.json', 'utf8'));
  const { project, org, language } = config;
  const replacements = { project, org };

  info(`Updating seed files for: ${project}`);
  console.log('');

  // select language-specific template filenames
  let skillFile, claudeSrc, geminiSrc, opencodeSrc;
  if (language === 'zh-CN') {
    skillFile = 'SKILL.zh-CN.md';
    claudeSrc = 'update-ai-collaboration.zh-CN.md';
    geminiSrc = 'update-ai-collaboration.zh-CN.toml';
    opencodeSrc = 'update-ai-collaboration.zh-CN.md';
  } else {
    skillFile = 'SKILL.md';
    claudeSrc = 'update-ai-collaboration.md';
    geminiSrc = 'update-ai-collaboration.toml';
    opencodeSrc = 'update-ai-collaboration.md';
  }

  // update skill
  renderFile(
    path.join(templateDir, '.agents', 'skills', 'update-ai-collaboration', skillFile),
    path.join('.agents', 'skills', 'update-ai-collaboration', 'SKILL.md'),
    replacements
  );
  ok('Updated .agents/skills/update-ai-collaboration/SKILL.md');
  copyFile(
    path.join(templateDir, '.agents', 'skills', 'update-ai-collaboration', 'scripts', 'sync-templates.cjs'),
    path.join('.agents', 'skills', 'update-ai-collaboration', 'scripts', 'sync-templates.cjs')
  );
  ok('Updated .agents/skills/update-ai-collaboration/scripts/sync-templates.cjs');
  try {
    fs.unlinkSync(path.join('.agents', 'skills', 'update-ai-collaboration', 'scripts', 'sync-templates.js'));
  } catch {
    // Ignore missing legacy script from pre-.cjs installs.
  }

  // update Claude command
  renderFile(
    path.join(templateDir, '.claude', 'commands', claudeSrc),
    path.join('.claude', 'commands', 'update-ai-collaboration.md'),
    replacements
  );
  ok('Updated .claude/commands/update-ai-collaboration.md');

  // update Gemini command
  renderFile(
    path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
    path.join('.gemini', 'commands', project, 'update-ai-collaboration.toml'),
    replacements
  );
  ok(`Updated .gemini/commands/${project}/update-ai-collaboration.toml`);

  // update OpenCode command
  renderFile(
    path.join(templateDir, '.opencode', 'commands', opencodeSrc),
    path.join('.opencode', 'commands', 'update-ai-collaboration.md'),
    replacements
  );
  ok('Updated .opencode/commands/update-ai-collaboration.md');

  // sync file registry
  const added = syncFileRegistry(config);
  const hasNewEntries = added.managed.length > 0 || added.merged.length > 0;

  if (hasNewEntries) {
    console.log('');
    info('New file entries synced to collaborator.json:');
    for (const entry of added.managed) {
      ok(`  managed: ${entry}`);
    }
    for (const entry of added.merged) {
      ok(`  merged: ${entry}`);
    }
    fs.writeFileSync('collaborator.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok('Updated collaborator.json');
  }

  // done
  console.log('');
  ok('Seed files updated successfully!');
  console.log('');
  console.log('  Next step: run the full update in your AI TUI:');
  console.log('');
  console.log('    Claude Code / OpenCode:  /update-ai-collaboration');
  console.log(`    Gemini CLI:              /${project}:update-ai-collaboration`);
  console.log('    Codex CLI:               $update-ai-collaboration');
  console.log('');
}

module.exports = { cmdUpdate };
