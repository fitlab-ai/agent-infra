import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { info, ok, err } from './log.js';
import { prompt, select, closePrompt } from './prompt.js';
import { resolveTemplateDir } from './paths.js';
import { renderFile, copySkillDir, KNOWN_PLATFORMS } from './render.js';
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

function parseLocalSources(input) {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ type: 'local', path: entry }));
}

async function cmdInit() {
  console.log('');
  console.log('  agent-infra init');
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

  let sandboxEngine = null;
  if (platform() === 'darwin') {
    sandboxEngine = await select(
      'Sandbox engine (macOS)',
      ['orbstack', 'colima', 'docker-desktop'],
      'orbstack'
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
    claudeSrc = 'update-agent-infra.en.md';
    geminiSrc = 'update-agent-infra.en.toml';
    opencodeSrc = 'update-agent-infra.en.md';
  }

  // install skill
  copySkillDir(
    path.join(templateDir, '.agents', 'skills', 'update-agent-infra'),
    path.join('.agents', 'skills', 'update-agent-infra'),
    replacements,
    language,
    platformType
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
    platform: { type: platformType },
    templateVersion: VERSION,
    sandbox: structuredClone(defaults.sandbox),
    labels: structuredClone(defaults.labels),
    files: structuredClone(defaults.files)
  };

  if (sandboxEngine) {
    config.sandbox.engine = sandboxEngine;
  }

  if (templateSources.length > 0) {
    config.templates = {
      sources: templateSources
    };
  }

  if (skillSources.length > 0) {
    config.skills = {
      sources: skillSources
    };
  }

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
