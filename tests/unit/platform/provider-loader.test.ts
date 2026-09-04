import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  clearProviderSessions,
  loadPlatformProvider
} from '../../../lib/platform/provider-loader.ts';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/platform-providers');

function repository(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'platform-provider-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'one'));
  fs.mkdirSync(path.join(root, 'two'));
  return root;
}

function configure(root: string, type: string, source?: string, config: unknown = {}): void {
  const entry = source === undefined ? { config } : { source, config };
  fs.writeFileSync(
    path.join(root, '.agents', '.airc.json'),
    JSON.stringify({ platform: { type, providers: { [type]: entry } } })
  );
}

test.beforeEach(() => {
  clearProviderSessions();
  delete (globalThis as typeof globalThis & { __agentInfraProviderFactoryCalls?: number }).__agentInfraProviderFactoryCalls;
});

test('loads the selected ESM provider and forwards stable factory and live operation input', async () => {
  const root = repository();
  const source = path.join(fixtureRoot, 'valid-provider.mjs');
  configure(root, 'trae', source, { endpoint: 'https://private.example', retries: 2 });
  const first = await loadPlatformProvider({ cwd: root });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.sourceIdentity.startsWith('file:'), true);
  assert.equal((globalThis as typeof globalThis & { __agentInfraProviderFactoryCalls?: number }).__agentInfraProviderFactoryCalls, 1);
  const context = await first.value.provider.context.resolve({
    repositoryRoot: first.value.repositoryRoot,
    workingDirectory: path.join(root, 'one'),
    scopeId: 'ignored-by-fixture',
    gitRemote: null
  } as never);
  assert.equal(context.ok, true);
  if (context.ok) {
    assert.equal(context.value.metadata?.factoryRoot, root);
    assert.deepEqual(context.value.metadata?.factoryConfig, {
      endpoint: 'https://private.example',
      retries: 2
    });
    assert.equal(context.value.metadata?.operationCwd, path.join(root, 'one'));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('reuses a session across cwd changes while forwarding each operation cwd', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'valid-provider.mjs'));
  const first = await loadPlatformProvider({ cwd: path.join(root, 'one') });
  const second = await loadPlatformProvider({ cwd: path.join(root, 'two') });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.provider, second.value.provider);
  assert.equal((globalThis as typeof globalThis & { __agentInfraProviderFactoryCalls?: number }).__agentInfraProviderFactoryCalls, 1);
  const firstContext = await first.value.provider.context.resolve({
    repositoryRoot: root,
    workingDirectory: path.join(root, 'one'),
    scopeId: 'scope',
    gitRemote: null
  });
  const secondContext = await second.value.provider.context.resolve({
    repositoryRoot: root,
    workingDirectory: path.join(root, 'two'),
    scopeId: 'scope',
    gitRemote: null
  });
  assert.equal(firstContext.ok && firstContext.value.metadata?.operationCwd, path.join(root, 'one'));
  assert.equal(secondContext.ok && secondContext.value.metadata?.operationCwd, path.join(root, 'two'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('changes provider session when selected source changes', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'source-a.mjs'));
  const first = await loadPlatformProvider({ cwd: root });
  configure(root, 'trae', path.join(fixtureRoot, 'source-b.mjs'));
  const second = await loadPlatformProvider({ cwd: root });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.value.sourceIdentity, second.value.sourceIdentity);
  assert.notEqual(first.value.provider, second.value.provider);
  const context = await second.value.provider.context.resolve({
    repositoryRoot: root,
    workingDirectory: root,
    scopeId: 'scope',
    gitRemote: null
  });
  assert.equal(context.ok && context.value.scope.id, 'source-b');
  fs.rmSync(root, { recursive: true, force: true });
});

