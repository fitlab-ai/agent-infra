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
  console.log('  agent-infra update');
  console.log('  ==================================');
  console.log('');

  // check .airc.json exists
  if (!fs.existsSync('.airc.json')) {
    err('No .airc.json found in current directory.');
    err('Run "ai init" first to initialize the project.');
    process.exitCode = 1;
    return;
  }

  // resolve templates
  const templateDir = resolveTemplateDir();
  if (!templateDir) {
    err('Template directory not found.');
    err('Install via npm: npm install -g @fitlab-ai/agent-infra');
    err('Or via clone: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh');
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
  const config = JSON.parse(fs.readFileSync('.airc.json', 'utf8'));
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
  const added = syncFileRegistry(config);
  const hasNewEntries = added.managed.length > 0 || added.merged.length > 0;

  if (hasNewEntries) {
    console.log('');
    info('New file entries synced to .airc.json:');
    for (const entry of added.managed) {
      ok(`  managed: ${entry}`);
    }
    for (const entry of added.merged) {
      ok(`  merged: ${entry}`);
    }
    fs.writeFileSync('.airc.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
    ok('Updated .airc.json');
  }

  // configure Git hooks path
  try {
    execSync('git config core.hooksPath .github/hooks', { stdio: 'pipe' });
    ok('Configured Git hooks path: .github/hooks');
  } catch {
    // not a git repo or git not available — skip silently
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
