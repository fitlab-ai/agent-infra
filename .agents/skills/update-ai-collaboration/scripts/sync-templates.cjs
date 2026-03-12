#!/usr/bin/env node
/**
 * sync-templates.cjs — Deterministic template sync for managed & ejected files.
 *
 * Handles SKILL steps: 2 (git pull), 3.0 (registry sync), 4 (managed),
 * 6 (ejected), 7 (collaborator.json update).
 *
 * Merged files (step 5) are NOT handled — they require AI semantic merge.
 * The report includes `merged.pending` so the AI knows what to process.
 *
 * Usage:
 *   node .agents/skills/update-ai-collaboration/scripts/sync-templates.cjs [project-root]
 *
 * Output: JSON report to stdout.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

function findInstallerRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'lib', 'paths.js'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const homeInstall = path.join(os.homedir(), '.ai-collaboration-installer');
  if (
    fs.existsSync(path.join(homeInstall, 'package.json')) &&
    fs.existsSync(path.join(homeInstall, 'lib', 'paths.js'))
  ) {
    return homeInstall;
  }

  return null;
}

const installerRoot = findInstallerRoot(__dirname);
if (!installerRoot) {
  throw new Error('Unable to locate ai-collaboration-installer shared modules.');
}

const { resolveTemplateDir, resolveInstallDir } = require(path.join(installerRoot, 'lib', 'paths.js'));
const versionPath = path.join(installerRoot, 'lib', 'version.js');
const defaultsPath = path.join(installerRoot, 'lib', 'defaults.json');

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Normalize path separators to forward slash (cross-platform) */
function norm(p) { return p.replace(/\\/g, '/'); }

/**
 * Glob matcher for patterns in collaborator.json.
 * Supports: *, **, ?
 */
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

/** Recursively list all files under a directory */
function walkDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? out.push(...walkDir(p)) : out.push(p);
  }
  return out;
}

/** Check if relPath matches any entry in patterns (exact or glob) */
function matchesAny(rel, patterns) {
  const n = norm(rel);
  return patterns.some(p => norm(p) === n || globMatch(p, n));
}

/** Replace project and org placeholders in text */
function renderContent(text, vars) {
  return text
    .replace(/\{\{project\}\}/g, vars.project)
    .replace(/\{\{org\}\}/g, vars.org);
}

/** Replace _project_ in file/dir names */
function renderPathname(p, project) {
  return p.replace(/_project_/g, project);
}

/** Resolve template root from collaborator.json.templateSource */
function resolveProjectTemplateDir(projectRoot, templateSource) {
  const fallbackRoot = resolveTemplateDir();

  const candidates = [];
  if (templateSource) {
    if (path.isAbsolute(templateSource)) {
      candidates.push(templateSource);
    } else {
      if (fallbackRoot) {
        candidates.push(path.resolve(path.dirname(fallbackRoot), templateSource));
      }
      candidates.push(path.resolve(projectRoot, templateSource));
    }
  }
  if (fallbackRoot) {
    candidates.push(fallbackRoot);
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep scanning until a valid directory is found.
    }
  }

  return null;
}

