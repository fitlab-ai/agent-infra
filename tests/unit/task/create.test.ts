import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { onPlatforms } from '../../helpers.ts';

import { getProcessStartTime } from '../../../lib/server/process-state.ts';
import {
  canonicalTaskCreateCandidate,
  createLocalTask,
  validateTaskCreateCandidate,
  type TaskCreateCandidateV1
} from '../../../lib/task/create.ts';
import { createTask } from '../../../lib/task/create-service.ts';
import { lockKey } from '../../../lib/task/task-execution-lock.ts';

const candidate: TaskCreateCandidateV1 = {
  version: 1,
  idempotencyKey: '12345678-1234-4123-8123-123456789abc',
  agent: 'codex',
  title: 'Persist sandbox-created tasks',
  type: 'feature',
  branchSlug: 'persist-sandbox-created-tasks',
  priority: 'High',
  effort: 'Medium',
  description: 'Create a host-persisted task through the sandbox control channel.',
  taskInput: {
    sources: ['User request'],
    facts: ['The sandbox workspace root is read-only.'],
    constraints: ['Do not expose arbitrary host commands.'],
    decisions: [],
    alternatives: [],
    acceptanceCriteria: ['The task is visible on the host.'],
    openQuestions: []
  }
};

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-'));
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } }));
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  return root;
}

function writeCreateLockOwner(root: string, owner: Readonly<{ pid: number; startTime: number }>): string {
  const lockRoot = path.join(root, '.agents', 'workspace', '.task-create.lock');
  fs.mkdirSync(lockRoot, { recursive: true });
  const { canonicalRepoRoot, key } = lockKey(root, 'task-create');
  const fixed = path.join(lockRoot, `${key}.lock`);
  fs.writeFileSync(fixed, `${JSON.stringify({
    version: 2,
    pid: owner.pid,
    startTime: owner.startTime,
    token: 'test-owner',
    owner: 'task-create',
    canonicalRepoRoot,
    taskId: 'task-create',
    acquiredAt: '2026-08-13T00:00:00.000Z'
  })}\n`);
  return fixed;
}

test('task-create candidate validation rejects unknown fields and invalid slugs', () => {
  assert.throws(
    () => validateTaskCreateCandidate({ ...candidate, unexpected: true }),
    /TASK_CREATE_PAYLOAD_INVALID/
  );
  assert.throws(
    () => validateTaskCreateCandidate({ ...candidate, branchSlug: '../escape' }),
    /TASK_CREATE_PAYLOAD_INVALID/
  );
});

