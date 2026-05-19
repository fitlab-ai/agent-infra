// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { hostJoin } from './engines/wsl2-paths.ts';

export function dotfilesCacheDir(home, project) {
  return hostJoin(home, '.agent-infra', '.cache', 'dotfiles-resolved', project);
}

function dotfilesWarning(warnings, writeStderr, relPath, reason, detail = '') {
  const warning = { rel: relPath, reason };
  if (detail) {
    warning.detail = detail;
  }
  warnings.push(warning);

  const suffix = detail ? `: ${detail}` : '';
  writeStderr(`sandbox-dotfiles (host): skipping ${relPath} (${reason}${suffix})\n`);
}

function copyDotfile(srcPath, dstPath, context) {
  const { fsModule, relPath, warnings, writeStderr } = context;
  try {
    fsModule.mkdirSync(path.dirname(dstPath), { recursive: true });
    fsModule.copyFileSync(srcPath, dstPath);
  } catch (error) {
    dotfilesWarning(warnings, writeStderr, relPath, 'copy failed', error?.code ?? error?.message ?? 'unknown error');
  }
}

function walkAndMaterializeDotfiles(context) {
  const {
    srcDir,
    dstDir,
    relParts,
    depth,
    maxDepth,
    activeDirs,
    warnings,
    writeStderr,
    fsModule
  } = context;
  const relPath = relParts.length > 0 ? relParts.join('/') : '.';

  if (depth > maxDepth) {
    dotfilesWarning(warnings, writeStderr, relPath, 'depth exceeds limit', String(maxDepth));
    return;
  }

  let entries;
  try {
    entries = fsModule.readdirSync(srcDir, { withFileTypes: true });
  } catch (error) {
    dotfilesWarning(warnings, writeStderr, relPath, 'read failed', error?.code ?? error?.message ?? 'unknown error');
    return;
  }

  for (const entry of entries) {
    const childSrc = path.join(srcDir, entry.name);
    const childDst = path.join(dstDir, entry.name);
    const childRelParts = [...relParts, entry.name];
    const childRelPath = childRelParts.join('/');

    if (entry.isSymbolicLink()) {
      let resolvedTarget;
      try {
        resolvedTarget = fsModule.realpathSync(childSrc);
      } catch (error) {
        const reason = error?.code === 'ELOOP' ? 'symlink loop' : 'dangling symlink';
        dotfilesWarning(warnings, writeStderr, childRelPath, reason, error?.code ?? 'unresolved');
        continue;
      }

      let targetStat;
      try {
        targetStat = fsModule.statSync(resolvedTarget);
      } catch (error) {
        dotfilesWarning(warnings, writeStderr, childRelPath, 'target stat failed', error?.code ?? error?.message ?? 'unknown error');
        continue;
      }

      if (targetStat.isDirectory()) {
        if (activeDirs.has(resolvedTarget)) {
          dotfilesWarning(warnings, writeStderr, childRelPath, 'symlink loop');
          continue;
        }

        activeDirs.add(resolvedTarget);
        walkAndMaterializeDotfiles({
          srcDir: resolvedTarget,
          dstDir: childDst,
          relParts: childRelParts,
          depth: depth + 1,
          maxDepth,
          activeDirs,
          warnings,
          writeStderr,
          fsModule
        });
        activeDirs.delete(resolvedTarget);
        continue;
      }

      if (targetStat.isFile()) {
        copyDotfile(resolvedTarget, childDst, {
          fsModule,
          relPath: childRelPath,
          warnings,
          writeStderr
        });
      }
      continue;
    }

    if (entry.isDirectory()) {
      let childRealPath = null;
      try {
        childRealPath = fsModule.realpathSync(childSrc);
      } catch {
        // A real directory may disappear during traversal; readdir will warn below.
      }
      if (childRealPath) {
        activeDirs.add(childRealPath);
      }
      walkAndMaterializeDotfiles({
        srcDir: childSrc,
        dstDir: childDst,
        relParts: childRelParts,
        depth: depth + 1,
        maxDepth,
        activeDirs,
        warnings,
        writeStderr,
        fsModule
      });
      if (childRealPath) {
        activeDirs.delete(childRealPath);
      }
      continue;
    }

    if (entry.isFile()) {
      copyDotfile(childSrc, childDst, {
        fsModule,
        relPath: childRelPath,
        warnings,
        writeStderr
      });
    }
  }
}

export function materializeDotfiles(srcDir, cacheDir, options = {}) {
  const {
    writeStderr = (message) => process.stderr.write(message),
    maxDepth = 32,
    fsModule = fs
  } = options;

  if (!srcDir || !fsModule.existsSync(srcDir)) {
    return null;
  }

  fsModule.mkdirSync(cacheDir, { recursive: true });
  for (const entry of fsModule.readdirSync(cacheDir)) {
    fsModule.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
  }

  const warnings = [];
  const activeDirs = new Set();
  try {
    activeDirs.add(fsModule.realpathSync(srcDir));
  } catch {
    activeDirs.add(srcDir);
  }

  walkAndMaterializeDotfiles({
    srcDir,
    dstDir: cacheDir,
    relParts: [],
    depth: 0,
    maxDepth,
    activeDirs,
    warnings,
    writeStderr,
    fsModule
  });

  return { cacheDir, warnings };
}
