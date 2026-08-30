import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTaskRef } from '../../../lib/task/resolve-ref.ts';
import { writeTask } from '../../../lib/task/write.ts';

const TASK_ID = 'TASK-20260101-000001';
const METADATA = { timestamp: '2026-07-15 12:34:56+00:00', agentInfraVersion: 'v9.9.9' };

type FixtureState = 'active' | 'blocked' | 'completed' | 'archive';

function fixture(state: FixtureState = 'active') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-write-'));
  const taskDir = state === 'archive'
    ? path.join(repoRoot, '.agents', 'workspace', 'archive', '2026', '07', '15', TASK_ID)
    : path.join(repoRoot, '.agents', 'workspace', state, TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), '{"task":{"shortIdLength":2}}\n');
  const taskMdPath = path.join(taskDir, 'task.md');
  fs.writeFileSync(
    taskMdPath,
    `---\nid: ${TASK_ID}\nstatus: ${state}\nupdated_at: old\nagent_infra_version: v0.0.1\n---\n# Task\n\n${state === 'active' ? '## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n\n' : ''}## Notes\n\nold\n`
  );
  if (state === 'active') {
    fs.writeFileSync(
      path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'),
      JSON.stringify({ version: 1, ids: { '01': TASK_ID } })
    );
  }
  return { repoRoot, taskDir, taskMdPath };
}

test('resolveTaskRef maps full and short refs without changing the registry', () => {
  const { repoRoot, taskMdPath } = fixture();
  const registry = path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  const before = fs.readFileSync(registry);
  const beforeMtime = fs.statSync(registry).mtimeMs;
  assert.deepEqual(resolveTaskRef('1', { repoRoot }), {
    ok: true,
    repoRoot,
    taskId: TASK_ID,
    taskDir: path.dirname(taskMdPath),
    taskMdPath,
    state: 'active'
  });
  assert.equal(resolveTaskRef('#01', { repoRoot }).ok, false);
  assert.equal(resolveTaskRef(TASK_ID, { repoRoot }).ok, true);
  assert.deepEqual(fs.readFileSync(registry), before);
  assert.equal(fs.statSync(registry).mtimeMs, beforeMtime);
});

test('resolveTaskRef returns stable codes for invalid, missing, stale and duplicate refs', () => {
  const { repoRoot } = fixture();
  const invalid = resolveTaskRef('bad', { repoRoot });
  assert.equal(invalid.ok ? null : invalid.code, 'INVALID_TASK_REF');
  const reserved = resolveTaskRef('0', { repoRoot });
  assert.equal(reserved.ok ? null : reserved.code, 'SHORT_ID_RESERVED');
  const missing = resolveTaskRef('2', { repoRoot });
  assert.equal(missing.ok ? null : missing.code, 'SHORT_ID_NOT_FOUND');

  const registry = path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, ids: { '01': TASK_ID, '02': TASK_ID } }));
  const duplicate = resolveTaskRef('1', { repoRoot });
  assert.equal(duplicate.ok ? null : duplicate.code, 'SHORT_ID_REGISTRY_DUPLICATE_TASK');
  fs.writeFileSync(registry, JSON.stringify({ version: 1, ids: { '01': 'TASK-20260101-000002' } }));
  const stale = resolveTaskRef('1', { repoRoot });
  assert.equal(stale.ok ? null : stale.code, 'SHORT_ID_STALE');
  assert.equal(stale.ok ? null : stale.taskId, 'TASK-20260101-000002');
});

test('resolveTaskRef distinguishes registry storage failures', () => {
  const { repoRoot } = fixture();
  const registry = path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  fs.rmSync(registry);
  let result = resolveTaskRef('1', { repoRoot });
  assert.equal(result.ok ? null : result.code, 'SHORT_ID_REGISTRY_NOT_FOUND');

  fs.writeFileSync(registry, '{');
  result = resolveTaskRef('1', { repoRoot });
  assert.equal(result.ok ? null : result.code, 'SHORT_ID_REGISTRY_INVALID_JSON');

  fs.writeFileSync(registry, JSON.stringify({ version: 2, ids: {} }));
  result = resolveTaskRef('1', { repoRoot });
  assert.equal(result.ok ? null : result.code, 'SHORT_ID_REGISTRY_INVALID_SCHEMA');

  fs.rmSync(registry);
  fs.mkdirSync(registry);
  result = resolveTaskRef('1', { repoRoot });
  assert.equal(result.ok ? null : result.code, 'SHORT_ID_REGISTRY_READ_FAILED');
});

