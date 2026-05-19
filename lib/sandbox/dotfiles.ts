import fs from 'node:fs';
import path from 'node:path';
import { hostJoin } from './engines/wsl2-paths.ts';

type DotfilesWarning = {
  rel: string;
  reason: string;
  detail?: string;
};

type DotfilesFs = Pick<typeof fs, 'copyFileSync' | 'existsSync' | 'mkdirSync' | 'readdirSync' | 'realpathSync' | 'rmSync' | 'statSync'>;

type MaterializeOptions = {
  writeStderr?: (message: string) => void;
  maxDepth?: number;
  fsModule?: DotfilesFs;
};

type WalkContext = {
  srcDir: string;
  dstDir: string;
  relParts: string[];
  depth: number;
  maxDepth: number;
  activeDirs: Set<string>;
  warnings: DotfilesWarning[];
  writeStderr: (message: string) => void;
  fsModule: DotfilesFs;
};

export function dotfilesCacheDir(home: string, project: string): string {
  return hostJoin(home, '.agent-infra', '.cache', 'dotfiles-resolved', project);
}

function dotfilesWarning(
  warnings: DotfilesWarning[],
  writeStderr: (message: string) => void,
  relPath: string,
  reason: string,
  detail = ''
): void {
  const warning: DotfilesWarning = { rel: relPath, reason };
  if (detail) {
    warning.detail = detail;
  }
  warnings.push(warning);

  const suffix = detail ? `: ${detail}` : '';
  writeStderr(`sandbox-dotfiles (host): skipping ${relPath} (${reason}${suffix})\n`);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function errorCodeOrDetail(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : errorDetail(error);
}

function copyDotfile(
  srcPath: string,
  dstPath: string,
  context: Pick<WalkContext, 'fsModule' | 'warnings' | 'writeStderr'> & { relPath: string }
): void {
  const { fsModule, relPath, warnings, writeStderr } = context;
  try {
    fsModule.mkdirSync(path.dirname(dstPath), { recursive: true });
    fsModule.copyFileSync(srcPath, dstPath);
  } catch (error) {
    dotfilesWarning(warnings, writeStderr, relPath, 'copy failed', errorCodeOrDetail(error));
  }
}

function walkAndMaterializeDotfiles(context: WalkContext): void {
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

  let entries: fs.Dirent[];
  try {
    entries = fsModule.readdirSync(srcDir, { withFileTypes: true });
  } catch (error) {
    dotfilesWarning(warnings, writeStderr, relPath, 'read failed', errorCodeOrDetail(error));
    return;
  }

  for (const entry of entries) {
    const childSrc = path.join(srcDir, entry.name);
    const childDst = path.join(dstDir, entry.name);
    const childRelParts = [...relParts, entry.name];
    const childRelPath = childRelParts.join('/');

    if (entry.isSymbolicLink()) {
      let resolvedTarget: string;
      try {
        resolvedTarget = fsModule.realpathSync(childSrc);
      } catch (error) {
        const code = errorCodeOrDetail(error);
        const reason = code === 'ELOOP' ? 'symlink loop' : 'dangling symlink';
        dotfilesWarning(warnings, writeStderr, childRelPath, reason, code || 'unresolved');
        continue;
      }

      let targetStat: fs.Stats;
      try {
        targetStat = fsModule.statSync(resolvedTarget);
      } catch (error) {
        dotfilesWarning(warnings, writeStderr, childRelPath, 'target stat failed', errorCodeOrDetail(error));
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
      let childRealPath: string | null = null;
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

export function materializeDotfiles(srcDir: string, cacheDir: string, options: MaterializeOptions = {}) {
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

  const warnings: DotfilesWarning[] = [];
  const activeDirs = new Set<string>();
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
