import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { info, ok, err } from './log.js';
import { prompt, closePrompt } from './prompt.js';
import { resolveTemplateDir } from './paths.js';
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
  console.log('  agent-infra init');
  console.log('  ================================');
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
  if (
    fs.existsSync(configPath) ||
    fs.existsSync('.airc.json') ||
    fs.existsSync(path.join('.agent-infra', 'config.json'))
  ) {
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
  closePrompt();
  if (language === 'zh') language = 'zh-CN';
  if (language !== 'en' && language !== 'zh-CN') {
    err(`Language must be 'en' or 'zh'. Got: ${language}`);
    process.exitCode = 1;
    return;
  }

  const project = projectName;
  const replacements = { project, org: orgName };

  console.log('');
  if (orgName) {
    info(`Installing update-agent-infra seed command for: ${projectName} (${orgName})`);
  } else {
    info(`Installing update-agent-infra seed command for: ${projectName}`);
  }
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

  // install skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-infra'),
    path.join('.agents', 'skills', 'update-agent-infra'),
    replacements,
    language
  );
  ok('Installed .agents/skills/update-agent-infra/');

  // install Claude command
  renderFile(
    path.join(templateDir, '.claude', 'commands', claudeSrc),
    path.join('.claude', 'commands', 'update-agent-infra.md'),
    replacements
  );
  ok('Installed .claude/commands/update-agent-infra.md');

  // install Gemini command
  renderFile(
    path.join(templateDir, '.gemini', 'commands', '_project_', geminiSrc),
    path.join('.gemini', 'commands', project, 'update-agent-infra.toml'),
    replacements
  );
  ok(`Installed .gemini/commands/${project}/update-agent-infra.toml`);

  // install OpenCode command
  renderFile(
    path.join(templateDir, '.opencode', 'commands', opencodeSrc),
    path.join('.opencode', 'commands', 'update-agent-infra.md'),
    replacements
  );
  ok('Installed .opencode/commands/update-agent-infra.md');

  // generate .agents/.airc.json
  const config = {
    project: projectName,
    org: orgName,
    language,
    templateSource: 'templates/',
    templateVersion: VERSION,
    files: structuredClone(defaults.files)
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  ok(`Generated ${configPath}`);

  // done
  console.log('');
  ok('Project initialized successfully!');
  console.log('');
  console.log('  Next step: open this project in any AI TUI and run:');
  console.log('');
  console.log('    Claude Code / OpenCode:  /update-agent-infra');
  console.log(`    Gemini CLI:              /${project}:update-agent-infra`);
  console.log('    Codex CLI:               $update-agent-infra');
  console.log('');
  console.log('  This will render all templates and set up the full');
  console.log('  AI collaboration infrastructure.');
  console.log('');
}

export { cmdInit };
