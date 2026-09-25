import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI_PATH } from '../../helpers.ts';
import { createObjectStore, publishSnapshot } from '../../../lib/process-data/store.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-data-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md'),
    '---\nid: TASK-20260101-000001\n---\n\n# Task\n'
  );
  return root;
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('node', [CLI_PATH, 'data', ...args], { cwd: root, encoding: 'utf8', env });
}

test('historical v1 snapshots remain readable while local capture is retired', () => {
  const root = fixture();
  const dataRoot = path.join(root, '.agents', 'workspace', 'process-data');
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

  const verify = run(root, ['verify', snapshotId]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);

  const audit = run(root, ['audit', snapshotId, '--format', 'json']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.ok(Array.isArray(JSON.parse(audit.stdout).findings));

  const before = fs.readdirSync(path.join(root, '.agents', 'workspace', 'process-data', 'repairs')).length;
  const repair = run(root, ['repair', snapshotId]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(JSON.parse(repair.stdout).applied, false);
  const after = fs.readdirSync(path.join(root, '.agents', 'workspace', 'process-data', 'repairs')).length;
  assert.equal(after, before);

  const exported = run(root, ['export', snapshotId, '--repairs', 'none', '--output', '-']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /"schema":"normalized\/v1"/);
});

test('local, all and excerpt capture options fail before creating the data root', () => {
  for (const args of [['capture', '--source', 'local'], ['capture', '--source', 'all'], ['capture', '--include-excerpts']]) {
    const root = fixture();
    const result = run(root, args);
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'process-data')), false);
  }
});

test('unknown data subcommand fails without creating the default root', () => {
  const root = fixture();
  const result = run(root, ['unknown']);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'process-data')), false);
});

test('data help exposes the v2 export as-of option', () => {
  const root = fixture();
  const result = run(root, ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /export .*--as-of <ISO>/);
});

test('full capture uses explicit GitHub pages through a fake gh boundary', () => {
  const root = fixture();
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
  const result = run(root, ['capture'], {
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
  visit(path.join(root, '.agents', 'workspace', 'process-data', 'snapshots'));
  const manifest = JSON.parse(fs.readFileSync(manifestFiles[0]!, 'utf8'));
  assert.equal(manifest.schema, 'raw-manifest/v2');
  assert.equal(manifest.endpoints.length, 4);
  assert.equal(manifest.endpoints.every((endpoint: { pages: unknown[] }) => endpoint.pages.length === 1), true);
});