/** Heuristic: binary if null byte found in first 8KB */
function isBinary(fp) {
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(8192);
  const n = fs.readSync(fd, buf, 0, 8192, 0);
  fs.closeSync(fd);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Map file path → module name (for module filtering) */
function fileModule(rel) {
  const p = norm(rel);
  if (p.startsWith('.github/')) return 'github';
  if (p.startsWith('.agents/') || p.startsWith('.claude/') ||
      p.startsWith('.gemini/') || p.startsWith('.opencode/') ||
      p.startsWith('.codex/') || p === 'AGENTS.md') return 'ai';
  return null; // common — always included
}

/** Get git remote origin URL, or null */
function gitUrl(dir) {
  try {
    return execSync('git remote get-url origin', {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch { return null; }
}

function readDefaults() {
  if (!fs.existsSync(defaultsPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
}

function readVersion() {
  try {
    return require(versionPath).VERSION;
  } catch {
    return null;
  }
}

// ─── Language selection ───────────────────────────────────────────────────

/**
 * Given template-relative paths, return Map<targetRel, templateRel>
 * with the correct language variant for each unique target.
 */
function langSelect(rels, lang, allSet, project) {
  const sel = new Map();

  if (lang === 'zh-CN') {
    // Pass 1: collect zh-CN variants (highest priority)
    for (const r of rels) {
      if (!r.includes('.zh-CN.')) continue;
      const target = norm(renderPathname(r.replace(/\.zh-CN\./, '.'), project));
      sel.set(target, r);
    }
    // Pass 2: fill in English-only (no zh-CN counterpart)
    for (const r of rels) {
      if (r.includes('.zh-CN.')) continue;
      const target = norm(renderPathname(r, project));
      if (sel.has(target)) continue; // zh-CN already chosen
      const ext = path.extname(r), base = r.slice(0, -ext.length);
      if (allSet.has(norm(base + '.zh-CN' + ext))) continue; // zh-CN exists elsewhere
      sel.set(target, r);
    }
  } else {
    // en: skip all zh-CN files
    for (const r of rels) {
      if (r.includes('.zh-CN.')) continue;
      sel.set(norm(renderPathname(r, project)), r);
    }
  }

  return sel;
}

// ─── Core ─────────────────────────────────────────────────────────────────

function syncTemplates(projectRoot) {
  // ── Step 1: read config ───────────────────────────────────────────────
  const cfgPath = path.join(projectRoot, 'collaborator.json');
  if (!fs.existsSync(cfgPath)) {
    return { error: 'No collaborator.json in project root.' };
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const templateRoot = resolveProjectTemplateDir(projectRoot, cfg.templateSource);
  if (!templateRoot) {
    return { error: 'Template source not found. Install: curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh' };
  }
  const installDir = resolveInstallDir();

  // ── Step 2: git pull + SHA ────────────────────────────────────────────
  const hasGit = fs.existsSync(path.join(installDir, '.git'));
  if (hasGit) {
    try { execSync('git pull --quiet', { cwd: installDir, stdio: 'pipe' }); } catch { /* network */ }
  }

  let sha = 'unknown';
  if (hasGit) {
    try {
      sha = execSync('git rev-parse --short HEAD', {
        cwd: installDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch { /* ignore */ }
  } else {
    sha = readVersion() || sha;
  }

  const { project, org, language: lang = 'en', modules = [] } = cfg;
  const vars = { project, org };

  const managed = [...(cfg.files.managed || [])];
  const merged  = [...(cfg.files.merged  || [])];
  const ejected = [...(cfg.files.ejected || [])];

  const report = {
    templateSha: sha,
    templateRoot: norm(templateRoot),
    registryAdded: [],
    managed: { written: [], created: [], unchanged: [], skippedMerged: [], skippedModule: [] },
    ejected: { created: [], skipped: [] },
    merged:  { pending: [] },
    configUpdated: false,
    selfUpdate: false
  };

  // ── Step 3.0: registry sync ───────────────────────────────────────────
  const defs = readDefaults();
  if (defs) {
    const known = new Set([...managed, ...merged, ...ejected]);
    for (const e of (defs.files.managed || [])) {
      if (!known.has(e)) { managed.push(e); known.add(e); report.registryAdded.push({ entry: e, list: 'managed' }); }
    }
    for (const e of (defs.files.merged || [])) {
      if (!known.has(e)) { merged.push(e); known.add(e); report.registryAdded.push({ entry: e, list: 'merged' }); }
    }
  }

  // ── Build template file index ─────────────────────────────────────────
  const allRels = walkDir(templateRoot).map(f => norm(path.relative(templateRoot, f)));
  const allSet = new Set(allRels);
  const modSet = new Set(modules);

  // ── Step 4: process managed files ─────────────────────────────────────
  for (const entry of managed) {
    const isDir = entry.endsWith('/');
    let entryRels;

    if (isDir) {
      const dir = path.join(templateRoot, entry);
      if (!fs.existsSync(dir)) continue;
      entryRels = walkDir(dir).map(f => norm(path.relative(templateRoot, f)));
    } else {
      // Single file: collect it + possible zh-CN variant
      entryRels = [];
      const n = norm(entry);
      if (allSet.has(n)) entryRels.push(n);
      const ext = path.extname(entry), base = entry.slice(0, -ext.length);
      const zh = norm(base + '.zh-CN' + ext);
      if (allSet.has(zh)) entryRels.push(zh);
      if (!entryRels.length) continue;
    }

    for (const [tgt, src] of langSelect(entryRels, lang, allSet, project)) {
      // Module filter
      const mod = fileModule(tgt);
      if (mod !== null && !modSet.has(mod)) {
        report.managed.skippedModule.push(tgt);
        continue;
      }

      // 4.0: exclude merged / ejected
      if (matchesAny(tgt, merged) || matchesAny(tgt, ejected)) {
        report.managed.skippedMerged.push(tgt);
        continue;
      }

      // Read template, render placeholders
      const srcFull = path.join(templateRoot, src);
      const dstFull = path.join(projectRoot, tgt);
      const bin = isBinary(srcFull);
      const content = bin
        ? fs.readFileSync(srcFull)
        : renderContent(fs.readFileSync(srcFull, 'utf8'), vars);

      // Compare with existing
      const exists = fs.existsSync(dstFull);
      if (exists) {
        const cur = bin ? fs.readFileSync(dstFull) : fs.readFileSync(dstFull, 'utf8');
        if (bin ? content.equals(cur) : content === cur) {
          report.managed.unchanged.push(tgt);
          continue;
        }
      }

      // Write
      const dir = path.dirname(dstFull);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dstFull, content);
      if (tgt.endsWith('.sh')) {
        try { fs.chmodSync(dstFull, 0o755); } catch { /* Windows */ }
      }

      (exists ? report.managed.written : report.managed.created).push(tgt);
    }
  }

  // ── Step 6: process ejected files ─────────────────────────────────────
  for (const entry of ejected) {
    const dstFull = path.join(projectRoot, entry);
    if (fs.existsSync(dstFull)) {
      report.ejected.skipped.push(entry);
      continue;
    }

    // First-time: render from template (with language selection)
    let src = norm(entry);
    if (lang === 'zh-CN') {
      const ext = path.extname(entry), base = entry.slice(0, -ext.length);
      const zh = norm(base + '.zh-CN' + ext);
      if (allSet.has(zh)) src = zh;
    }
    if (!allSet.has(src)) continue;

    const content = renderContent(fs.readFileSync(path.join(templateRoot, src), 'utf8'), vars);
    const dir = path.dirname(dstFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dstFull, content);
    report.ejected.created.push(entry);
  }

  // ── Enumerate merged files for AI ─────────────────────────────────────
  const mergedMap = new Map();
  for (const entry of merged) {
    if (entry.includes('*')) {
      // Glob: find matching template files
      const hits = allRels.filter(r => {
        const t = norm(renderPathname(
          r.includes('.zh-CN.') ? r.replace(/\.zh-CN\./, '.') : r, project
        ));
        return globMatch(entry, t);
      });
      for (const [t, s] of langSelect(hits, lang, allSet, project)) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    } else {
      // Exact path
      const rels = [];
      const n = norm(entry);
      if (allSet.has(n)) rels.push(n);
      const ext = path.extname(entry), base = entry.slice(0, -ext.length);
      const zh = norm(base + '.zh-CN' + ext);
      if (allSet.has(zh)) rels.push(zh);
      for (const [t, s] of langSelect(rels, lang, allSet, project)) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    }
  }
  report.merged.pending = [...mergedMap].map(
    ([target, template]) => ({ target, template })
  );

  // ── Step 7: update collaborator.json ──────────────────────────────────
  const projUrl = gitUrl(projectRoot);
  const instUrl = gitUrl(installDir);
  report.selfUpdate = !!(projUrl && instUrl && projUrl === instUrl);

  const hasChanges = (
    report.managed.written.length +
    report.managed.created.length +
    report.ejected.created.length +
    report.registryAdded.length
  ) > 0;

  cfg.files.managed = managed;
  cfg.files.merged  = merged;
  cfg.files.ejected = ejected;

  if (!report.selfUpdate || hasChanges) {
    cfg.templateVersion = sha;
    report.configUpdated = true;
  }

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  return report;
}

// ─── CLI entry ────────────────────────────────────────────────────────────

if (require.main === module) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const result = syncTemplates(root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) process.exitCode = 1;
}

module.exports = { syncTemplates };
