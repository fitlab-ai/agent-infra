#!/usr/bin/env node
/**
 * sync-templates.js — Deterministic template sync for managed & ejected files.
 *
 * Handles SKILL steps: 2 (git pull), 3.0 (registry sync), 4 (managed),
 * 6 (ejected), 7 (collaborator.json update).
 *
 * Merged files (step 5) are NOT handled — they require AI semantic merge.
 * The report includes `merged.pending` so the AI knows what to process.
 *
 * Usage:
 *   node .agents/skills/update-ai-collaboration/scripts/sync-templates.js [project-root]
 *
 * Output: JSON report to stdout.
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep these helpers aligned with lib/paths.js for clone installs.
function resolveInstallDir() {
  return path.join(os.homedir(), '.ai-collaboration-installer');
}

function resolveTemplateDir() {
  const clonePath = path.join(resolveInstallDir(), 'templates');
  if (fs.existsSync(clonePath)) {
    return clonePath;
  }

  return null;
}

const DEFAULTS = JSON.parse(
  fs.readFileSync(new URL('../lib/defaults.json', import.meta.url), 'utf8')
);

const INSTALLER_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

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

function isBinary(fp) {
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(8192);
  const n = fs.readSync(fd, buf, 0, 8192, 0);
  fs.closeSync(fd);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function fileModule(rel) {
  const p = norm(rel);
  if (p.startsWith('.github/')) return 'github';
  if (p.startsWith('.agents/') || p.startsWith('.claude/') ||
      p.startsWith('.gemini/') || p.startsWith('.opencode/') ||
      p.startsWith('.codex/') || p === 'AGENTS.md') return 'ai';
  return null;
}

function gitUrl(dir) {
  try {
    return childProcess.execSync('git remote get-url origin', {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch { return null; }
}

// Public-facing docs should keep all available language variants in sync.
const MULTI_LANG = new Set(['SECURITY.md']);

function langSelect(rels, lang, allSet, project) {
  const sel = new Map();

  if (lang === 'zh-CN') {
    for (const r of rels) {
      if (!r.includes('.zh-CN.')) continue;
      const target = norm(renderPathname(r.replace(/\.zh-CN\./, '.'), project));
      sel.set(target, r);
    }
    for (const r of rels) {
      if (r.includes('.zh-CN.')) continue;
      const target = norm(renderPathname(r, project));
      if (sel.has(target)) continue;
      const ext = path.extname(r), base = r.slice(0, -ext.length);
      if (allSet.has(norm(base + '.zh-CN' + ext))) continue;
      sel.set(target, r);
    }
  } else {
    for (const r of rels) {
      if (r.includes('.zh-CN.')) continue;
      sel.set(norm(renderPathname(r, project)), r);
    }
  }

  return sel;
}

function syncTemplates(projectRoot) {
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

  const hasGit = fs.existsSync(path.join(installDir, '.git'));
  if (hasGit) {
    try { childProcess.execSync('git pull --rebase --quiet', { cwd: installDir, stdio: 'pipe' }); } catch { /* network */ }
  }

  let sha = 'unknown';
  if (hasGit) {
    try {
      sha = childProcess.execSync('git rev-parse --short HEAD', {
        cwd: installDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch { /* ignore */ }
  } else {
    sha = INSTALLER_VERSION || sha;
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
    managed: { written: [], created: [], unchanged: [], skippedMerged: [], skippedModule: [], removed: [] },
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
  const modSet = new Set(modules);

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
      const n = norm(entry);
      if (allSet.has(n)) entryRels.push(n);
      const ext = path.extname(entry), base = entry.slice(0, -ext.length);
      const zh = norm(base + '.zh-CN' + ext);
      if (allSet.has(zh)) entryRels.push(zh);
      if (!entryRels.length) continue;
    }

    const selected = MULTI_LANG.has(norm(entry))
      ? entryRels.map(r => [norm(renderPathname(r, project)), r])
      : langSelect(entryRels, lang, allSet, project);

    for (const [tgt, src] of selected) {
      if (expectedTargets) expectedTargets.add(tgt);

      const mod = fileModule(tgt);
      if (mod !== null && !modSet.has(mod)) {
        report.managed.skippedModule.push(tgt);
        continue;
      }

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
          if (matchesAny(projFile, merged) || matchesAny(projFile, ejected)) continue;

          const mod = fileModule(projFile);
          if (mod !== null && !modSet.has(mod)) continue;

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

  const mergedMap = new Map();
  for (const entry of merged) {
    if (entry.includes('*')) {
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
      const rels = [];
      const n = norm(entry);
      if (allSet.has(n)) rels.push(n);
      const ext = path.extname(entry), base = entry.slice(0, -ext.length);
      const zh = norm(base + '.zh-CN' + ext);
      if (allSet.has(zh)) rels.push(zh);
      const selected = MULTI_LANG.has(n)
        ? rels.map(r => [norm(renderPathname(r, project)), r])
        : langSelect(rels, lang, allSet, project);
      for (const [t, s] of selected) {
        if (!mergedMap.has(t)) mergedMap.set(t, s);
      }
    }
  }
  report.merged.pending = [...mergedMap].map(
    ([target, template]) => ({ target, template })
  );

  const projUrl = gitUrl(projectRoot);
  const instUrl = gitUrl(installDir);
  report.selfUpdate = !!(projUrl && instUrl && projUrl === instUrl);

  const hasChanges = (
    report.managed.written.length +
    report.managed.created.length +
    report.managed.removed.length +
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

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const result = syncTemplates(root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.error) process.exitCode = 1;
}

export { syncTemplates };
