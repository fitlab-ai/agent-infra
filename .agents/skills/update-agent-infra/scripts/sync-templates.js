/**
 * sync-templates.js — Deterministic template sync for managed & ejected files.
 *
 * Handles SKILL steps: 2 (detect template source version), 3.0 (registry sync), 4 (managed),
 * 6 (ejected), 7 (.agents/.airc.json update).
 *
 * Merged files (step 5) are NOT handled — they require AI semantic merge.
 * The report includes `merged.pending` so the AI knows what to process.
 *
 * Usage:
 *   node .agents/skills/update-agent-infra/scripts/sync-templates.js [project-root]
 *
 * Output: JSON report to stdout.
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  "platform": {
    "type": "github"
  },
  "sandbox": {
    "runtimes": [
      "node20"
    ],
    "tools": [
      "claude-code",
      "codex",
      "opencode",
      "gemini-cli"
    ],
    "dockerfile": null,
    "vm": {
      "cpu": null,
      "memory": null,
      "disk": null
    }
  },
  "labels": {
    "in": {}
  },
  "files": {
    "managed": [
      ".agents/QUICKSTART.md",
      ".agents/README.md",
      ".agents/rules/",
      ".agents/scripts/",
      ".agents/skills/",
      ".agents/templates/",
      ".agents/workflows/",
      ".agents/workspace/README.md",
      ".claude/commands/",
      ".claude/hooks/",
      ".gemini/commands/",
      ".github/hooks/check-version-format.sh",
      ".github/scripts/",
      ".opencode/commands/"
    ],
    "merged": [
      "**/release.*",
      "**/test-integration.*",
      "**/test.*",
      "**/upgrade-dependency.*",
      ".agents/skills/release/SKILL.*",
      ".agents/skills/test-integration/SKILL.*",
      ".agents/skills/test/SKILL.*",
      ".agents/skills/upgrade-dependency/SKILL.*",
      ".claude/settings.json",
      ".gemini/settings.json",
      ".github/hooks/pre-commit",
      ".gitignore"
    ],
    "ejected": []
  }
};

const INSTALLER_VERSION = "v0.5.6";
const PACKAGE_NAME = '@fitlab-ai/agent-infra';
// Add a new identifier here only after shipping matching .{platform}. template variants.
const KNOWN_PLATFORMS = new Set(['github']);
const KNOWN_LANGUAGES = new Set(['en', 'zh-CN']);

function norm(p) { return p.replace(/\\/g, '/'); }

function normDir(p) {
  return norm(p).replace(/^\.\//, '').replace(/\/+$/, '');
}

function isInsideProject(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '' || path.isAbsolute(relativePath)) {
    return false;
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(projectRoot, relativePath);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function globMatch(pattern, filePath) {
  const p = norm(pattern), f = norm(filePath);
  const globstarDir = '__GLOBSTAR_DIR__';
  const globstar = '__GLOBSTAR__';
  const star = '__STAR__';
  const qmark = '__QMARK__';
  const re = p
    .replace(/([.+^${}()|[\]\\])/g, '\\$1')
    .replace(/\*\*\//g, globstarDir)
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, star)
    .replace(/\?/g, qmark)
    .replace(new RegExp(globstarDir, 'g'), '(?:.+/)?')
    .replace(new RegExp(globstar, 'g'), '[^/]*')
    .replace(new RegExp(star, 'g'), '[^/]*')
    .replace(new RegExp(qmark, 'g'), '[^/]');
  return new RegExp('^' + re + '$').test(f);
}

function walkDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? out.push(...walkDir(p)) : out.push(p);
  }
  return out;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name));
  }
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

function parseSkillFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const result = {};
  const lines = match[1].split(/\r?\n/);
  const normalizeValue = (value) => value.replace(/^["']|["']$/g, '').trim();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;

    const [, key, rawValue] = pair;
    if (rawValue === '>') {
      const block = [];
      for (let offset = index + 1; offset < lines.length; offset += 1) {
        const nextLine = lines[offset];
        if (!/^\s+/.test(nextLine)) break;

        block.push(nextLine.trim());
        index = offset;
      }
      result[key] = block.join(' ').trim();
      continue;
    }

    result[key] = normalizeValue(rawValue);
  }

  return result;
}

