import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createTempDir, CLI_PATH } from '../../helpers.ts';
import { createObjectStore, publishSnapshot } from '../../../lib/process-data/store.ts';

function fixture(project: unknown = 'demo') {
  const root = createTempDir('process-data-cli-');
  const home = createTempDir('process-data-home-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project }));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md'),
    '---\nid: TASK-20260101-000001\n---\n\n# Task\n'
  );
  return { root, home };
}

function run(root: string, home: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const isolatedEnv = { ...env, HOME: home, USERPROFILE: home };
  return spawnSync('node', [CLI_PATH, 'data', ...args], { cwd: root, encoding: 'utf8', env: isolatedEnv });
}

test('historical v1 snapshots remain readable through explicit roots while local capture is retired', () => {
  const { root, home } = fixture();
  const dataRoot = path.join(root, '.historical-data');
  const store = createObjectStore(dataRoot);
  const object = store.put(Buffer.from('legacy evidence'));
  const published = publishSnapshot(dataRoot, {
    scope: 'local',
    repository: 'example/repo',
    observedFrom: '2026-01-01T00:00:00.000Z',
    observedTo: '2026-01-01T00:00:01.000Z',
    objects: [{ sourceKind: 'local-file', sourceIdentity: 'task.md', sha256: object.sha256, bytes: object.path ? 15 : 15 }],
    endpoints: [],
    excerptsEnabled: false,
    records: [{ recordId: 'legacy', kind: 'artifact', sourceIdentity: 'task.md', sourceSha256: object.sha256 }],
    quality: [],
    repairs: []
  });
  const snapshotId = published.snapshotId;

  const verify = run(root, home, ['verify', snapshotId, '--root', dataRoot]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);

  const audit = run(root, home, ['audit', snapshotId, '--format', 'json', '--root', dataRoot]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.ok(Array.isArray(JSON.parse(audit.stdout).findings));

  const before = fs.readdirSync(path.join(dataRoot, 'repairs')).length;
  const repair = run(root, home, ['repair', snapshotId, '--root', dataRoot]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(JSON.parse(repair.stdout).applied, false);
  const after = fs.readdirSync(path.join(dataRoot, 'repairs')).length;
  assert.equal(after, before);

  const exported = run(root, home, ['export', snapshotId, '--repairs', 'none', '--output', '-', '--root', dataRoot]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /"schema":"normalized\/v1"/);

  const relativeRoot = run(root, home, ['verify', snapshotId, '--root', '.historical-data']);
  assert.equal(relativeRoot.status, 0, relativeRoot.stderr);
  const outsideRoot = run(root, home, ['verify', snapshotId, '--root', home]);
  assert.equal(outsideRoot.status, 1);
  assert.match(JSON.parse(outsideRoot.stdout).error.message, /inside the repository/);

  const taskRoot = path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001');
  const taskData = run(root, home, ['verify', snapshotId, '--root', taskRoot]);
  assert.equal(taskData.status, 1);
  assert.match(JSON.parse(taskData.stdout).error.message, /task directory/);

  const linkedRoot = path.join(root, '.historical-data-link');
  try {
    fs.symlinkSync(dataRoot, linkedRoot, 'dir');
    const linked = run(root, home, ['verify', snapshotId, '--root', linkedRoot]);
    assert.equal(linked.status, 1);
    assert.match(JSON.parse(linked.stdout).error.message, /symlink/);
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }

  const exportOutside = run(root, home, ['export', snapshotId, '--repairs', 'none', '--output', path.join(home, 'export.json'), '--root', dataRoot]);
  assert.equal(exportOutside.status, 1);
  assert.match(JSON.parse(exportOutside.stdout).error.message, /export output must be inside the repository/);
  assert.equal(fs.existsSync(path.join(home, 'export.json')), false);
});

test('local, all and excerpt capture options fail before creating the data root', () => {
  for (const args of [['capture', '--source', 'local'], ['capture', '--source', 'all'], ['capture', '--include-excerpts']]) {
    const { root, home } = fixture();
    const result = run(root, home, args);
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(path.join(home, '.agent-infra', 'data-store')), false);
  }
});

test('unknown data subcommand fails without creating the default root', () => {
  const { root, home } = fixture();
  const result = run(root, home, ['unknown']);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(path.join(home, '.agent-infra', 'data-store')), false);
});

