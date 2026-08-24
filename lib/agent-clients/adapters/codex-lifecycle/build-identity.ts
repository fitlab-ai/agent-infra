import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

const LIFECYCLE_PROTOCOL_VERSION = 3;

type LifecycleBuildIdentity = Readonly<{
  protocolVersion: 3;
  packageVersion: string;
  internalExecutableBuildHash: string;
  lifecycleContractHash: string;
}>;

type LifecycleBuildIdentityOptions = Readonly<{
  executableFiles?: readonly string[];
  contractFiles?: readonly string[];
}>;

type LifecycleManifestFiles = Readonly<{
  executableFiles: readonly string[];
  contractFiles: readonly string[];
}>;

type IdentityVerification = Readonly<{
  ok: boolean;
  code: string | null;
  message: string | null;
}>;

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function isCanonicalLifecyclePackageVersion(value: unknown): value is string {
  return typeof value === 'string' && semver.valid(value) === value;
}

function isLifecycleProtocolVersion(value: unknown): value is typeof LIFECYCLE_PROTOCOL_VERSION {
  return value === LIFECYCLE_PROTOCOL_VERSION;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function readLifecycleManifestFiles(packageRoot: string): LifecycleManifestFiles {
  const file = path.join(
    packageRoot,
    'lib',
    'agent-clients',
    'adapters',
    'codex-lifecycle',
    'manifest-files.json'
  );
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    executableFiles?: unknown;
    contractFiles?: unknown;
  };
  if (!Array.isArray(value.executableFiles)
    || !Array.isArray(value.contractFiles)
    || !value.executableFiles.every(exactText)
    || !value.contractFiles.every(exactText)
    || new Set(value.executableFiles).size !== value.executableFiles.length
    || new Set(value.contractFiles).size !== value.contractFiles.length) {
    throw new Error('Lifecycle manifest file list is invalid');
  }
  return Object.freeze({
    executableFiles: Object.freeze([...value.executableFiles] as string[]),
    contractFiles: Object.freeze([...value.contractFiles] as string[])
  });
}

function executablePackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: unknown };
      if (value.name === '@fitlab-ai/agent-infra') return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Lifecycle executable package root is unavailable');
    current = parent;
  }
}