function listTemplateSkillNames(templateRoot) {
  const templateSkillsDir = path.join(templateRoot, '.agents/skills');
  if (!fs.existsSync(templateSkillsDir)) return new Set();

  return new Set(
    fs.readdirSync(templateSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  );
}

function detectCustomSkills(projectRoot, templateSkillNames) {
  const skillsDir = path.join(projectRoot, '.agents/skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !templateSkillNames.has(entry.name))
    .map((entry) => {
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) return null;

      const meta = parseSkillFrontmatter(skillMd);
      return {
        dirName: entry.name,
        name: meta.name || entry.name,
        description: meta.description || '',
        args: meta.args || null
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.dirName.localeCompare(right.dirName));
}

function isCustomProtected(targetPath, customSkills, project, customTUICommandTargets) {
  const normalized = norm(targetPath);

  return customSkills.some(({ dirName }) => (
    normalized.startsWith(`.agents/skills/${dirName}/`) ||
    normalized === `.claude/commands/${dirName}.md` ||
    normalized === `.opencode/commands/${dirName}.md` ||
    normalized === '.gemini/commands/' + project + '/' + dirName + '.toml' ||
    customTUICommandTargets.has(normalized)
  ));
}

function recordCustomTUISkipped(report, entry) {
  report?.custom?.customTUIs?.skipped?.push(entry);
}

function recordCustomTUISkippedRef(report, entry) {
  report?.custom?.customTUIs?.skippedRefs?.push(entry);
}

function expandHome(inputPath) {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

function mergeTemplateSources(baseRoot, sources, report) {
  const sourceMap = new Map();
  const sourceMeta = new Map();
  const conflictsByRel = new Map();
  const baseRels = walkDir(baseRoot).map((filePath) => norm(path.relative(baseRoot, filePath)));

  for (const rel of baseRels) {
    sourceMap.set(rel, baseRoot);
    sourceMeta.set(rel, { type: 'builtin' });
  }

  const recordConflict = (rel, winner, ignored) => {
    const existing = conflictsByRel.get(rel);
    if (existing) {
      existing.winner = winner;
      existing.ignored.push(...ignored);
      return;
    }

    const conflict = { rel, winner, ignored: [...ignored] };
    conflictsByRel.set(rel, conflict);
    report.templateSources.conflicts.push(conflict);
  };

  const templateSources = Array.isArray(sources) ? sources : [];
  for (const [index, source] of templateSources.entries()) {
    if (source?.type !== 'local') continue;
    if (typeof source.path !== 'string' || source.path.trim() === '') {
      report.templateSources.errors.push({
        index,
        type: String(source?.type || ''),
        path: String(source?.path || ''),
        reason: 'invalid path'
      });
      continue;
    }

    const srcDir = expandHome(source.path);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      report.templateSources.errors.push({
        index,
        type: source.type,
        path: source.path,
        reason: 'directory not found'
      });
      continue;
    }

    const extRels = walkDir(srcDir).map((filePath) => norm(path.relative(srcDir, filePath)));
    const sourceInfo = { type: source.type, path: source.path };
    for (const rel of extRels) {
      const existing = sourceMeta.get(rel);
      if (existing?.type === 'builtin') {
        recordConflict(rel, existing, [sourceInfo]);
        continue;
      }

      if (existing) {
        recordConflict(rel, sourceInfo, [existing]);
      }

      sourceMap.set(rel, srcDir);
      sourceMeta.set(rel, sourceInfo);
    }

    report.templateSources.loaded += 1;
    report.templateSources.files += extRels.length;
  }

  return {
    mergedRels: [...sourceMap.keys()],
    sourceMap
  };
}

function writeIfChanged(projectRoot, targetPath, content, reportBucket) {
  const fullPath = path.join(projectRoot, targetPath);
  const exists = fs.existsSync(fullPath);

  if (exists && fs.readFileSync(fullPath, 'utf8') === content) {
    reportBucket.unchanged.push(targetPath);
    return;
  }

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');

  (exists ? reportBucket.updated : reportBucket.generated).push(targetPath);
}

function syncCustomSkillSources(projectRoot, sources, report, templateSkillNames) {
  const skillsDir = path.join(projectRoot, '.agents/skills');
  const syncedSkills = new Map();

  for (const source of sources) {
    if (source?.type !== 'local') continue;
    if (typeof source.path !== 'string' || source.path.trim() === '') {
      report.custom.sourceErrors.push({ source: String(source?.path || ''), reason: 'invalid path' });
      continue;
    }

    const srcDir = expandHome(source.path);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      report.custom.sourceErrors.push({ source: source.path, reason: 'directory not found' });
      continue;
    }

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (templateSkillNames.has(entry.name)) {
        report.custom.sourceErrors.push({
          source: source.path,
          reason: `skill ${entry.name} conflicts with built-in skill`
        });
        continue;
      }

      const skillSrcDir = path.join(srcDir, entry.name);
      const skillMd = path.join(skillSrcDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const skillDstDir = path.join(skillsDir, entry.name);
      const trackedFiles = syncedSkills.get(entry.name) || new Set();
      syncedSkills.set(entry.name, trackedFiles);

      for (const srcFile of walkDir(skillSrcDir)) {
        const relPath = norm(path.relative(skillSrcDir, srcFile));
        const dstFile = path.join(skillDstDir, relPath);
        const projectPath = norm(path.relative(projectRoot, dstFile));
        const srcContent = fs.readFileSync(srcFile);
        const existed = fs.existsSync(dstFile);

        trackedFiles.add(relPath);

        if (existed) {
          const dstContent = fs.readFileSync(dstFile);
          if (srcContent.equals(dstContent)) {
            report.custom.unchanged.push(projectPath);
            continue;
          }
        }

        const dir = path.dirname(dstFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dstFile, srcContent);

        (existed ? report.custom.updated : report.custom.generated).push(projectPath);
      }
    }
  }

  return syncedSkills;
}

function cleanStaleSyncedFiles(projectRoot, syncedSkills, report) {
  const skillsDir = path.join(projectRoot, '.agents/skills');

  for (const [skillName, expectedFiles] of syncedSkills) {
    const skillDir = path.join(skillsDir, skillName);
    if (!fs.existsSync(skillDir)) continue;

    const actualFiles = walkDir(skillDir).map((filePath) => norm(path.relative(skillDir, filePath)));
    const removedBefore = report.custom.removed.length;

    for (const actualFile of actualFiles) {
      if (expectedFiles.has(actualFile)) continue;

      const staleFile = path.join(skillDir, actualFile);
      fs.unlinkSync(staleFile);
      report.custom.removed.push(norm(path.relative(projectRoot, staleFile)));
    }

    if (report.custom.removed.length > removedBefore) {
      removeEmptyDirs(skillDir);
    }
  }
}

function generateClaudeCommand(skill, lang) {
  const isZhCN = lang === 'zh-CN';
  const lines = ['---', `description: ${JSON.stringify(skill.description)}`];

  if (skill.args) {
    lines.push(`usage: ${JSON.stringify(`/${skill.dirName} ${skill.args}`)}`);
  }

  lines.push('---', '');
  lines.push(
    isZhCN
      ? `读取并执行 \`.agents/skills/${skill.dirName}/SKILL.md\` 中的 ${skill.dirName} 技能。`
      : `Read and execute the ${skill.dirName} skill from \`.agents/skills/${skill.dirName}/SKILL.md\`.`
  );
  lines.push('');
  lines.push(isZhCN ? '严格按照技能中定义的所有步骤执行。' : 'Follow all steps defined in the skill exactly.');

  return `${lines.join('\n')}\n`;
}

function generateGeminiCommand(skill, lang) {
  const isZhCN = lang === 'zh-CN';
  const promptLines = [];

  if (skill.args) {
    promptLines.push(isZhCN ? '参数：{{args}}' : 'Arguments: {{args}}');
    promptLines.push('');
  }

  promptLines.push(
    isZhCN
      ? `读取并执行 \`.agents/skills/${skill.dirName}/SKILL.md\` 中的 ${skill.dirName} 技能。`
      : `Read and execute the ${skill.dirName} skill from \`.agents/skills/${skill.dirName}/SKILL.md\`.`
  );
  promptLines.push('');
  promptLines.push(isZhCN ? '严格按照技能中定义的所有步骤执行。' : 'Follow all steps defined in the skill exactly.');

  return [
    `description = ${JSON.stringify(skill.description)}`,
    'prompt = """',
    ...promptLines,
    '"""'
  ].join('\n') + '\n';
}

function generateOpenCodeCommand(skill, lang) {
  const isZhCN = lang === 'zh-CN';
  const lines = [
    '---',
    `description: ${JSON.stringify(skill.description)}`,
    'agent: general',
    'subtask: false',
    '---',
    ''
  ];

  if (skill.args) {
    lines.push(isZhCN ? '参数：$ARGUMENTS' : 'Arguments: $ARGUMENTS');
    lines.push('');
  }

  lines.push(
    isZhCN
      ? `读取并执行 \`.agents/skills/${skill.dirName}/SKILL.md\` 中的 ${skill.dirName} 技能。`
      : `Read and execute the ${skill.dirName} skill from \`.agents/skills/${skill.dirName}/SKILL.md\`.`
  );
  lines.push('');
  lines.push(isZhCN ? '严格按照技能中定义的所有步骤执行。' : 'Follow all steps defined in the skill exactly.');

  return `${lines.join('\n')}\n`;
}

function validateCustomTUIs(projectRoot, customTUIs, report) {
  const tools = Array.isArray(customTUIs) ? customTUIs : [];
  return tools
    .map((tool, index) => {
      if (typeof tool?.dir !== 'string' || tool.dir.trim() === '') {
        recordCustomTUISkipped(report, {
          index,
          name: String(tool?.name || ''),
          dir: String(tool?.dir || ''),
          reason: 'invalid dir'
        });
        return null;
      }

      if (!isInsideProject(projectRoot, tool.dir)) {
        recordCustomTUISkipped(report, {
          index,
          name: String(tool?.name || ''),
          dir: tool.dir,
          reason: 'dir must be a relative path inside the project root'
        });
        return null;
      }

      return { ...tool, index, dir: normDir(tool.dir) };
    })
    .filter(Boolean);
}

function customTUITargetPath(tool, refFile, refSkillName, skillName) {
  const targetFile = refFile.includes(refSkillName)
    ? refFile.replaceAll(refSkillName, skillName)
    : `${skillName}${path.extname(refFile)}`;
  return norm(path.join(tool.dir, targetFile));
}

function findCustomTUIReference(projectRoot, tool, templateSkillNames, report, logSkipped = false) {
  const cmdDir = path.join(projectRoot, tool.dir);
  if (!fs.existsSync(cmdDir) || !fs.statSync(cmdDir).isDirectory()) {
    if (logSkipped) {
      recordCustomTUISkipped(report, {
        index: tool.index,
        name: String(tool.name || ''),
        dir: tool.dir,
        reason: 'directory not found'
      });
    }
    return null;
  }

  const cmdFiles = fs.readdirSync(cmdDir)
    .filter((file) => fs.statSync(path.join(cmdDir, file)).isFile())
    .sort((left, right) => left.localeCompare(right));
  if (cmdFiles.length === 0) {
    if (logSkipped) {
      recordCustomTUISkipped(report, {
        index: tool.index,
        name: String(tool.name || ''),
        dir: tool.dir,
        reason: 'no command files'
      });
    }
    return null;
  }

  let sawKnownSkillReference = false;

  for (const file of cmdFiles) {
    const content = fs.readFileSync(path.join(cmdDir, file), 'utf8');
    const match = content.match(/\.agents\/skills\/([^/]+)\/SKILL\.md/);
    if (!match) continue;

    const skillName = match[1];
    if (!templateSkillNames.has(skillName)) continue;

    const skillMd = path.join(projectRoot, '.agents/skills', skillName, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const meta = parseSkillFrontmatter(skillMd);
    if (!meta.description) continue;

    sawKnownSkillReference = true;
    if (!content.includes(meta.description)) {
      if (logSkipped) {
        recordCustomTUISkippedRef(report, {
          index: tool.index,
          name: String(tool.name || ''),
          dir: tool.dir,
          file,
          skill: skillName,
          reason: 'description not found in reference command file'
        });
      }
      continue;
    }

    return { content, file, skillName, skillDesc: meta.description };
  }

  if (logSkipped) {
    recordCustomTUISkipped(report, {
      index: tool.index,
      name: String(tool.name || ''),
      dir: tool.dir,
      reason: sawKnownSkillReference
        ? 'no reference command file with matching description'
        : 'no usable reference command file'
    });
  }

  return null;
}

function buildCustomTUICommandTargets(projectRoot, customSkills, customTUIs, templateSkillNames) {
  const targets = new Set();
  for (const tool of customTUIs) {
    const ref = findCustomTUIReference(projectRoot, tool, templateSkillNames, null, false);
    if (!ref) continue;

    for (const skill of customSkills) {
      targets.add(customTUITargetPath(tool, ref.file, ref.skillName, skill.dirName));
    }
  }

  return targets;
}

function learnAndGenerateCommands(projectRoot, customSkills, tool, templateSkillNames, report) {
  const ref = findCustomTUIReference(projectRoot, tool, templateSkillNames, report, true);
  if (!ref) return;

  for (const skill of customSkills) {
    const descToken = '__AGENT_INFRA_CUSTOM_SKILL_DESCRIPTION__';
    const generated = ref.content
      .replaceAll(ref.skillDesc, descToken)
      .replaceAll(ref.skillName, skill.dirName)
      .replaceAll(descToken, skill.description);

    writeIfChanged(
      projectRoot,
      customTUITargetPath(tool, ref.file, ref.skillName, skill.dirName),
      generated,
      report.custom.commands
    );
  }
}

function generateCustomCommands(projectRoot, customSkills, project, lang, report, customTUIs, templateSkillNames) {
  for (const skill of customSkills) {
    writeIfChanged(
      projectRoot,
      `.claude/commands/${skill.dirName}.md`,
      generateClaudeCommand(skill, lang),
      report.custom.commands
    );
    writeIfChanged(
      projectRoot,
      '.gemini/commands/' + project + '/' + skill.dirName + '.toml',
      generateGeminiCommand(skill, lang),
      report.custom.commands
    );
    writeIfChanged(
      projectRoot,
      `.opencode/commands/${skill.dirName}.md`,
      generateOpenCodeCommand(skill, lang),
      report.custom.commands
    );
  }

  const tools = Array.isArray(customTUIs) ? customTUIs : [];
  for (const tool of tools) {
    learnAndGenerateCommands(projectRoot, customSkills, tool, templateSkillNames, report);
  }
}

function matchesAny(rel, patterns) {
  const n = norm(rel);
  return patterns.some(p => norm(p) === n || globMatch(p, n));
}

function renderContent(text, vars) {
  return text
    .replace(/\{\{project\}\}/g, vars.project)
    .replace(/\{\{org\}\}/g, vars.org);
}

function renderPathname(p, project) {
  return p.replace(/_project_/g, project);
}

function variantExt(relativePath) {
  return path.extname(relativePath);
}

function variantBase(relativePath) {
  const ext = variantExt(relativePath);
  return relativePath.slice(0, -ext.length);
}

function withVariant(relativePath, variant) {
  const ext = variantExt(relativePath);
  const base = variantBase(relativePath);
  return `${base}.${variant}${ext}`;
}

function stripVariant(relativePath, variant) {
  return relativePath.replace(new RegExp(`\\.${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), '.');
}

function isPlatformVariant(relativePath, platform) {
  const platforms = new Set([...KNOWN_PLATFORMS, platform]);
  for (const candidate of platforms) {
    if (relativePath.includes(`.${candidate}.`)) {
      return true;
    }
  }
  return false;
}

function isLangVariant(relativePath) {
  for (const lang of KNOWN_LANGUAGES) {
    if (relativePath.includes(`.${lang}.`)) {
      return true;
    }
  }
  return false;
}

function stripLangVariant(relativePath) {
  for (const lang of KNOWN_LANGUAGES) {
    if (relativePath.includes(`.${lang}.`)) {
      return stripVariant(relativePath, lang);
    }
  }
  return relativePath;
}

function isTemplateDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function verifyPackageDir(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { templateRoot: null, reason: `package.json not found at ${pkgPath}` };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { templateRoot: null, reason: `invalid package.json at ${pkgPath}` };
  }

  if (pkg.name !== PACKAGE_NAME) {
    const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : 'an unknown package';
    return { templateRoot: null, reason: `${pkgPath} belongs to ${packageName}` };
  }

  const templateRoot = path.join(dir, 'templates');
  if (!isTemplateDir(templateRoot)) {
    return { templateRoot: null, reason: `templates/ not found at ${templateRoot}` };
  }

  return { templateRoot, reason: null };
}

function resolveUnixTemplateRoot(name) {
  let linkPath;
  try {
    linkPath = childProcess.execSync(`command -v ${name}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return { templateRoot: null, reason: 'not found in PATH' };
  }

  if (!linkPath) {
    return { templateRoot: null, reason: 'not found in PATH' };
  }

  let realPath;
  try {
    realPath = fs.realpathSync(linkPath);
  } catch {
    return { templateRoot: null, reason: `cannot resolve symlink target for ${linkPath}` };
  }

  let dir = path.dirname(realPath);
  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return verifyPackageDir(dir);
    }

    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }
    dir = parentDir;
  }

  return { templateRoot: null, reason: `no package.json found above ${realPath}` };
}

function resolveWindowsTemplateRoot(name) {
  let output;
  try {
    output = childProcess.execSync(`where ${name}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return { templateRoot: null, reason: 'not found in PATH' };
  }

  const wrapperPaths = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (wrapperPaths.length === 0) {
    return { templateRoot: null, reason: 'not found in PATH' };
  }

  const wrapperPath = wrapperPaths.find(line => /\.cmd$/i.test(line)) || wrapperPaths[0];
  const packageDir = path.join(path.dirname(wrapperPath), 'node_modules', '@fitlab-ai', 'agent-infra');
  return verifyPackageDir(packageDir);
}

function resolveTemplateRoot() {
  const resolver = process.platform === 'win32'
    ? resolveWindowsTemplateRoot
    : resolveUnixTemplateRoot;
  const errors = [];

  for (const name of ['ai', 'agent-infra']) {
    const result = resolver(name);
    if (result.templateRoot) {
      return result.templateRoot;
    }
    errors.push({ name, reason: result.reason });
  }

  return { templateRoot: null, errors };
}

function isBinary(fp) {
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(8192);
  const n = fs.readSync(fd, buf, 0, 8192, 0);
  fs.closeSync(fd);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function gitUrl(dir) {
  try {
    return childProcess.execSync('git remote get-url origin', {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch { return null; }
}

function langSelect(rels, lang, allSet, project) {
  const sel = new Map();

  for (const r of rels) {
    if (r.includes(`.${lang}.`)) {
      const target = norm(renderPathname(stripVariant(r, lang), project));
      sel.set(target, r);
    } else if (!isLangVariant(r)) {
      const target = norm(renderPathname(r, project));
      if (!sel.has(target)) {
        sel.set(target, r);
      }
    }
  }

  return sel;
}

function platformSelect(entries, platform, project) {
  const sel = new Map();

  for (const [target, src] of entries) {
    if (!target.includes(`.${platform}.`)) continue;
    sel.set(norm(renderPathname(stripVariant(target, platform), project)), src);
  }

  for (const [target, src] of entries) {
    const normalizedTarget = norm(renderPathname(target, project));
    if (sel.has(normalizedTarget)) continue;
    if (isPlatformVariant(target, platform)) continue;
    sel.set(normalizedTarget, src);
  }

  return sel;
}

function entryVariantRels(entry, allSet, platform) {
  const rels = [];
  const normalized = norm(entry);
  const candidates = [
    normalized,
    withVariant(normalized, 'en'),
    withVariant(normalized, 'zh-CN'),
    withVariant(normalized, platform),
    withVariant(withVariant(normalized, platform), 'en'),
    withVariant(withVariant(normalized, platform), 'zh-CN')
  ];

  for (const candidate of candidates) {
    if (allSet.has(candidate) && !rels.includes(candidate)) {
      rels.push(candidate);
    }
  }

  return rels;
}

function syncTemplates(projectRoot, templateRootOverride) {
  const configDir = path.join(projectRoot, '.agents');
  const cfgPath = path.join(configDir, '.airc.json');

  if (!fs.existsSync(cfgPath)) {
    return { error: 'No .agents/.airc.json in project root.' };
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const configPathRel = norm(path.relative(projectRoot, cfgPath));
  let templateRoot = templateRootOverride;
  if (!templateRoot) {
    const resolvedTemplateRoot = resolveTemplateRoot();
    if (typeof resolvedTemplateRoot === 'string') {
      templateRoot = resolvedTemplateRoot;
    } else {
      const details = resolvedTemplateRoot.errors
        .map(({ name, reason }) => `  - ${name}: ${reason}`)
        .join('\n');
      return {
        error: [
          'Template source not found.',
          '',
          'Attempted binary lookups:',
          details,
          '',
          'Please ensure agent-infra is installed and available on PATH.',
          'If already installed, upgrade to the latest version or reinstall:',
          '  npm install -g @fitlab-ai/agent-infra',
          '  brew upgrade fitlab-ai/agent-infra/agent-infra || brew install fitlab-ai/agent-infra/agent-infra'
        ].join('\n')
      };
    }
  }
  const version = INSTALLER_VERSION;
  const hadTemplateSource = Object.prototype.hasOwnProperty.call(cfg, 'templateSource');

  const { project, org, language: lang = 'en' } = cfg;
  const platformType = cfg.platform?.type || DEFAULTS.platform.type;
  const customTUIsConfig = Array.isArray(cfg.customTUIs) ? cfg.customTUIs : [];
  const vars = { project, org };
  const templateSkillNames = listTemplateSkillNames(templateRoot);
  const protectedCustomSkills = detectCustomSkills(projectRoot, templateSkillNames);

  const managed = [...(cfg.files.managed || [])];
  const merged  = [...(cfg.files.merged  || [])];
  const ejected = [...(cfg.files.ejected || [])];

  const report = {
    templateVersion: version,
    templateRoot: norm(templateRoot),
    registryAdded: [],
    templateSources: {
      configured: 0,
      loaded: 0,
      files: 0,
      errors: [],
      conflicts: []
    },
    managed: { written: [], created: [], unchanged: [], skippedMerged: [], removed: [] },
    custom: {
      detected: [],
      generated: [],
      updated: [],
      unchanged: [],
      removed: [],
      sourceErrors: [],
      customTUIs: { skipped: [], skippedRefs: [] },
      commands: { generated: [], updated: [], unchanged: [] }
    },
    ejected: { created: [], skipped: [] },
    merged:  { pending: [] },
    configUpdated: false,
    selfUpdate: false
  };
  const customTUIs = validateCustomTUIs(projectRoot, customTUIsConfig, report);
  const customTUICommandTargets = buildCustomTUICommandTargets(
    projectRoot,
    protectedCustomSkills,
    customTUIs,
    templateSkillNames
  );

  const known = new Set([...managed, ...merged, ...ejected]);
  for (const e of (DEFAULTS.files.managed || [])) {
    if (!known.has(e)) { managed.push(e); known.add(e); report.registryAdded.push({ entry: e, list: 'managed' }); }
  }
  for (const e of (DEFAULTS.files.merged || [])) {
    if (!known.has(e)) { merged.push(e); known.add(e); report.registryAdded.push({ entry: e, list: 'merged' }); }
  }

  const templateSources = Array.isArray(cfg.templates?.sources) ? cfg.templates.sources : [];
  report.templateSources.configured = templateSources.length;
  const { mergedRels, sourceMap } = mergeTemplateSources(templateRoot, templateSources, report);
  const allRels = mergedRels;
  const allSet = new Set(allRels);
  for (const entry of managed) {
    const isDir = entry.endsWith('/');
    let entryRels;
    const expectedTargets = isDir ? new Set() : null;

    if (isDir) {
      const dir = path.join(templateRoot, entry);
      const builtinRels = fs.existsSync(dir)
        ? walkDir(dir).map((filePath) => norm(path.relative(templateRoot, filePath)))
        : [];
      const prefix = norm(entry);
      const externalRels = allRels.filter((rel) => rel.startsWith(prefix) && !builtinRels.includes(rel));
      entryRels = [...builtinRels, ...externalRels];
      if (!entryRels.length) continue;
    } else {
      entryRels = entryVariantRels(entry, allSet, platformType);
      if (!entryRels.length) continue;
    }

    const selected = platformSelect(langSelect(entryRels, lang, allSet, project), platformType, project);

    for (const [tgt, src] of selected) {
      if (expectedTargets) expectedTargets.add(tgt);

      if (matchesAny(tgt, merged) || matchesAny(tgt, ejected)) {
        report.managed.skippedMerged.push(tgt);
        continue;
      }

      const srcRoot = sourceMap.get(src) || templateRoot;
      const srcFull = path.join(srcRoot, src);
      const dstFull = path.join(projectRoot, tgt);
      const bin = isBinary(srcFull);
      const content = bin
        ? fs.readFileSync(srcFull)
        : renderContent(fs.readFileSync(srcFull, 'utf8'), vars);

      const exists = fs.existsSync(dstFull);
      if (exists) {
        const cur = bin ? fs.readFileSync(dstFull) : fs.readFileSync(dstFull, 'utf8');
        if (bin ? content.equals(cur) : content === cur) {
          report.managed.unchanged.push(tgt);
          continue;
        }
      }

      const dir = path.dirname(dstFull);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dstFull, content);
      if (tgt.endsWith('.sh')) {
        try { fs.chmodSync(dstFull, 0o755); } catch { /* Windows */ }
      }

      (exists ? report.managed.written : report.managed.created).push(tgt);
    }

    if (isDir) {
      const projDir = path.join(projectRoot, entry);
      if (fs.existsSync(projDir)) {
        const removedBefore = report.managed.removed.length;
        const projFiles = walkDir(projDir).map(f => norm(path.relative(projectRoot, f)));
        for (const projFile of projFiles) {
          if (expectedTargets.has(projFile)) continue;
          if (projFile === configPathRel) continue;
          if (isCustomProtected(projFile, protectedCustomSkills, project, customTUICommandTargets)) continue;
          if (matchesAny(projFile, merged) || matchesAny(projFile, ejected)) continue;

          fs.unlinkSync(path.join(projectRoot, projFile));
          report.managed.removed.push(projFile);
        }
        if (report.managed.removed.length > removedBefore) {
          removeEmptyDirs(projDir);
        }
      }
    }
  }

  const sources = Array.isArray(cfg.skills?.sources) ? cfg.skills.sources : [];
  if (sources.length > 0) {
    const syncedSkills = syncCustomSkillSources(projectRoot, sources, report, templateSkillNames);
    cleanStaleSyncedFiles(projectRoot, syncedSkills, report);
  }

  const customSkills = detectCustomSkills(projectRoot, templateSkillNames);
  report.custom.detected = customSkills.map((skill) => skill.dirName);
  generateCustomCommands(projectRoot, customSkills, project, lang, report, customTUIs, templateSkillNames);

  for (const entry of ejected) {
    const dstFull = path.join(projectRoot, entry);
    if (fs.existsSync(dstFull)) {
      report.ejected.skipped.push(entry);
      continue;
    }

    const selected = platformSelect(langSelect(entryVariantRels(entry, allSet, platformType), lang, allSet, project), platformType, project);
    const target = norm(renderPathname(entry, project));
    const src = selected.get(target);
    if (!src) continue;

    const srcRoot = sourceMap.get(src) || templateRoot;
    const content = renderContent(fs.readFileSync(path.join(srcRoot, src), 'utf8'), vars);
    const dir = path.dirname(dstFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dstFull, content);
    report.ejected.created.push(entry);
  }

  const mergedMap = new Map();
  for (const entry of merged) {
    if (entry.includes('*')) {
      const hits = allRels.filter(r => {
        const t = norm(renderPathname(stripLangVariant(r), project));
        return globMatch(entry, t);
      });
      for (const [t, s] of platformSelect(langSelect(hits, lang, allSet, project), platformType, project)) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    } else {
      const rels = entryVariantRels(entry, allSet, platformType);
      const selected = platformSelect(langSelect(rels, lang, allSet, project), platformType, project);
      for (const [t, s] of selected) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    }
  }
  report.merged.pending = [...mergedMap].map(
    ([target, template]) => ({ target, template })
  );

  const projUrl = gitUrl(projectRoot);
  report.selfUpdate = !!(projUrl && /fitlab-ai\/agent-infra/.test(projUrl));

  const hasChanges = (
    report.managed.written.length +
    report.managed.created.length +
    report.managed.removed.length +
    report.custom.generated.length +
    report.custom.updated.length +
    report.custom.removed.length +
    report.custom.commands.generated.length +
    report.custom.commands.updated.length +
    report.ejected.created.length +
    report.registryAdded.length
  ) > 0;

  const prevVersion = cfg.templateVersion;

  cfg.files.managed = managed;
  cfg.files.merged  = merged;
  cfg.files.ejected = ejected;
  cfg.templateVersion = version;
  delete cfg.templateSource;

  report.configUpdated = hasChanges || prevVersion !== version || hadTemplateSource;

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  return report;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const result = syncTemplates(root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) process.exitCode = 1;
}

export { syncTemplates };