test('resolveTaskRef reports all workspace states for full task ids', () => {
  for (const state of ['active', 'blocked', 'completed', 'archive'] as const) {
    const { repoRoot } = fixture(state);
    const result = resolveTaskRef(TASK_ID, { repoRoot });
    assert.equal(result.ok && result.state, state);
  }
});

test('writeTask enforces the complete workspace state match and mismatch matrix', () => {
  const states = ['active', 'blocked', 'completed', 'archive'] as const;
  for (const [index, actualState] of states.entries()) {
    const matched = fixture(actualState);
    const applied = writeTask(
      {
        taskRef: TASK_ID,
        expectedState: actualState,
        mutations: [{ kind: 'frontmatter', set: { status: `matched-${actualState}` } }]
      },
      {
        repoRoot: matched.repoRoot,
        metadataProvider: () => METADATA,
        randomSuffix: () => `matched-${actualState}`
      }
    );
    assert.equal(applied.status, 'applied');
    assert.equal(applied.actualState, actualState);
    assert.match(fs.readFileSync(matched.taskMdPath, 'utf8'), new RegExp(`status: matched-${actualState}`));
    assert.deepEqual(fs.readdirSync(matched.taskDir), ['task.md']);

    const mismatched = fixture(actualState);
    const before = fs.readFileSync(mismatched.taskMdPath);
    const beforeMtime = fs.statSync(mismatched.taskMdPath).mtimeMs;
    const beforeFiles = fs.readdirSync(mismatched.taskDir);
    let metadataCalls = 0;
    const expectedState = states[(index + 1) % states.length]!;
    const rejected = writeTask(
      {
        taskRef: TASK_ID,
        expectedState,
        mutations: [{ kind: 'frontmatter', set: { status: 'must-not-write' } }]
      },
      {
        repoRoot: mismatched.repoRoot,
        metadataProvider: () => { metadataCalls += 1; return METADATA; }
      }
    );
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error?.code, 'TASK_STATE_MISMATCH');
    assert.equal(rejected.actualState, actualState);
    assert.equal(metadataCalls, 0);
    assert.deepEqual(fs.readFileSync(mismatched.taskMdPath), before);
    assert.equal(fs.statSync(mismatched.taskMdPath).mtimeMs, beforeMtime);
    assert.deepEqual(fs.readdirSync(mismatched.taskDir), beforeFiles);
  }
});

test('writeTask returns a dry-run plan without changing bytes, mtime or directory', () => {
  const { repoRoot, taskDir, taskMdPath } = fixture();
  const before = fs.readFileSync(taskMdPath);
  const beforeMtime = fs.statSync(taskMdPath).mtimeMs;
  const beforeFiles = fs.readdirSync(taskDir);
  const result = writeTask(
    {
      taskRef: '1',
      expectedState: 'active',
      dryRun: true,
      mutations: [{ kind: 'section', aliases: ['Notes'], heading: 'Notes', body: 'new' }]
    },
    { repoRoot, metadataProvider: () => METADATA, randomSuffix: () => 'dry' }
  );
  assert.equal(result.status, 'planned');
  assert.equal(result.changed, true);
  assert.equal(result.timestamp, METADATA.timestamp);
  assert.equal(result.agentInfraVersion, METADATA.agentInfraVersion);
  assert.deepEqual(result.operations, [
    {
      index: 0,
      kind: 'section',
      heading: 'Notes',
      operation: 'update',
      wouldChange: true
    },
    {
      index: -1,
      kind: 'metadata',
      fields: ['updated_at', 'agent_infra_version'],
      wouldChange: true
    }
  ]);
  assert.deepEqual(fs.readFileSync(taskMdPath), before);
  assert.equal(fs.statSync(taskMdPath).mtimeMs, beforeMtime);
  assert.deepEqual(fs.readdirSync(taskDir), beforeFiles);
});