function hashFiles(root: string, files: readonly string[]): string {
  const hash = crypto.createHash('sha256');
  for (const relative of [...new Set(files.map(normalizeRelativePath))].sort()) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
      throw new Error(`Lifecycle manifest path '${relative}' is unsafe`);
    }
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Lifecycle manifest entry '${relative}' must be a regular file`);
    }
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function resolveLifecycleExecutableFiles(root: string, entries: readonly string[]): string[] {
  const pending = [...entries];
  const resolved = new Set<string>();
  while (pending.length > 0) {
    const relative = normalizeRelativePath(pending.pop()!);
    if (resolved.has(relative)) continue;
    resolved.add(relative);
    if (!/\.[cm]?[jt]s$/u.test(relative)) continue;
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8');
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/gu);
    for (const match of imports) {
      const requested = match[1]!;
      const base = path.resolve(path.dirname(file), requested);
      const candidates = [
        base,
        `${base}.ts`, `${base}.js`,
        path.join(base, 'index.ts'), path.join(base, 'index.js')
      ];
      const dependency = candidates.find((candidate) => fs.existsSync(candidate) && fs.lstatSync(candidate).isFile());
      if (!dependency) throw new Error(`Lifecycle executable dependency '${requested}' from '${relative}' is unavailable`);
      const dependencyRelative = path.relative(root, dependency);
      if (dependencyRelative.startsWith('..') || path.isAbsolute(dependencyRelative)) {
        throw new Error(`Lifecycle executable dependency '${requested}' escapes the package root`);
      }
      pending.push(normalizeRelativePath(dependencyRelative));
    }
  }
  return [...resolved].sort();
}

function computeLifecycleBuildIdentity(
  repoRoot: string,
  options: LifecycleBuildIdentityOptions = {}
): LifecycleBuildIdentity {
  const packageRoot = executablePackageRoot();
  const executableRoot = options.executableFiles ? repoRoot : packageRoot;
  const defaults = readLifecycleManifestFiles(packageRoot);
  const packageJson = JSON.parse(fs.readFileSync(path.join(executableRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (!exactText(packageJson.version)) throw new Error('Lifecycle package version is invalid');
  let internalExecutableBuildHash: string;
  if (options.executableFiles) {
    internalExecutableBuildHash = hashFiles(repoRoot, options.executableFiles);
  } else {
    const manifestFile = path.join(executableRoot, 'dist', 'lifecycle-build-manifest.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
        protocolVersion?: unknown;
        packageVersion?: unknown;
        sourceInputHash?: unknown;
        internalExecutableBuildHash?: unknown;
      };
      if (manifest.protocolVersion !== LIFECYCLE_PROTOCOL_VERSION
        || manifest.packageVersion !== packageJson.version
        || !exactText(manifest.sourceInputHash)
        || !exactText(manifest.internalExecutableBuildHash)) {
        throw new Error('Lifecycle executable build manifest is stale or invalid');
      }
      if (fileURLToPath(import.meta.url).split(path.sep).includes('dist')) {
        const compiledFiles = defaults.executableFiles.map((file) =>
          file.endsWith('.ts') ? path.join('dist', file.replace(/\.ts$/u, '.js')) : file
        );
        if (hashFiles(executableRoot, resolveLifecycleExecutableFiles(executableRoot, compiledFiles)) !== manifest.internalExecutableBuildHash) {
          throw new Error('Lifecycle compiled executable build does not match its manifest');
        }
      } else if (hashFiles(executableRoot, resolveLifecycleExecutableFiles(executableRoot, defaults.executableFiles)) !== manifest.sourceInputHash) {
        throw new Error('Lifecycle executable build manifest is stale or invalid');
      }
      internalExecutableBuildHash = manifest.internalExecutableBuildHash;
    } else internalExecutableBuildHash = hashFiles(
      executableRoot,
      resolveLifecycleExecutableFiles(executableRoot, defaults.executableFiles)
    );
  }
  return Object.freeze({
    protocolVersion: LIFECYCLE_PROTOCOL_VERSION,
    packageVersion: packageJson.version,
    internalExecutableBuildHash,
    lifecycleContractHash: hashFiles(
      repoRoot,
      options.contractFiles ?? defaults.contractFiles
    )
  });
}

function verifyLifecycleBuildIdentity(
  expected: LifecycleBuildIdentity,
  actual: LifecycleBuildIdentity
): IdentityVerification {
  if (actual.protocolVersion !== expected.protocolVersion) {
    return {
      ok: false,
      code: 'CODEX_LIFECYCLE_PROTOCOL_MISMATCH',
      message: 'Codex lifecycle protocol version does not match'
    };
  }
  if (actual.packageVersion !== expected.packageVersion
    || actual.internalExecutableBuildHash !== expected.internalExecutableBuildHash) {
    return {
      ok: false,
      code: 'CODEX_LIFECYCLE_BUILD_MISMATCH',
      message: 'Codex lifecycle executable build identity does not match'
    };
  }
  if (actual.lifecycleContractHash !== expected.lifecycleContractHash) {
    return {
      ok: false,
      code: 'CODEX_LIFECYCLE_CONTRACT_MISMATCH',
      message: 'Codex lifecycle contract identity does not match'
    };
  }
  return { ok: true, code: null, message: null };
}

export {
  LIFECYCLE_PROTOCOL_VERSION,
  computeLifecycleBuildIdentity,
  isCanonicalLifecyclePackageVersion,
  isLifecycleProtocolVersion,
  readLifecycleManifestFiles,
  resolveLifecycleExecutableFiles,
  verifyLifecycleBuildIdentity
};
export type {
  IdentityVerification,
  LifecycleBuildIdentity,
  LifecycleManifestFiles,
  LifecycleBuildIdentityOptions
};
