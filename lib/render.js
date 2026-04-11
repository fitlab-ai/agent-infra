import fs from 'node:fs';
import path from 'node:path';

// Add a new identifier here only after shipping matching .{platform}. template variants.
const KNOWN_PLATFORMS = new Set(['github']);
const KNOWN_LANGUAGES = new Set(['en', 'zh-CN']);

function renderFile(src, dst, replacements) {
  if (!fs.existsSync(src)) {
    throw new Error(`Template file not found: ${src}`);
  }

  let content = fs.readFileSync(src, 'utf8');
  content = content
    .replace(/\{\{project\}\}/g, replacements.project)
    .replace(/\{\{org\}\}/g, replacements.org || '');

  const dir = path.dirname(dst);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dst, content, 'utf8');
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) {
    throw new Error(`Template file not found: ${src}`);
  }

  const dir = path.dirname(dst);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dst);

  try {
    fs.chmodSync(dst, fs.statSync(src).mode);
  } catch {
    // Ignore permission sync failures on unsupported filesystems.
  }
}

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath));
    } else {
      results.push(entryPath);
    }
  }
  return results;
}

function containsPlaceholders(src) {
  const content = fs.readFileSync(src, 'utf8');
  return content.includes('{{project}}') || content.includes('{{org}}');
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

function langSelect(relativePaths, language) {
  const selected = new Map();

  for (const relativePath of relativePaths) {
    if (relativePath.includes(`.${language}.`)) {
      selected.set(stripVariant(relativePath, language), relativePath);
    } else if (!isLangVariant(relativePath)) {
      if (!selected.has(relativePath)) {
        selected.set(relativePath, relativePath);
      }
    }
  }

  return selected;
}

function platformSelect(entries, platform) {
  const selected = new Map();

  for (const [relativePath, src] of entries) {
    if (!relativePath.includes(`.${platform}.`)) {
      continue;
    }
    selected.set(stripVariant(relativePath, platform), src);
  }

  for (const [relativePath, src] of entries) {
    if (selected.has(relativePath)) {
      continue;
    }
    if (isPlatformVariant(relativePath, platform)) {
      continue;
    }
    selected.set(relativePath, src);
  }

  return selected;
}

function selectLocalizedFiles(srcDir, language, platform = 'github') {
  const relativePaths = walkFiles(srcDir).map((src) => path.relative(srcDir, src));
  return platformSelect(langSelect(relativePaths, language), platform);
}

function copySkillDir(srcDir, dstDir, replacements, language, platform = 'github') {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Template directory not found: ${srcDir}`);
  }

  for (const [relativePath, selectedRelativePath] of selectLocalizedFiles(srcDir, language, platform)) {
    const src = path.join(srcDir, selectedRelativePath);
    const dst = path.join(dstDir, relativePath);
    if (containsPlaceholders(src)) {
      renderFile(src, dst, replacements);
      try {
        fs.chmodSync(dst, fs.statSync(src).mode);
      } catch {
        // Ignore permission sync failures on unsupported filesystems.
      }
      continue;
    }

    copyFile(src, dst);
  }
}

export { renderFile, copyFile, copySkillDir };
