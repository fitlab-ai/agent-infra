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
  launcherShebang: LifecycleLauncherShebang;
}>;

type LifecycleLauncherShebang = Readonly<{
  sourceFile: string;
  compiledFile: string;
  canonicalLine: string;
  acceptedLines: readonly string[];
}>;

type IdentityVerification = Readonly<{
  ok: boolean;
  code: string | null;
  message: string | null;
  warnings: readonly LifecycleIdentityWarning[];
}>;

type LifecycleIdentityWarning = Readonly<{
  code: 'CODEX_LIFECYCLE_BUILD_MISMATCH' | 'CODEX_LIFECYCLE_CONTRACT_MISMATCH';
  message: string;
  action: 'rebuild-sandbox';
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

function isLifecycleLauncherLine(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 1
    && value.slice(0, -1).trim() === value.slice(0, -1)
    && value.startsWith('#!')
    && value.endsWith('\n')
    && !value.includes('\r');
}

function readLifecycleLauncherShebang(
  value: unknown,
  executableFiles: readonly string[]
): LifecycleLauncherShebang {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Lifecycle manifest launcher shebang policy is invalid');
  }
  const policy = value as Record<string, unknown>;
  if (!exactText(policy.sourceFile)
    || !exactText(policy.compiledFile)
    || !isLifecycleLauncherLine(policy.canonicalLine)
    || !Array.isArray(policy.acceptedLines)
    || !policy.acceptedLines.every(isLifecycleLauncherLine)
    || new Set(policy.acceptedLines).size !== policy.acceptedLines.length
    || !policy.acceptedLines.includes(policy.canonicalLine)
    || !executableFiles.includes(policy.sourceFile)
    || policy.compiledFile !== normalizeRelativePath(path.join(
      'dist',
      policy.sourceFile.endsWith('.ts')
        ? policy.sourceFile.replace(/\.ts$/u, '.js')
        : policy.sourceFile
    ))) {
    throw new Error('Lifecycle manifest launcher shebang policy is invalid');
  }
  return Object.freeze({
    sourceFile: policy.sourceFile,
    compiledFile: policy.compiledFile,
    canonicalLine: policy.canonicalLine,
    acceptedLines: Object.freeze([...policy.acceptedLines])
  });
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
    launcherShebang?: unknown;
  };
  if (!Array.isArray(value.executableFiles)
    || !Array.isArray(value.contractFiles)
    || !value.executableFiles.every(exactText)
    || !value.contractFiles.every(exactText)
    || new Set(value.executableFiles).size !== value.executableFiles.length
    || new Set(value.contractFiles).size !== value.contractFiles.length) {
    throw new Error('Lifecycle manifest file list is invalid');
  }
  const executableFiles = Object.freeze([...value.executableFiles] as string[]);
  return Object.freeze({
    executableFiles,
    contractFiles: Object.freeze([...value.contractFiles] as string[]),
    launcherShebang: readLifecycleLauncherShebang(value.launcherShebang, executableFiles)
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

function normalizeLifecycleLauncherBytes(
  relative: string,
  content: Buffer,
  policy: LifecycleLauncherShebang
): Buffer {
  const normalized = normalizeRelativePath(relative);
  if (normalized !== policy.sourceFile && normalized !== policy.compiledFile) return content;
  const lineEnd = content.indexOf(0x0a);
  if (lineEnd < 0) return content;
  const firstLine = content.subarray(0, lineEnd + 1);
  if (!policy.acceptedLines.some((line) => Buffer.from(line).equals(firstLine))) return content;
  return Buffer.concat([
    Buffer.from(policy.canonicalLine),
    content.subarray(lineEnd + 1)
  ]);
}

function hashFiles(
  root: string,
  files: readonly string[],
  launcherShebang?: LifecycleLauncherShebang
): string {
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
    const content = fs.readFileSync(file);
    hash.update(launcherShebang
      ? normalizeLifecycleLauncherBytes(relative, content, launcherShebang)
      : content);
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
    internalExecutableBuildHash = hashFiles(repoRoot, options.executableFiles, defaults.launcherShebang);
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
        if (hashFiles(
          executableRoot,
          resolveLifecycleExecutableFiles(executableRoot, compiledFiles),
          defaults.launcherShebang
        ) !== manifest.internalExecutableBuildHash) {
          throw new Error('Lifecycle compiled executable build does not match its manifest');
        }
      } else if (hashFiles(
        executableRoot,
        resolveLifecycleExecutableFiles(executableRoot, defaults.executableFiles),
        defaults.launcherShebang
      ) !== manifest.sourceInputHash) {
        throw new Error('Lifecycle executable build manifest is stale or invalid');
      }
      internalExecutableBuildHash = manifest.internalExecutableBuildHash;
    } else internalExecutableBuildHash = hashFiles(
      executableRoot,
      resolveLifecycleExecutableFiles(executableRoot, defaults.executableFiles),
      defaults.launcherShebang
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
      message: 'Codex lifecycle protocol version does not match',
      warnings: []
    };
  }
  const warnings: LifecycleIdentityWarning[] = [];
  if (actual.packageVersion !== expected.packageVersion
    || actual.internalExecutableBuildHash !== expected.internalExecutableBuildHash) {
    warnings.push({
      code: 'CODEX_LIFECYCLE_BUILD_MISMATCH',
      message: 'Codex lifecycle executable build identity differs; rebuild the sandbox if the runtime is stale',
      action: 'rebuild-sandbox'
    });
  }
  if (actual.lifecycleContractHash !== expected.lifecycleContractHash) {
    warnings.push({
      code: 'CODEX_LIFECYCLE_CONTRACT_MISMATCH',
      message: 'Codex lifecycle contract identity differs; rebuild the sandbox if the runtime is stale',
      action: 'rebuild-sandbox'
    });
  }
  return {
    ok: true,
    code: null,
    message: null,
    warnings: Object.freeze(warnings)
  };
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
  LifecycleIdentityWarning,
  LifecycleBuildIdentity,
  LifecycleLauncherShebang,
  LifecycleManifestFiles,
  LifecycleBuildIdentityOptions
};
