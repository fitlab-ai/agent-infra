import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyTaskLifecycle, lifecycleIntentCatalog } from '../../../lib/task/lifecycle.ts';

const TASK_ID = 'TASK-20260101-000001';
const METADATA = {
  timestamp: '2026-07-18 12:00:00+00:00',
  agentInfraVersion: 'v9.9.9'
};

function fixture(state: 'active' | 'blocked' = 'active') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lifecycle-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', state, TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents', 'workspace', 'active'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(
    path.join(taskDir, 'task.md'),
    `---\nid: ${TASK_ID}\nstatus: ${state}\ncurrent_step: code-review\nassigned_to: claude\nupdated_at: old\nagent_infra_version: old\ntarget_date:\n${state === 'blocked' ? 'blocked_at: old\n' : ''}---\n\n# Task\n\n## Activity Log\n\n`
  );
  if (state === 'active') {
    fs.writeFileSync(path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } }, null, 2)}\n`);
  }
  return { repoRoot, taskDir };
}

test('lifecycle catalog exposes the approved closed intent set', () => {
  assert.deepEqual(lifecycleIntentCatalog, [
    'block', 'activate', 'cancel', 'complete', 'close-codescan', 'close-dependabot', 'restore'
  ]);
});

test('block moves the task, updates one metadata pair, logs a pair, and releases its short id', () => {
  const f = fixture();
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Dependency lands' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.shortId.effect, 'released');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'blocked', TASK_ID, 'task.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /status: blocked/);
  assert.match(content, /blocked_at: 2026-07-18 12:00:00\+00:00/);
  assert.match(content, /agent_infra_version: v9\.9\.9/);
  assert.equal((content.match(/Block Task/g) ?? []).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), 'utf8')).ids, {});
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)), false);
});

test('dry-run plans the same transition without changing bytes, mtime, directories, or registry', () => {
  const f = fixture();
  const taskFile = path.join(f.taskDir, 'task.md');
  const registry = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  const beforeTask = fs.readFileSync(taskFile);
  const beforeRegistry = fs.readFileSync(registry);
  const beforeMtime = fs.statSync(taskFile).mtimeMs;
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'complete', agent: 'codex', dryRun: true },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'planned');
  assert.deepEqual(fs.readFileSync(taskFile), beforeTask);
  assert.deepEqual(fs.readFileSync(registry), beforeRegistry);
  assert.equal(fs.statSync(taskFile).mtimeMs, beforeMtime);
  assert.equal(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);
});

test('invalid transition fails before any side effect', () => {
  const f = fixture('blocked');
  const file = path.join(f.taskDir, 'task.md');
  const before = fs.readFileSync(file);
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'complete', agent: 'codex' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'LIFECYCLE_SOURCE_INVALID');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), false);
});

test('same completed intent replays as no-op without duplicate log entries', () => {
  const f = fixture();
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  assert.equal(applyTaskLifecycle(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA }).status, 'applied');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md');
  const before = fs.readFileSync(target);
  const replay = applyTaskLifecycle(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
  assert.equal(replay.status, 'no-op');
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal((fs.readFileSync(target, 'utf8').match(/Complete Task/g) ?? []).length, 2);
});

test('activate clears terminal fields, moves to active, and allocates a short id', () => {
  const f = fixture('blocked');
  fs.appendFileSync(path.join(f.taskDir, 'task.md'), '');
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'activate', agent: 'codex', note: 'Dependency landed' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.shortId.effect, 'allocated');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md');
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /status: active/);
  assert.match(content, /assigned_to: codex/);
  assert.equal(/^blocked_at:/m.test(content), false);
  assert.equal(result.shortId.shortId, '#01');
});

test('security completion records the alert payload in its canonical done note', () => {
  const f = fixture();
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'close-codescan', agent: 'codex', alertNumber: 17, reason: 'false positive' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
  assert.match(content, /Code Scanning alert #17 dismissed: false positive/);
});

test('restore validates staging before exposing active and allocates a short id', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-restore-'));
  const staging = path.join(repoRoot, '.agents', 'workspace', '.restore-staging-1');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(staging, 'task.md'), `---\nid: ${TASK_ID}\nissue_number: 42\nstatus: completed\ncurrent_step: code-review\nupdated_at: old\nagent_infra_version: old\n---\n\n# Task\n\n## Activity Log\n\n`);
  fs.writeFileSync(path.join(staging, 'analysis.md'), '# Analysis\n');
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'restore', agent: 'codex', stagingDir: staging, issueNumber: 42 },
    { repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'applied');
  assert.equal(fs.existsSync(staging), false);
  const target = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'task.md');
  assert.match(fs.readFileSync(target, 'utf8'), /status: active/);
  assert.equal(result.shortId.shortId, '#01');
});

