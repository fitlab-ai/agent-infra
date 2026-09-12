import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseTypedTaskFrontmatter } from '../../../lib/task/frontmatter.ts';
import { migrateActiveTaskMetadata } from '../../../lib/task/one-time-active-migration.ts';

const TASK_ID = 'TASK-20260101-000001';

function legacyFact() {
  return {
    version: 1,
    state: 'bound',
    identity: {
      repository: 'acme/widgets', number: 42, nodeId: 'PR_node_42',
      url: 'https://github.com/acme/widgets/pull/42',
      head: { repository: 'acme/widgets', ref: 'feature', sha: 'a'.repeat(40) },
      base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) }
    },
    binding: {
      status: 'verified', source: 'created', verifiedAt: '2026-01-01T00:00:00+08:00',
      issueNumber: 7, remoteState: 'open', mergedAt: null, mergeCommitSha: null
    },
    provenance: { establishedBy: 'create-post' }
  };
}

function fixture(): { root: string; taskPath: string; migrationRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-task-migration-'));
  const taskDir = path.join(root, '.agents', 'workspace', 'active', TASK_ID);
  const migrationRoot = path.join(root, '.agents', 'workspace', 'migrations');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(migrationRoot, { recursive: true });
  const taskPath = path.join(taskDir, 'task.md');
  fs.writeFileSync(taskPath, `---\nid: ${TASK_ID}\nstatus: active\nissue_number: 7\npr_delivery_fact: ${JSON.stringify(JSON.stringify(legacyFact()))}\n---\n\n# Task\n\n## Activity Log\n`);
  return { root, taskPath, migrationRoot };
}

test('one-time active migration converts legacy identity and PR fact with a completed manifest', () => {
  const f = fixture();
  try {
    const result = migrateActiveTaskMetadata(f.root, {
      authority: 'direct-host',
      repository: 'acme/widgets',
      provider: {
        name: 'test-provider',
        canRead: true,
        canWrite: true,
        verifyIssueIdentity: () => true,
        verifyPullRequestFact: () => true
      },
      manifestPath: path.join(f.migrationRoot, 'pr-delivery-fact-v1-to-v2.json')
    });
    assert.equal(result.status, 'completed');
    const metadata = parseTypedTaskFrontmatter(fs.readFileSync(f.taskPath, 'utf8'));
    assert.deepEqual(JSON.parse(String(metadata.platform_issue_identity)), { kind: 'number', value: 7 });
    assert.equal(JSON.parse(String(metadata.pr_delivery_fact)).version, 2);
    assert.equal(JSON.parse(String(metadata.pr_delivery_fact)).binding.verifiedAt, '2025-12-31T16:00:00.000Z');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.migrationRoot, 'pr-delivery-fact-v1-to-v2.json'), 'utf8'));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.items[0].beforeDigest !== manifest.items[0].targetDigest, true);
    assert.equal(manifest.items[0].postDigest, manifest.items[0].targetDigest);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('migration fails closed before writing when direct-host authority is missing', () => {
  const f = fixture();
  try {
    assert.throws(
      () => migrateActiveTaskMetadata(f.root, {
        authority: 'task-bound',
        repository: 'acme/widgets',
        provider: { name: 'test-provider', canRead: true, canWrite: true }
      }),
      (error: unknown) => error instanceof Error && error.message.includes('direct-host')
    );
    assert.equal(fs.readFileSync(f.taskPath, 'utf8').includes('issue_number: 7'), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('completed migration manifest is scoped to the same repository and provider', () => {
  const f = fixture();
  const manifestPath = path.join(f.migrationRoot, 'pr-delivery-fact-v1-to-v2.json');
  try {
    const first = migrateActiveTaskMetadata(f.root, {
      authority: 'direct-host',
      repository: 'acme/widgets',
      provider: { name: 'test-provider', canRead: true, canWrite: true },
      manifestPath,
      now: () => '2026-01-01T00:00:00Z'
    });
    assert.equal(first.status, 'completed');
    assert.throws(() => migrateActiveTaskMetadata(f.root, {
      authority: 'direct-host',
      repository: 'other/widgets',
      provider: { name: 'test-provider', canRead: true, canWrite: true },
      manifestPath,
      now: () => '2026-01-01T00:00:00Z'
    }), (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'MIGRATION_MANIFEST_SCOPE_INVALID');
    assert.equal(fs.existsSync(f.taskPath), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('migration rejects conflicting legacy Issue identities before writing', () => {
  const f = fixture();
  try {
    const content = fs.readFileSync(f.taskPath, 'utf8').replace(/issueNumber\\":7/u, 'issueNumber\\":8');
    fs.writeFileSync(f.taskPath, content);
    assert.throws(() => migrateActiveTaskMetadata(f.root, {
      authority: 'direct-host',
      repository: 'acme/widgets',
      provider: { name: 'test-provider', canRead: true, canWrite: true },
      manifestPath: path.join(f.migrationRoot, 'pr-delivery-fact-v1-to-v2.json')
    }), (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'MIGRATION_IDENTITY_CONFLICT');
    assert.equal(fs.readFileSync(f.taskPath, 'utf8').includes('issue_number: 7'), true);
    assert.equal(fs.existsSync(path.join(f.migrationRoot, 'pr-delivery-fact-v1-to-v2.json')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.migrationRoot, 'pr-delivery-fact-v1-to-v2.json'), 'utf8')).status, 'failed');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