test('local task creation rejects an invalid explicit version before creating workspace state', () => {
  const root = fixture();
  try {
    assert.throws(
      () => createLocalTask(candidate, { repoRoot: root, agentInfraVersion: 'unknown' }),
      /TASK_CREATE_VERSION_INVALID/
    );
    assert.deepEqual(fs.readdirSync(path.join(root, '.agents', 'workspace', 'active')), []);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', '.task-create')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical candidate digest ignores JSON key order but preserves value changes', () => {
  const reordered = {
    taskInput: {
      openQuestions: [], acceptanceCriteria: ['The task is visible on the host.'], alternatives: [],
      decisions: [], constraints: ['Do not expose arbitrary host commands.'],
      facts: ['The sandbox workspace root is read-only.'], sources: ['User request']
    },
    description: candidate.description,
    effort: candidate.effort,
    priority: candidate.priority,
    branchSlug: candidate.branchSlug,
    type: candidate.type,
    title: candidate.title,
    agent: candidate.agent,
    idempotencyKey: candidate.idempotencyKey,
    version: 1
  };
  const validated = validateTaskCreateCandidate(reordered);
  assert.equal(canonicalTaskCreateCandidate(validated), canonicalTaskCreateCandidate(candidate));
  assert.notEqual(
    canonicalTaskCreateCandidate({ ...candidate, title: 'A different task' }),
    canonicalTaskCreateCandidate(candidate)
  );
});

test('local task creation is idempotent and rejects key reuse with changed content', () => {
  const root = fixture();
  try {
    const options = {
      repoRoot: root,
      now: () => new Date(2026, 7, 13, 1, 2, 3),
      agentInfraVersion: 'v0.9.5'
    };
    const first = createLocalTask(candidate, options);
    assert.equal(first.status, 'applied');
    assert.equal(first.task.id, 'TASK-20260813-010203');
    assert.equal(first.task.shortId, '01');
    const taskMd = fs.readFileSync(path.join(root, '.agents', 'workspace', 'active', first.task.id, 'task.md'), 'utf8');
    assert.match(taskMd, /^assigned_to: codex$/m);
    assert.match(taskMd, /^branch: demo-feature-persist-sandbox-created-tasks$/m);

    const retry = createLocalTask(candidate, options);
    assert.equal(retry.status, 'no-op');
    assert.deepEqual(retry.task, first.task);

    fs.rmSync(path.join(root, '.agents', 'workspace', '.task-create'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'workspace', 'active', '.short-ids.json'), '{"version":1,"ids":{}}\n');
    const recovered = createLocalTask(candidate, options);
    assert.equal(recovered.status, 'no-op');
    assert.deepEqual(recovered.task, first.task);

    assert.throws(
      () => createLocalTask({ ...candidate, title: 'Changed title' }, options),
      /TASK_CREATE_IDEMPOTENCY_CONFLICT/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local task creation safely restores missing runtime workspace directories', () => {
  const root = fixture();
  try {
    fs.rmSync(path.join(root, '.agents', 'workspace'), { recursive: true });
    const result = createLocalTask(candidate, {
      repoRoot: root,
      now: () => new Date(2026, 7, 13, 1, 2, 3),
      agentInfraVersion: 'v0.9.5'
    });
    assert.equal(result.status, 'applied');
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', result.task.id, 'task.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local task creation rejects a symbolic-link workspace without writing outside the repository', onPlatforms('linux', 'darwin'), () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-task-create-outside-'));
  try {
    fs.rmSync(path.join(root, '.agents', 'workspace'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, '.agents', 'workspace'));
    assert.throws(() => createLocalTask(candidate, { repoRoot: root }), /TASK_CREATE_WORKSPACE_INVALID/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('same-second task creation advances to the next free TASK-id', () => {
  const root = fixture();
  try {
    const options = {
      repoRoot: root,
      now: () => new Date(2026, 7, 13, 1, 2, 3),
      agentInfraVersion: 'v0.9.5'
    };
    const first = createLocalTask(candidate, options);
    const second = createLocalTask({
      ...candidate,
      idempotencyKey: '22345678-1234-4123-8123-123456789abc',
      title: 'Second task'
    }, options);
    assert.equal(first.task.id, 'TASK-20260813-010203');
    assert.equal(second.task.id, 'TASK-20260813-010204');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local task creation reclaims a lock whose process identity is stale', () => {
  const root = fixture();
  try {
    const fixed = writeCreateLockOwner(root, { pid: 999_999_999, startTime: 0 });
    const result = createLocalTask(candidate, {
      repoRoot: root,
      now: () => new Date(2026, 7, 13, 1, 2, 3),
      agentInfraVersion: 'v0.9.5'
    });
    assert.equal(result.status, 'applied');
    assert.equal(fs.existsSync(fixed), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local task creation preserves a lock owned by the current process', () => {
  const root = fixture();
  const startTime = getProcessStartTime(process.pid);
  assert.ok(startTime);
  try {
    const fixed = writeCreateLockOwner(root, { pid: process.pid, startTime });
    assert.throws(
      () => createLocalTask(candidate, {
        repoRoot: root,
        agentInfraVersion: 'v0.9.5'
      }),
      /TASK_CREATE_LOCK_TIMEOUT/
    );
    assert.equal(fs.existsSync(fixed), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('platform failure preserves the local task and records a warning intent', () => {
  const root = fixture();
  let warningTask: string | null = null;
  try {
    const result = createTask(candidate, {
      repoRoot: root,
      agentInfraVersion: 'v0.9.5',
      dependencies: {
        createIssue: (() => ({
          status: 'failed', changed: false,
          platform: { type: 'github', repository: 'owner/repo', currentUser: 'bot' },
          resource: { kind: 'repository', number: null },
          capabilities: { authenticated: true, comment: true, triage: true, push: true, admin: false },
          operations: [{ name: 'issue:create', status: 'failed', reasonCode: 'NETWORK' }],
          comment: null,
          error: { code: 'NETWORK', message: 'offline', retryable: false },
          task: { id: null, issueNumber: null }, issue: null
        })) as never,
        addWarning: ((intent: { taskRef: string }) => {
          warningTask = intent.taskRef;
          return { status: 'applied', changed: true };
        }) as never
      }
    });
    assert.equal(result.status, 'degraded');
    assert.equal(result.warnings[0]?.code, 'ISSUE_CREATE_FAILED');
    assert.equal(warningTask, result.task.id);
    assert.equal(fs.existsSync(path.join(root, '.agents', 'workspace', 'active', result.task.id!, 'task.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
