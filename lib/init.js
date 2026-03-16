import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { info, ok, err } from './log.js';
import { prompt, closePrompt } from './prompt.js';
import { resolveTemplateDir, resolveInstallDir, isCloneInstall } from './paths.js';
import { renderFile, copySkillDir } from './render.js';
import { VERSION } from './version.js';

const defaults = JSON.parse(
  fs.readFileSync(new URL('./defaults.json', import.meta.url), 'utf8')
);

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
  console.log('  agent-orchestrator init');
  console.log('  ================================');
  console.log('');

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

  // check existing .aorc.json
  if (fs.existsSync('.aorc.json')) {
    err('This project already has a .aorc.json.');
    err('Use /update-agent-orchestrator in your AI TUI to update.');
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
    info(`Installing update-agent-orchestrator seed command for: ${projectName} (${orgName})`);
  } else {
    info(`Installing update-agent-orchestrator seed command for: ${projectName}`);
  }
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

  // install skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-orchestrator'),
    path.join('.agents', 'skills', 'update-agent-orchestrator'),
    replacements,
    language
  );
  ok('Installed .agents/skills/update-agent-orchestrator/');

  // install Claude command
  renderFile(
    path.join(templateDir, '.claude', 'commands', claudeSrc),
    path.join('.claude', 'commands', 'update-agent-orchestrator.md'),
    replacements
  );
  ok('Installed .claude/commands/update-agent-orchestrator.md');

  // install Gemini command
  renderFile(
    path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
    path.join('.gemini', 'commands', project, 'update-agent-orchestrator.toml'),
    replacements
  );
  ok(`Installed .gemini/commands/${project}/update-agent-orchestrator.toml`);

  // install OpenCode command
  renderFile(
    path.join(templateDir, '.opencode', 'commands', opencodeSrc),
    path.join('.opencode', 'commands', 'update-agent-orchestrator.md'),
    replacements
  );
  ok('Installed .opencode/commands/update-agent-orchestrator.md');

  // generate .aorc.json
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

  fs.writeFileSync('.aorc.json', JSON.stringify(config, null, 2) + '\n', 'utf8');
  ok('Generated .aorc.json');

  // done
  console.log('');
  ok('Project initialized successfully!');
  console.log('');
  console.log('  Next step: open this project in any AI TUI and run:');
  console.log('');
  console.log('    Claude Code / OpenCode:  /update-agent-orchestrator');
  console.log(`    Gemini CLI:              /${project}:update-agent-orchestrator`);
  console.log('    Codex CLI:               $update-agent-orchestrator');
  console.log('');
  console.log('  This will render all templates and set up the full');
  console.log('  AI collaboration infrastructure.');
  console.log('');
}

export { cmdInit };