test('data help exposes the v2 export as-of option', () => {
  const { root, home } = fixture();
  const result = run(root, home, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /export .*--as-of <ISO>/);
});

test('full capture uses explicit GitHub pages through a fake gh boundary', () => {
  const { root, home } = fixture();
  const fake = path.join(root, 'fake-gh.mjs');
  fs.writeFileSync(fake, `
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'acme/demo' }));
  process.exit(0);
}
if (args[0] === 'api') {
  const endpoint = args.find((value) => value.startsWith('repos/')) || '';
  const date = 'Thu, 20 Aug 2026 00:00:00 GMT';
  const respond = (value) => process.stdout.write('HTTP/2 200 OK\\r\\nDate: ' + date + '\\r\\n\\r\\n' + JSON.stringify(value));
  if (endpoint.includes('/issues?state=all')) {
    respond([{ id: 101, number: 1, body: 'TASK-20260101-000001', title: 'evidence', updated_at: '2026-08-19T00:00:00Z' }]);
  } else {
    respond(endpoint.includes('/acme/demo') && !endpoint.includes('?') ? { id: 1 } : []);
  }
  process.exit(0);
}
process.stderr.write('unexpected gh args: ' + JSON.stringify(args));
process.exit(1);
`);
  const result = run(root, home, ['capture'], {
    ...process.env,
    AGENT_INFRA_GH_BIN: process.execPath,
    AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([fake]),
    AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS: '0'
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.scope, 'github');
  const manifestFiles: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.name === 'manifest.json') manifestFiles.push(candidate);
    }
  };
  const defaultRoot = path.join(home, '.agent-infra', 'data-store', 'demo');
  visit(path.join(defaultRoot, 'snapshots'));
  const manifest = JSON.parse(fs.readFileSync(manifestFiles[0]!, 'utf8'));
  assert.equal(manifest.schema, 'raw-manifest/v2');
  assert.equal(manifest.endpoints.length, 4);
  assert.equal(manifest.endpoints.every((endpoint: { pages: unknown[] }) => endpoint.pages.length === 1), true);

  const snapshotId = path.basename(path.dirname(manifestFiles[0]!));
  const verify = run(root, home, ['verify', snapshotId]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
  const audit = run(root, home, ['audit', snapshotId, '--format', 'json']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).ok, true);
  const repair = run(root, home, ['repair', snapshotId]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(JSON.parse(repair.stdout).applied, false);
  const exported = run(root, home, ['export', snapshotId, '--output', '-']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /"schema":"normalized\/v2"/);
});

test('invalid project configuration fails before creating the default root', () => {
  const missing = fixture();
  fs.rmSync(path.join(missing.root, '.agents', '.airc.json'));
  const missingConfig = run(missing.root, missing.home, ['verify', 'missing-snapshot']);
  assert.equal(missingConfig.status, 1);
  assert.equal(JSON.parse(missingConfig.stdout).error.code, 'DATA_COMMAND_FAILED');
  assert.equal(fs.existsSync(path.join(missing.home, '.agent-infra', 'data-store')), false);

  const invalid = fixture('../escape');
  const invalidConfig = run(invalid.root, invalid.home, ['verify', 'missing-snapshot']);
  assert.equal(invalidConfig.status, 1);
  assert.equal(JSON.parse(invalidConfig.stdout).error.code, 'DATA_COMMAND_FAILED');
  assert.equal(fs.existsSync(path.join(invalid.home, '.agent-infra', 'data-store')), false);
});

test('default root rejects symlink components inside the home boundary', () => {
  const { root, home } = fixture();
  const linked = path.join(home, '.agent-infra');
  const target = path.join(home, 'outside');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, linked, 'dir');
    const result = run(root, home, ['verify', 'missing-snapshot']);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.message, /symlink/);
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
});