test('writeTask reports cancellation as no-op while retaining operation facts', () => {
  const { repoRoot, taskDir, taskMdPath } = fixture();
  const before = fs.readFileSync(taskMdPath);
  const beforeMtime = fs.statSync(taskMdPath).mtimeMs;
  const beforeFiles = fs.readdirSync(taskDir);
  let providerCalls = 0;
  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [
        { kind: 'frontmatter', set: { status: 'changed' } },
        { kind: 'frontmatter', set: { status: 'active' } }
      ]
    },
    { repoRoot, metadataProvider: () => { providerCalls += 1; return METADATA; } }
  );
  assert.equal(result.status, 'no-op');
  assert.equal(result.changed, false);
  assert.deepEqual(result.operations.map((operation) => operation.wouldChange), [true, true]);
  assert.equal(providerCalls, 1);
  assert.deepEqual(fs.readFileSync(taskMdPath), before);
  assert.equal(fs.statSync(taskMdPath).mtimeMs, beforeMtime);
  assert.deepEqual(fs.readdirSync(taskDir), beforeFiles);
});

test('writeTask applies one metadata sample atomically and repeated mutation is no-op', () => {
  const { repoRoot, taskDir, taskMdPath } = fixture();
  const request = {
    taskRef: TASK_ID,
    expectedState: 'active' as const,
    mutations: [{ kind: 'section' as const, aliases: ['Notes'], heading: 'Notes', body: 'new' }]
  };
  const applied = writeTask(request, {
    repoRoot,
    metadataProvider: () => METADATA,
    randomSuffix: () => 'apply'
  });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.operations.at(-1)?.kind, 'metadata');
  assert.match(fs.readFileSync(taskMdPath, 'utf8'), /updated_at: 2026-07-15 12:34:56\+00:00/);
  assert.deepEqual(fs.readdirSync(taskDir), ['task.md']);

  const repeated = writeTask(request, { repoRoot, metadataProvider: () => METADATA });
  assert.equal(repeated.status, 'no-op');
  assert.equal(repeated.operations.length, 1);
});

test('writeTask records metadata wouldChange false when automatic fields already match', () => {
  const { repoRoot, taskMdPath } = fixture();
  let content = fs.readFileSync(taskMdPath, 'utf8');
  content = content.replace('updated_at: old', `updated_at: ${METADATA.timestamp}`)
    .replace('agent_infra_version: v0.0.1', `agent_infra_version: ${METADATA.agentInfraVersion}`);
  fs.writeFileSync(taskMdPath, content);
  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      dryRun: true,
      mutations: [{ kind: 'section', aliases: ['Notes'], heading: 'Notes', body: 'new' }]
    },
    { repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'planned');
  assert.deepEqual(result.operations.at(-1), {
    index: -1,
    kind: 'metadata',
    fields: ['updated_at', 'agent_infra_version'],
    wouldChange: false
  });
});

test('writeTask rejects state mismatch before metadata or temp work', () => {
  const { repoRoot, taskDir } = fixture('blocked');
  let calls = 0;
  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'active' } }]
    },
    { repoRoot, metadataProvider: () => { calls += 1; return METADATA; } }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TASK_STATE_MISMATCH');
  assert.equal(result.taskId, TASK_ID);
  assert.equal(result.actualState, 'blocked');
  assert.equal(result.timestamp, null);
  assert.deepEqual(result.operations, []);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(taskDir), ['task.md']);
});

