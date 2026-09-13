#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_VERSION = 1;
const MANIFEST_RELATIVE_PATH = 'dist/test-build-manifest.json';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkFiles(root, relative = '') {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return walkFiles(root, child);
    return [child];
  });
}

function sourceFiles(projectRoot) {
  const files = [
    ...walkFiles(projectRoot, 'bin').filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')),
    ...walkFiles(projectRoot, 'lib').filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')),
    ...walkFiles(projectRoot, 'scripts').filter((file) => file.endsWith('.js')),
    ...walkFiles(projectRoot, 'tests')
      .filter((file) => file.endsWith('.ts')
        && !file.endsWith('.d.ts')
        && !file.startsWith(`tests${path.sep}fixtures${path.sep}`)),
    'tsconfig.json',
    'tsconfig.test-build.json'
  ];
  return [...new Set(files)].sort((left, right) => toPosix(left).localeCompare(toPosix(right)));
}

function outputPathFor(source) {
  if (source.endsWith('.ts')) return `dist/${toPosix(source.slice(0, -3))}.js`;
  if (source.endsWith('.js')) return `dist/${toPosix(source)}`;
  return null;
}

function buildManifest(projectRoot) {
  const inputs = sourceFiles(projectRoot).map((source) => {
    const sourcePath = path.join(projectRoot, source);
    const output = outputPathFor(source);
    const outputPath = output ? path.join(projectRoot, output) : undefined;
    return {
      source: toPosix(source),
      sourceSha256: hashFile(sourcePath),
      output,
      outputSha256: outputPath && fs.existsSync(outputPath) ? hashFile(outputPath) : null
    };
  });
  return {
    version: MANIFEST_VERSION,
    projectRoot: path.resolve(projectRoot),
    inputs
  };
}

function manifestPath(projectRoot) {
  return path.join(projectRoot, MANIFEST_RELATIVE_PATH);
}

function writeManifest(projectRoot) {
  const manifest = buildManifest(projectRoot);
  const target = manifestPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readManifest(projectRoot) {
  const target = manifestPath(projectRoot);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function validateManifest(projectRoot) {
  const manifest = readManifest(projectRoot);
  if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.inputs)) {
    return { ok: false, message: `test build manifest is missing or invalid: ${MANIFEST_RELATIVE_PATH}` };
  }
  const expected = buildManifest(projectRoot);
  const expectedInputs = new Map(expected.inputs.map((input) => [input.source, input]));
  const actualInputs = new Map(manifest.inputs.map((input) => [input.source, input]));
  const errors = [];
  if (manifest.projectRoot !== path.resolve(projectRoot)) {
    errors.push(`manifest project root mismatch: ${manifest.projectRoot}`);
  }
  if (expectedInputs.size !== actualInputs.size || [...expectedInputs.keys()].some((key) => !actualInputs.has(key))) {
    errors.push('test build inputs changed; run npm run build:test');
  }
  for (const [source, current] of expectedInputs) {
    const recorded = actualInputs.get(source);
    if (!recorded) continue;
    if (recorded.sourceSha256 !== current.sourceSha256) errors.push(`test build input changed: ${source}`);
    if (recorded.output !== current.output) errors.push(`test build output mapping changed: ${source}`);
    if (current.output && !fs.existsSync(path.join(projectRoot, current.output))) {
      errors.push(`test build output is missing: ${current.output}`);
    } else if (current.output && recorded.outputSha256 !== current.outputSha256) {
      errors.push(`test build output is stale: ${current.output}`);
    }
  }
  const actualTests = walkFiles(path.join(projectRoot, 'dist', 'tests'))
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => toPosix(path.join('dist', 'tests', file)))
    .sort();
  const expectedTests = expected.inputs
    .map((input) => input.output)
    .filter((output) => output?.startsWith('dist/tests/') && output.endsWith('.test.js'))
    .sort();
  if (JSON.stringify(actualTests) !== JSON.stringify(expectedTests)) {
    errors.push('compiled test files do not match the current test sources; run npm run build:test');
  }
  return errors.length === 0
    ? { ok: true, manifest }
    : { ok: false, message: errors.join('\n') };
}

export {
  MANIFEST_RELATIVE_PATH,
  buildManifest,
  manifestPath,
  validateManifest,
  walkFiles,
  writeManifest
};