test('registry failure leaves a recoverable journal and the same request converges after repair', () => {
  const f = fixture();
  const registry = path.join(f.repoRoot, '.agents', 'workspace', 'active', '.short-ids.json');
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  const failed = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA,
    directoryRenameSync: (source, target) => {
      fs.renameSync(source, target);
      fs.writeFileSync(registry, '{broken');
    }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.completedSteps.includes('directory-moved'), true);
  const targetDir = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID);
  assert.equal(fs.existsSync(path.join(targetDir, '.task-lifecycle.json')), true);
  fs.writeFileSync(registry, `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  const recovered = applyTaskLifecycle(request, { repoRoot: f.repoRoot, metadataProvider: () => ({ timestamp: 'different', agentInfraVersion: 'different' }) });
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.existsSync(path.join(targetDir, '.task-lifecycle.json')), false);
  const content = fs.readFileSync(path.join(targetDir, 'task.md'), 'utf8');
  assert.equal((content.match(/Complete Task/g) ?? []).length, 2);
  assert.match(content, /updated_at: 2026-07-18 12:00:00\+00:00/);
});

test('duplicate hot directories are rejected before either copy changes', () => {
  const f = fixture();
  const duplicate = path.join(f.repoRoot, '.agents', 'workspace', 'blocked', TASK_ID);
  fs.mkdirSync(path.dirname(duplicate), { recursive: true });
  fs.cpSync(f.taskDir, duplicate, { recursive: true });
  const before = fs.readFileSync(path.join(f.taskDir, 'task.md'));
  const result = applyTaskLifecycle(
    { taskRef: TASK_ID, intent: 'block', agent: 'codex', reason: 'Waiting', unblockCondition: 'Ready' },
    { repoRoot: f.repoRoot, metadataProvider: () => METADATA }
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'LIFECYCLE_IDENTITY_CONFLICT');
  assert.deepEqual(fs.readFileSync(path.join(f.taskDir, 'task.md')), before);
});

test('task write failure preserves source bytes and retries with journal metadata', () => {
  const f = fixture();
  const file = path.join(f.taskDir, 'task.md');
  const before = fs.readFileSync(file);
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  const failed = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA,
    taskFileSystem: { renameSync: () => { throw new Error('injected task rename failure'); } }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'RENAME_FAILED');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), true);
  const recovered = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot,
    metadataProvider: () => ({ timestamp: 'different', agentInfraVersion: 'different' })
  });
  assert.equal(recovered.status, 'applied');
  const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
  assert.match(content, /updated_at: 2026-07-18 12:00:00\+00:00/);
});

test('directory rename failure keeps the journal at source and retries without duplicate logs', () => {
  const f = fixture();
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  const failed = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA,
    directoryRenameSync: () => { throw new Error('injected directory rename failure'); }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'LIFECYCLE_DIRECTORY_RENAME_FAILED');
  assert.equal(fs.existsSync(path.join(f.taskDir, '.task-lifecycle.json')), true);
  const recovered = applyTaskLifecycle(request, { repoRoot: f.repoRoot });
  assert.equal(recovered.status, 'applied');
  const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
  assert.equal((content.match(/Complete Task/g) ?? []).length, 2);
});

test('journal step write failure after directory move is reconstructed on retry', () => {
  const f = fixture();
  const request = { taskRef: TASK_ID, intent: 'complete' as const, agent: 'codex' };
  let renames = 0;
  const failed = applyTaskLifecycle(request, {
    repoRoot: f.repoRoot, metadataProvider: () => METADATA,
    directoryRenameSync: (source, target) => fs.renameSync(source, target),
    fileSystem: {
      renameSync: (source, target) => {
        renames += 1;
        if (renames === 3) throw new Error('injected journal step failure');
        fs.renameSync(source, target);
      }
    }
  });
  assert.equal(failed.status, 'failed');
  const target = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID);
  assert.equal(fs.existsSync(path.join(target, '.task-lifecycle.json')), true);
  const recovered = applyTaskLifecycle(request, { repoRoot: f.repoRoot });
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.existsSync(path.join(target, '.task-lifecycle.json')), false);
  assert.equal((fs.readFileSync(path.join(target, 'task.md'), 'utf8').match(/Complete Task/g) ?? []).length, 2);
});