test('does not reuse an old provider when the selected source cannot resolve', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'source-a.mjs'));
  const first = await loadPlatformProvider({ cwd: root });
  configure(root, 'trae', path.join(root, 'missing-provider.mjs'));
  const second = await loadPlatformProvider({ cwd: root });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, 'PLATFORM_PROVIDER_SOURCE_RESOLUTION_FAILED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('reports selected provider shape and configuration failures', async () => {
  const root = repository();
  const cases = [
    ['missing', undefined, 'PLATFORM_PROVIDER_SOURCE_MISSING'],
    ['trae', path.join(fixtureRoot, 'invalid-export.mjs'), 'PLATFORM_PROVIDER_EXPORT_INVALID'],
    ['trae', path.join(fixtureRoot, 'version-mismatch.mjs'), 'PLATFORM_PROVIDER_VERSION_UNSUPPORTED'],
    ['trae', path.join(fixtureRoot, 'throwing-provider.mjs'), 'PLATFORM_PROVIDER_FACTORY_FAILED']
  ] as const;
  for (const [type, source, code] of cases) {
    configure(root, type, source);
    const result = await loadPlatformProvider({ cwd: root });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
  }
  configure(root, 'trae', path.join(fixtureRoot, 'source-a.mjs'), []);
  const invalidConfig = await loadPlatformProvider({ cwd: root });
  assert.equal(invalidConfig.ok, false);
  if (!invalidConfig.ok) assert.equal(invalidConfig.error.code, 'PLATFORM_PROVIDER_CONFIG_INVALID');
  fs.rmSync(root, { recursive: true, force: true });
});

test('loads built-in none without external source', async () => {
  const root = repository();
  configure(root, 'none');
  const result = await loadPlatformProvider({ cwd: root });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.sourceIdentity, 'builtin:none@1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('validates selected provider operation results at the invocation boundary', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'invalid-context-result-provider.mjs'));
  const loaded = await loadPlatformProvider({ cwd: root });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    const resolved = await loaded.value.provider.context.resolve({
      repositoryRoot: root,
      workingDirectory: root,
      scopeId: root,
      gitRemote: null
    });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.error.code, 'PLATFORM_PROVIDER_RESULT_INVALID');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('loads an opaque provider with its declared string identity contract', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'opaque-identity-provider.mjs'));
  const loaded = await loadPlatformProvider({ cwd: root });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    const context = await loaded.value.provider.context.resolve({
      repositoryRoot: root,
      workingDirectory: root,
      scopeId: root,
      gitRemote: null
    });
    assert.equal(context.ok, true);
    const issue = await loaded.value.provider.issues!.inspect({
      context: { repositoryRoot: root, workingDirectory: root, scopeId: root },
      target: { kind: 'id', value: 'issue-42' }
    });
    assert.equal(issue.ok, true);
    if (issue.ok) assert.deepEqual(issue.value.identity, { kind: 'id', value: 'issue-42' });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('routes an external capability provider without initializing GitHub transport', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'external-capability-provider.mjs'));
  const loaded = await loadPlatformProvider({ cwd: root });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    const inspected = await loaded.value.provider.changeRequests!.inspect({
      context: { repositoryRoot: root, workingDirectory: root, scopeId: 'external/project' },
      target: { kind: 'id', value: 'cr-1' }
    });
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.deepEqual(inspected.value.identity, { kind: 'id', value: 'cr-1' });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('loads an external release-note provider through the normalized facts contract', async () => {
  const root = repository();
  configure(root, 'trae', path.join(fixtureRoot, 'external-release-notes-provider.mjs'));
  const loaded = await loadPlatformProvider({ cwd: root });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    const notes = await loaded.value.provider.releases!.collectNotes({
      context: { repositoryRoot: root, workingDirectory: root, scopeId: root },
      fromTime: '2026-09-01T00:00:00.000Z',
      toTime: '2026-09-02T00:00:00.000Z',
      commitOids: ['1111111'],
      branch: 'main',
      historyLimit: 3
    });
    assert.equal(notes.ok, true);
    if (notes.ok) assert.equal(notes.value.history[0]?.authoredAt, '2026-09-02T00:00:00.000Z');
  }
  fs.rmSync(root, { recursive: true, force: true });
});
