import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  computeLifecycleBuildIdentity,
  isCanonicalLifecyclePackageVersion,
  isLifecycleProtocolVersion,
  readLifecycleManifestFiles,
  resolveLifecycleExecutableFiles,
  verifyLifecycleBuildIdentity
} from '../../../lib/agent-clients/adapters/codex-lifecycle/build-identity.ts';

const fixtureRoots = new Set<string>();
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-build-identity-'));
  fixtureRoots.add(root);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, '.codex', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'run-task'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'lib', 'protocol.ts'), 'export const protocol = 3;\n');
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), '{"hooks":[]}\n');
  fs.writeFileSync(path.join(root, '.codex', 'agents', 'executor.toml'), 'name = "executor"\n');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'run-task', 'SKILL.md'), '# Run\n');
  fs.writeFileSync(path.join(root, '.agents', 'rules', 'lifecycle.md'), '# Lifecycle\n');
  return root;
}

function launcherIdentity(relativePath: string, firstLine: string, body = 'export const launcher = true;\n') {
  const root = fixture();
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(firstLine), Buffer.from(body)]));
  return computeLifecycleBuildIdentity(root, {
    executableFiles: [relativePath],
    contractFiles: []
  });
}

function writeLifecycleManifest(root: string, launcherShebang: Record<string, unknown>) {
  const file = path.join(root, 'lib', 'agent-clients', 'adapters', 'codex-lifecycle', 'manifest-files.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    executableFiles: [launcherShebang.sourceFile],
    contractFiles: [],
    launcherShebang
  }));
}

test('lifecycle build identity separates executable and contract hashes', () => {
  const root = fixture();
  const options = {
    executableFiles: ['lib/protocol.ts'],
    contractFiles: [
      '.codex/hooks.json',
      '.codex/agents/executor.toml',
      '.agents/skills/run-task/SKILL.md',
      '.agents/rules/lifecycle.md'
    ]
  };
  const first = computeLifecycleBuildIdentity(root, options);
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'run-task', 'SKILL.md'), '# Run changed\n');
  const contractChanged = computeLifecycleBuildIdentity(root, options);
  assert.equal(contractChanged.internalExecutableBuildHash, first.internalExecutableBuildHash);
  assert.notEqual(contractChanged.lifecycleContractHash, first.lifecycleContractHash);

  fs.writeFileSync(path.join(root, 'lib', 'protocol.ts'), 'export const protocol = 4;\n');
  const executableChanged = computeLifecycleBuildIdentity(root, options);
  assert.notEqual(executableChanged.internalExecutableBuildHash, first.internalExecutableBuildHash);
  assert.equal(
    verifyLifecycleBuildIdentity(first, contractChanged).warnings[0]?.code,
    'CODEX_LIFECYCLE_CONTRACT_MISMATCH'
  );
  assert.equal(
    verifyLifecycleBuildIdentity(first, executableChanged).warnings[0]?.code,
    'CODEX_LIFECYCLE_BUILD_MISMATCH'
  );
});

test('lifecycle build identity preserves exact package version text', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3+build.5' }));
  const identity = computeLifecycleBuildIdentity(root, {
    executableFiles: ['lib/protocol.ts'],
    contractFiles: ['lib/protocol.ts']
  });
  assert.equal(identity.packageVersion, '1.2.3+build.5');
});

test('lifecycle executable identity expands the complete relative import closure', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'lib', 'protocol.ts'), "import { helper } from './helper.ts';\nexport const protocol = helper;\n");
  fs.writeFileSync(path.join(root, 'lib', 'helper.ts'), 'export const helper = 3;\n');
  assert.deepEqual(resolveLifecycleExecutableFiles(root, ['lib/protocol.ts']), [
    'lib/helper.ts',
    'lib/protocol.ts'
  ]);
});

test('lifecycle build identity reads one validated manifest file list', () => {
  const manifest = readLifecycleManifestFiles(process.cwd());
  assert.ok(manifest.executableFiles.includes(
    'lib/agent-clients/adapters/codex-lifecycle/manifest-files.json'
  ));
  for (const root of [
    'lib/internal/sandbox-control.ts',
    'lib/sandbox/control/protocol.ts',
    'lib/sandbox/control/client.ts',
    'lib/sandbox/control/executor.ts',
    'lib/sandbox/control/controller-registration.ts',
    'lib/agent-clients/adapters/codex-lifecycle/controller-context.ts',
    'lib/server/process-state.ts',
    'lib/sandbox/shell.ts'
  ]) {
    assert.ok(manifest.executableFiles.includes(root), root);
    assert.equal(fs.lstatSync(path.join(process.cwd(), root)).isFile(), true, root);
  }
  const closure = resolveLifecycleExecutableFiles(process.cwd(), manifest.executableFiles);
  assert.ok(closure.includes('lib/sandbox/control/controller-registration.ts'));
  assert.ok(closure.includes('lib/agent-clients/adapters/codex-lifecycle/controller-context.ts'));
  assert.ok(manifest.contractFiles.includes('.agents/skills/run-task/SKILL.md'));
});