test('writeTask normalizes table keys before matching, summarizing and inserting', () => {
  const { repoRoot, taskDir, taskMdPath } = fixture();
  fs.appendFileSync(taskMdPath, '\n## IDs\n\n| id |\n|----|\n');
  let metadataCalls = 0;
  const request = {
    taskRef: TASK_ID,
    expectedState: 'active' as const,
    mutations: [{
      kind: 'table-row' as const,
      action: 'upsert' as const,
      sectionAliases: ['IDs'],
      columns: ['id'],
      keyColumn: 'id',
      key: ' A ',
      values: {}
    }]
  };
  const options = {
    repoRoot,
    metadataProvider: () => { metadataCalls += 1; return METADATA; }
  };

  const applied = writeTask(request, options);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.operations[0]?.kind, 'table-row');
  assert.equal(applied.operations[0]?.key, 'A');
  assert.match(fs.readFileSync(taskMdPath, 'utf8'), /\| A \|/);

  const afterApplied = fs.readFileSync(taskMdPath);
  const afterAppliedMtime = fs.statSync(taskMdPath).mtimeMs;
  const afterAppliedFiles = fs.readdirSync(taskDir);
  const repeated = writeTask(request, options);
  assert.equal(repeated.status, 'no-op');
  assert.equal(repeated.operations[0]?.kind, 'table-row');
  assert.equal(repeated.operations[0]?.key, 'A');
  assert.equal(repeated.operations[0]?.wouldChange, false);
  assert.equal(metadataCalls, 2);
  assert.deepEqual(fs.readFileSync(taskMdPath), afterApplied);
  assert.equal(fs.statSync(taskMdPath).mtimeMs, afterAppliedMtime);
  assert.deepEqual(fs.readdirSync(taskDir), afterAppliedFiles);
});

test('writeTask cleans temp files after rename failure and reports cleanup failure distinctly', () => {
  const { repoRoot, taskDir } = fixture();
  const renameFailure = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'changed' } }]
    },
    {
      repoRoot,
      metadataProvider: () => METADATA,
      randomSuffix: () => 'rename-fail',
      fileSystem: { renameSync: () => { throw new Error('rename denied'); } }
    }
  );
  assert.equal(renameFailure.status, 'failed');
  assert.equal(renameFailure.error?.code, 'RENAME_FAILED');
  assert.deepEqual(fs.readdirSync(taskDir), ['task.md']);

  const cleanupFailure = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'changed' } }]
    },
    {
      repoRoot,
      metadataProvider: () => METADATA,
      randomSuffix: () => 'cleanup-fail',
      fileSystem: {
        renameSync: () => { throw new Error('rename denied'); },
        unlinkSync: () => { throw new Error('cleanup denied'); }
      }
    }
  );
  assert.equal(cleanupFailure.status, 'failed');
  assert.equal(cleanupFailure.error?.code, 'TEMP_CLEANUP_FAILED');
  assert.match(cleanupFailure.error?.message ?? '', /RENAME_FAILED/);
  fs.rmSync(path.join(taskDir, '.task.md.' + process.pid + '.cleanup-fail.tmp'));
});

test('writeTask maps metadata and temp-write failures without changing the task', () => {
  const { repoRoot, taskMdPath, taskDir } = fixture();
  const before = fs.readFileSync(taskMdPath);
  const request = {
    taskRef: TASK_ID,
    expectedState: 'active' as const,
    mutations: [{ kind: 'frontmatter' as const, set: { status: 'changed' } }]
  };

  const metadataFailure = writeTask(request, {
    repoRoot,
    metadataProvider: () => { throw new Error('clock unavailable'); }
  });
  assert.equal(metadataFailure.status, 'failed');
  assert.equal(metadataFailure.error?.code, 'METADATA_CAPTURE_FAILED');
  assert.equal(metadataFailure.timestamp, null);
  assert.equal(metadataFailure.operations.length, 1);

  const writeFailure = writeTask(request, {
    repoRoot,
    metadataProvider: () => METADATA,
    randomSuffix: () => 'write-fail',
    fileSystem: { writeFileSync: () => { throw new Error('disk full'); } }
  });
  assert.equal(writeFailure.status, 'failed');
  assert.equal(writeFailure.error?.code, 'TEMP_WRITE_FAILED');
  assert.equal(writeFailure.timestamp, METADATA.timestamp);
  assert.deepEqual(fs.readFileSync(taskMdPath), before);
  assert.deepEqual(fs.readdirSync(taskDir), ['task.md']);
});

