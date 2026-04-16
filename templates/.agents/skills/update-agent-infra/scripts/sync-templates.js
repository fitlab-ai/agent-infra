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

const INSTALLER_VERSION = "v0.5.4";
const PACKAGE_NAME = '@fitlab-ai/agent-infra';
// Add a new identifier here only after shipping matching .{platform}. template variants.
const KNOWN_PLATFORMS = new Set(['github']);
const KNOWN_LANGUAGES = new Set(['en', 'zh-CN']);

function norm(p) { return p.replace(/\\/g, '/'); }

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
  const vars = { project, org };

  const managed = [...(cfg.files.managed || [])];
  const merged  = [...(cfg.files.merged  || [])];
  const ejected = [...(cfg.files.ejected || [])];

  const report = {
    templateVersion: version,
    templateRoot: norm(templateRoot),
    registryAdded: [],
    managed: { written: [], created: [], unchanged: [], skippedMerged: [], removed: [] },
    ejected: { created: [], skipped: [] },
    merged:  { pending: [] },
    configUpdated: false,
    selfUpdate: false
  };

  const known = new Set([...managed, ...merged, ...ejected]);
  for (const e of (DEFAULTS.files.managed || [])) {
    if (!known.has(e)) { managed.push(e); known.add(e); report.registryAdded.push({ entry: e, list: 'managed' }); }
  }
  for (const e of (DEFAULTS.files.merged || [])) {
    if (!known.has(e)) { merged.push(e); known.add(e); report.registryAdded.push({ entry: e, list: 'merged' }); }
  }

  const allRels = walkDir(templateRoot).map(f => norm(path.relative(templateRoot, f)));
  const allSet = new Set(allRels);
  for (const entry of managed) {
    const isDir = entry.endsWith('/');
    let entryRels;
    const expectedTargets = isDir ? new Set() : null;

    if (isDir) {
      const dir = path.join(templateRoot, entry);
      if (!fs.existsSync(dir)) continue;
      entryRels = walkDir(dir).map(f => norm(path.relative(templateRoot, f)));
    } else {
      entryRels = [];
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

      const srcFull = path.join(templateRoot, src);
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

    const content = renderContent(fs.readFileSync(path.join(templateRoot, src), 'utf8'), vars);
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