test('lifecycle manifest declares the exact protected launcher shebang policy', () => {
  const manifest = readLifecycleManifestFiles(process.cwd()) as ReturnType<typeof readLifecycleManifestFiles> & {
    launcherShebang?: unknown
  };
  assert.deepEqual(manifest.launcherShebang, {
    sourceFile: 'bin/internal-cli.ts',
    compiledFile: 'dist/bin/internal-cli.js',
    canonicalLine: '#!/usr/bin/env node\n',
    acceptedLines: [
      '#!/usr/bin/env node\n',
      '#!/opt/homebrew/opt/node/bin/node\n',
      '#!/usr/local/opt/node/bin/node\n',
      '#!/home/linuxbrew/.linuxbrew/opt/node/bin/node\n'
    ]
  });
});

test('lifecycle manifest rejects malformed launcher shebang policies', () => {
  for (const launcherShebang of [
    {
      sourceFile: 'bin/internal-cli.ts',
      compiledFile: 'dist/bin/internal-cli.js',
      canonicalLine: '#!/usr/bin/env node\npayload\n',
      acceptedLines: ['#!/usr/bin/env node\npayload\n']
    },
    {
      sourceFile: '../outside.ts',
      compiledFile: 'outside.js',
      canonicalLine: '#!/usr/bin/env node\n',
      acceptedLines: ['#!/usr/bin/env node\n']
    }
  ]) {
    const root = fixture();
    writeLifecycleManifest(root, launcherShebang);
    assert.throws(() => readLifecycleManifestFiles(root));
  }
});

test('lifecycle identity normalizes only the exact source and compiled launcher lines', () => {
  const acceptedLines = [
    '#!/usr/bin/env node\n',
    '#!/opt/homebrew/opt/node/bin/node\n',
    '#!/usr/local/opt/node/bin/node\n',
    '#!/home/linuxbrew/.linuxbrew/opt/node/bin/node\n'
  ];
  const sourceCanonical = launcherIdentity('bin/internal-cli.ts', acceptedLines[0]!);
  const compiledCanonical = launcherIdentity('dist/bin/internal-cli.js', acceptedLines[0]!);
  for (const line of acceptedLines) {
    assert.equal(launcherIdentity('bin/internal-cli.ts', line).internalExecutableBuildHash, sourceCanonical.internalExecutableBuildHash);
    assert.equal(launcherIdentity('dist/bin/internal-cli.js', line).internalExecutableBuildHash, compiledCanonical.internalExecutableBuildHash);
  }

  for (const line of [
    '#!/usr/bin/env node --no-warnings\n',
    '#!/opt/homebrew/opt/node/bin/node --inspect\n',
    '#!/custom/homebrew/opt/node/bin/node\n',
    '#!/usr/bin/env deno\n',
    '#!/opt/homebrew/opt/node/bin/node\r\n',
    '#!/opt/homebrew/opt/node/bin/node \n',
    '#! /usr/bin/env node\n',
    '#!/opt/homebrew/opt/node/bin/node'
  ]) {
    assert.notEqual(
      launcherIdentity('dist/bin/internal-cli.js', line).internalExecutableBuildHash,
      compiledCanonical.internalExecutableBuildHash,
      line
    );
  }

  assert.notEqual(
    launcherIdentity('dist/bin/internal-cli.js', acceptedLines[1]!, 'export const launcher = false;\n').internalExecutableBuildHash,
    compiledCanonical.internalExecutableBuildHash
  );
  assert.notEqual(
    launcherIdentity('lib/not-the-launcher.js', acceptedLines[1]!).internalExecutableBuildHash,
    launcherIdentity('lib/not-the-launcher.js', acceptedLines[0]!).internalExecutableBuildHash
  );
});

test('lifecycle package version validator accepts only canonical semver', () => {
  assert.equal(isLifecycleProtocolVersion(3), true);
  assert.equal(isLifecycleProtocolVersion(2), false);
  assert.equal(isLifecycleProtocolVersion('3'), false);
  assert.equal(isCanonicalLifecyclePackageVersion('1.2.3'), true);
  assert.equal(isCanonicalLifecyclePackageVersion('0.9.9-alpha.0'), true);
  assert.equal(isCanonicalLifecyclePackageVersion('v1.2.3'), false);
  assert.equal(isCanonicalLifecyclePackageVersion('1.2'), false);
  assert.equal(isCanonicalLifecyclePackageVersion('>=1.2.3'), false);
  assert.equal(isCanonicalLifecyclePackageVersion(' invalid '), false);
  assert.equal(isCanonicalLifecyclePackageVersion(null), false);
});