test('writeTask preserves a pre-existing temp file after a default filesystem collision', () => {
  const { repoRoot, taskDir } = fixture();
  const suffix = 'collision-default';
  const tempPath = path.join(taskDir, `.task.md.${process.pid}.${suffix}.tmp`);
  const collisionBytes = Buffer.from('pre-existing collision bytes');
  fs.writeFileSync(tempPath, collisionBytes);

  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'changed' } }]
    },
    { repoRoot, metadataProvider: () => METADATA, randomSuffix: () => suffix }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TEMP_WRITE_FAILED');
  assert.deepEqual(fs.readFileSync(tempPath), collisionBytes);
});

test('writeTask does not call injected cleanup when temp creation reports EEXIST', () => {
  const { repoRoot } = fixture();
  let cleanupCalls = 0;
  const collision = Object.assign(new Error('temp exists'), { code: 'EEXIST' });
  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'changed' } }]
    },
    {
      repoRoot,
      metadataProvider: () => METADATA,
      randomSuffix: () => 'collision-injected',
      fileSystem: {
        writeFileSync: () => { throw collision; },
        unlinkSync: () => { cleanupCalls += 1; }
      }
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TEMP_WRITE_FAILED');
  assert.equal(cleanupCalls, 0);
});

test('writeTask maps read and document validation failures before metadata sampling', () => {
  const { repoRoot, taskMdPath } = fixture();
  let calls = 0;
  const request = {
    taskRef: TASK_ID,
    expectedState: 'active' as const,
    mutations: [{ kind: 'frontmatter' as const, set: { status: 'changed' } }]
  };
  const readFailure = writeTask(request, {
    repoRoot,
    metadataProvider: () => { calls += 1; return METADATA; },
    fileSystem: { readFileSync: () => { throw new Error('read denied'); } }
  });
  assert.equal(readFailure.status, 'failed');
  assert.equal(readFailure.error?.code, 'TASK_READ_FAILED');
  assert.equal(calls, 0);

  fs.writeFileSync(taskMdPath, 'not frontmatter\n');
  const documentFailure = writeTask(request, {
    repoRoot,
    metadataProvider: () => { calls += 1; return METADATA; }
  });
  assert.equal(documentFailure.status, 'failed');
  assert.equal(documentFailure.error?.code, 'TASK_DOCUMENT_INVALID');
  assert.equal(calls, 0);
});

test('writeTask rejects an active task with a missing current contract before mutation or metadata capture', () => {
  const { repoRoot, taskMdPath } = fixture();
  const before = fs.readFileSync(taskMdPath);
  fs.writeFileSync(taskMdPath, before.toString().replace('agent_infra_version: v0.0.1\n', ''));
  let metadataCalls = 0;
  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'changed' } }]
    },
    { repoRoot, metadataProvider: () => { metadataCalls += 1; return METADATA; } }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TASK_CURRENT_CONTRACT_INVALID');
  assert.match(result.error?.message ?? '', /agent_infra_version/);
  assert.equal(metadataCalls, 0);
  assert.equal(fs.readFileSync(taskMdPath, 'utf8'), before.toString().replace('agent_infra_version: v0.0.1\n', ''));
});

test('writeTask rejects an active task with a missing ledger before mutation or metadata capture', () => {
  const { repoRoot, taskMdPath } = fixture();
  const before = fs.readFileSync(taskMdPath, 'utf8');
  fs.writeFileSync(taskMdPath, before.replace(/## Review Disagreement Ledger[\s\S]*?## Notes\n/, '## Notes\n'));
  let metadataCalls = 0;
  const result = writeTask(
    {
      taskRef: TASK_ID,
      expectedState: 'active',
      mutations: [{ kind: 'frontmatter', set: { status: 'changed' } }]
    },
    { repoRoot, metadataProvider: () => { metadataCalls += 1; return METADATA; } }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'TASK_CURRENT_CONTRACT_INVALID');
  assert.match(result.error?.message ?? '', /ledger/);
  assert.equal(metadataCalls, 0);
  assert.equal(fs.readFileSync(taskMdPath, 'utf8'), before.replace(/## Review Disagreement Ledger[\s\S]*?## Notes\n/, '## Notes\n'));
});
