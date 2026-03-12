'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { info, ok, err } = require('./log');
const { prompt, closePrompt } = require('./prompt');
const { resolveTemplateDir, resolveInstallDir, isCloneInstall } = require('./paths');
const { renderFile, copyFile } = require('./render');
const { VERSION } = require('./version');
const defaults = require('./defaults.json');

function detectProjectName() {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim().replace(/\.git$/, '');
    return path.basename(url);
  } catch {
    return path.basename(process.cwd());
  }
}

function detectOrgName() {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim().replace(/\.git$/, '');
    // SSH: git@github.com:org/repo  →  org
    // HTTPS: https://github.com/org/repo  →  org
    const sshMatch = url.match(/:([^/]+)\//);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = url.match(/\/\/[^/]+\/([^/]+)\//);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    // no remote
  }
  return '';
}

const VALID_NAME_RE = /^[a-zA-Z0-9_.@-]+$/;

async function cmdInit() {
  console.log('');
  console.log('  ai-collaboration-installer init');
  console.log('  ================================');
  console.log('');

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

  // check existing collaborator.json
  if (fs.existsSync('collaborator.json')) {
    err('This project already has a collaborator.json.');
    err('Use /update-ai-collaboration in your AI TUI to update.');
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
  closePrompt();
  if (language === 'zh') language = 'zh-CN';
  if (language !== 'en' && language !== 'zh-CN') {
    err(`Language must be 'en' or 'zh'. Got: ${language}`);
    process.exitCode = 1;
    return;
  }

  const modules = 'ai,github';
  const project = projectName;
  const replacements = { project, org: orgName };

  console.log('');
  if (orgName) {
    info(`Installing update-ai-collaboration seed command for: ${projectName} (${orgName})`);
  } else {
    info(`Installing update-ai-collaboration seed command for: ${projectName}`);
  }
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

  // install skill
  renderFile(
    path.join(templateDir, '.agents', 'skills', 'update-ai-collaboration', skillFile),
    path.join('.agents', 'skills', 'update-ai-collaboration', 'SKILL.md'),
    replacements
  );
  ok('Installed .agents/skills/update-ai-collaboration/SKILL.md');
  copyFile(
    path.join(templateDir, '.agents', 'skills', 'update-ai-collaboration', 'scripts', 'sync-templates.cjs'),
    path.join('.agents', 'skills', 'update-ai-collaboration', 'scripts', 'sync-templates.cjs')
  );
  ok('Installed .agents/skills/update-ai-collaboration/scripts/sync-templates.cjs');

  // install Claude command
  renderFile(
    path.join(templateDir, '.claude', 'commands', claudeSrc),
    path.join('.claude', 'commands', 'update-ai-collaboration.md'),
    replacements
  );
  ok('Installed .claude/commands/update-ai-collaboration.md');

  // install Gemini command
  renderFile(
    path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
    path.join('.gemini', 'commands', project, 'update-ai-collaboration.toml'),
    replacements
  );
  ok(`Installed .gemini/commands/${project}/update-ai-collaboration.toml`);

  // install OpenCode command
  renderFile(
    path.join(templateDir, '.opencode', 'commands', opencodeSrc),
    path.join('.opencode', 'commands', 'update-ai-collaboration.md'),
    replacements
  );
  ok('Installed .opencode/commands/update-ai-collaboration.md');

  // generate collaborator.json
  const modulesArray = modules.split(',');
  const config = {
    version: VERSION,
    project: projectName,
    org: orgName,
    language,
    templateSource: 'templates/',
    templateVersion: VERSION,
    modules: modulesArray,
    files: structuredClone(defaults.files)
  };

  fs.writeFileSync('collaborator.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
  ok('Generated collaborator.json');

  // done
  console.log('');
  ok('Project initialized successfully!');
  console.log('');
  console.log('  Next step: open this project in any AI TUI and run:');
  console.log('');
  console.log('    Claude Code / OpenCode:  /update-ai-collaboration');
  console.log(`    Gemini CLI:              /${project}:update-ai-collaboration`);
  console.log('    Codex CLI:               $update-ai-collaboration');
  console.log('');
  console.log('  This will render all templates and set up the full');
  console.log('  AI collaboration infrastructure.');
  console.log('');
}

module.exports = { cmdInit };
