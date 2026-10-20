import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTempDir, isolatedTestHome, onPlatforms } from '../../helpers.ts';

import { mutateShortIdRegistry } from '../../../lib/task/short-id.ts';
import {
  canonicalTaskCreateCandidate,
  createLocalTask,
  validateTaskCreateCandidate,
  type TaskCreateCandidateV1
} from '../../../lib/task/create.ts';
import { parseTaskQualification } from '../../../lib/task/qualification-audit.ts';
import {
  createTask,
  parseTaskCreateResult,
  projectTaskCreateResult,
  taskCreateExitCode,
  taskCreateOutputUnavailableResult
} from '../../../lib/task/create-service.ts';

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
const fixtureHome = isolatedTestHome();

const qualificationCandidate: TaskCreateCandidateV1 = {
  ...candidate,
  title: 'Persist qualified sandbox-created tasks',
  taskInput: {
    ...candidate.taskInput,
    constraints: ['Keep lifecycle routing deterministic.'],
    alternatives: ['Use the canonical task renderer.', 'Add a second qualification writer.']
  }
};

function fixture(home = fixtureHome): string {
  const root = createTempDir('agent-infra-task-create-');
  const project = `task-create-${randomUUID()}`;
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'create-task', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), JSON.stringify({ project, task: { shortIdLength: 2 }, delivery: { remote: 'origin', baseRef: 'main' } }));
  const taskRoot = path.join(home, '.agent-infra', 'task-workspaces', project);
  fs.mkdirSync(path.join(taskRoot, 'active'), { recursive: true });
  fs.copyFileSync(path.resolve('.agents/templates/task.md'), path.join(root, '.agents', 'templates', 'task.md'));
  fs.copyFileSync(path.resolve('.agents/skills/create-task/config/verify.json'), path.join(root, '.agents', 'skills', 'create-task', 'config', 'verify.json'));
  return root;
}

function cleanupFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function workspaceSymlinkFixture(home = fixtureHome) {
  return {
    root: fixture(home),
    outside: createTempDir('agent-infra-task-create-outside-')
  };
}

function taskRoot(root: string): string {
  const project = (JSON.parse(fs.readFileSync(path.join(root, '.agents', '.airc.json'), 'utf8')) as { project: string }).project;
  return path.join(fixtureHome, '.agent-infra', 'task-workspaces', project);
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
    assert.deepEqual(fs.readdirSync(path.join(taskRoot(root), 'active')), []);
  } finally {
    cleanupFixture(root);
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
    const taskMd = fs.readFileSync(path.join(taskRoot(root), 'active', first.task.id, 'task.md'), 'utf8');
    assert.match(taskMd, /^assigned_to: codex$/m);
    const project = (JSON.parse(fs.readFileSync(path.join(root, '.agents', '.airc.json'), 'utf8')) as { project: string }).project;
    assert.match(taskMd, new RegExp(`^branch: ${project}-feature-persist-sandbox-created-tasks$`, 'm'));

    const retry = createLocalTask(candidate, options);
    assert.equal(retry.status, 'no-op');
    assert.deepEqual(retry.task, first.task);

    fs.writeFileSync(path.join(taskRoot(root), 'active', '.short-ids.json'), '{"version":1,"ids":{}}\n');
    const recovered = createLocalTask(candidate, options);
    assert.equal(recovered.status, 'no-op');
    assert.deepEqual(recovered.task, first.task);

    assert.throws(
      () => createLocalTask({ ...candidate, title: 'Changed title' }, options),
      /TASK_CREATE_IDEMPOTENCY_CONFLICT/
    );
  } finally {
    cleanupFixture(root);
  }
});

test('local task creation keeps constraint and candidate qualification tables separate', () => {
  const root = fixture();
  try {
    const result = createLocalTask(qualificationCandidate, {
      repoRoot: root,
      now: () => new Date(2026, 7, 13, 1, 2, 3),
      agentInfraVersion: 'v0.9.5'
    });
    const content = fs.readFileSync(path.join(taskRoot(root), 'active', result.task.id, 'task.md'), 'utf8');
    const parsed = parseTaskQualification(content);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.qualification.present, true);
    assert.deepEqual(parsed.qualification.constraints.map((row) => [row.constraintId, row.statement]), [
      ['C-1', 'Keep lifecycle routing deterministic.']
    ]);
    assert.deepEqual(parsed.qualification.candidates.map((row) => [row.candidateId, row.statement]), [
      ['A', 'Use the canonical task renderer.'],
      ['B', 'Add a second qualification writer.']
    ]);
  } finally {
    cleanupFixture(root);
  }
});

test('local task creation supports 50 qualification candidates with unique parser-safe ids', () => {
  const root = fixture();
  const wideCandidate: TaskCreateCandidateV1 = {
    ...qualificationCandidate,
    taskInput: {
      ...qualificationCandidate.taskInput,
      alternatives: Array.from({ length: 50 }, (_, index) => `Candidate alternative ${index + 1}`)
    }
  };
  try {
    const result = createLocalTask(wideCandidate, { repoRoot: root, agentInfraVersion: 'v0.9.5' });
    const content = fs.readFileSync(path.join(taskRoot(root), 'active', result.task.id, 'task.md'), 'utf8');
    const parsed = parseTaskQualification(content);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const ids = parsed.qualification.candidates.map((row) => row.candidateId);
    assert.equal(ids.length, 50);
    assert.equal(ids[0], 'A');
    assert.equal(ids[25], 'Z');
    assert.equal(ids[26], 'AA');
    assert.equal(ids[49], 'AX');
    assert.equal(new Set(ids).size, 50);
  } finally {
    cleanupFixture(root);
  }
});

test('local task creation rejects an invalid qualification template before publishing state', () => {
  const root = fixture();
  try {
    const templatePath = path.join(root, '.agents', 'templates', 'task.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(templatePath, template.replace(
      '| candidate_id | statement | status | constraint_ids | impact | evidence |',
      '| candidate_id | statement | status | constraint_ids | impact |'
    ));
    assert.throws(
      () => createLocalTask(qualificationCandidate, { repoRoot: root, agentInfraVersion: 'v0.9.5' }),
      /TASK_CREATE_QUALIFICATION_INVALID/
    );
    assert.deepEqual(fs.readdirSync(path.join(taskRoot(root), 'active')), []);
    assert.equal(fs.existsSync(path.join(taskRoot(root), 'active', '.short-ids.json')), false);
  } finally {
    cleanupFixture(root);
  }
});

test('service-captured host qualification failure remains an accepted terminal result', async () => {
  const root = fixture();
  try {
    const templatePath = path.join(root, '.agents', 'templates', 'task.md');
    const template = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(templatePath, template.replace(
      '| candidate_id | statement | status | constraint_ids | impact | evidence |',
      '| candidate_id | statement | status | constraint_ids | impact |'
    ));
    const domainResult = await createTask(qualificationCandidate, {
      repoRoot: root,
      agentInfraVersion: 'v0.9.5'
    });
    assert.equal(domainResult.status, 'failed');
    assert.equal(domainResult.error?.code, 'TASK_CREATE_QUALIFICATION_INVALID');
    const projected = projectTaskCreateResult(domainResult, {
      requestId: '0123456789abcdef0123456789abcdef',
      accepted: true,
      recovery: 'none'
    });
    assert.deepEqual(projected.control, {
      requestId: '0123456789abcdef0123456789abcdef',
      accepted: true,
      recovery: 'none'
    });
    assert.deepEqual(fs.readdirSync(path.join(taskRoot(root), 'active')), []);
  } finally {
    cleanupFixture(root);
  }
});

test('local task creation safely restores missing runtime workspace directories', () => {
  const root = fixture();
  try {
    fs.rmSync(taskRoot(root), { recursive: true });
    const result = createLocalTask(candidate, {
      repoRoot: root,
      now: () => new Date(2026, 7, 13, 1, 2, 3),
      agentInfraVersion: 'v0.9.5'
    });
    assert.equal(result.status, 'applied');
    assert.equal(fs.existsSync(path.join(taskRoot(root), 'active', result.task.id, 'task.md')), true);
  } finally {
    cleanupFixture(root);
  }
});

test('local task creation rejects a symbolic-link workspace without writing outside the repository', onPlatforms('linux', 'darwin'), () => {
  const { root, outside } = workspaceSymlinkFixture();
  try {
    fs.rmSync(taskRoot(root), { recursive: true });
    fs.symlinkSync(outside, taskRoot(root));
    assert.throws(() => createLocalTask(candidate, { repoRoot: root }), /TASK_CREATE_WORKSPACE_INVALID/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    cleanupFixture(root);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('local task creation uses the OS home and rejects a linked managed root when HOME is unset', onPlatforms('linux', 'darwin'), (t) => {
  const home = createTempDir('agent-infra-task-create-home-');
  const { root, outside } = workspaceSymlinkFixture(home);
  const previousHome = process.env.HOME;
  delete process.env.HOME;
  t.mock.method(os, 'homedir', () => home);
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    cleanupFixture(root);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  fs.rmSync(path.join(home, '.agent-infra'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(home, '.agent-infra'));
  assert.throws(() => createLocalTask(candidate, { repoRoot: root }), /TASK_CREATE_WORKSPACE_INVALID/);
  assert.deepEqual(fs.readdirSync(outside), []);
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
    cleanupFixture(root);
  }
});

test('local task creation recovers matching summaries in every lifecycle state', () => {
  const states = ['active', 'blocked', 'completed', 'archive'] as const;
  for (const state of states) {
    const root = fixture();
    try {
      const options = { repoRoot: root, now: () => new Date(2026, 7, 13, 1, 2, 3), agentInfraVersion: 'v0.9.5' };
      const created = createLocalTask(candidate, options);
      const source = path.join(taskRoot(root), 'active', created.task.id);
      let destination: string;
      if (state === 'archive') {
        destination = path.join(taskRoot(root), 'archive', '2026', '09', '27', created.task.id, 'local');
      } else {
        destination = path.join(taskRoot(root), state, created.task.id);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (state !== 'active') {
        mutateShortIdRegistry(root, created.task.id, 'release');
        fs.renameSync(source, destination);
      }

      const registryPath = path.join(taskRoot(root), 'active', '.short-ids.json');
      const registryBeforeReplay = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

      const replay = createLocalTask(candidate, options);
      assert.equal(replay.status, 'no-op');
      assert.equal(replay.task.id, created.task.id);
      assert.equal(replay.task.state, state);
      assert.equal(replay.task.shortId, state === 'active' ? created.task.shortId : null);
      assert.throws(
        () => createLocalTask({ ...candidate, title: `Conflict in ${state}` }, options),
        /TASK_CREATE_IDEMPOTENCY_CONFLICT/
      );
      if (state !== 'active') {
        assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')), registryBeforeReplay);
      }
    } finally {
      cleanupFixture(root);
    }
  }
});

test('platform failure preserves the local task and records a warning intent', async () => {
  const root = fixture();
  let warningTask: string | null = null;
  try {
    const result = await createTask(candidate, {
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
    assert.equal(fs.existsSync(path.join(taskRoot(root), 'active', result.task.id!, 'task.md')), true);
  } finally {
    cleanupFixture(root);
  }
});

test('non-active idempotent task-create replay returns its state without platform work', async () => {
  const root = fixture();
  try {
    const created = createLocalTask(candidate, { repoRoot: root, agentInfraVersion: 'v0.9.5' });
    const taskDir = path.join(taskRoot(root), 'active', created.task.id);
    const completedDir = path.join(taskRoot(root), 'completed', created.task.id);
    fs.mkdirSync(path.dirname(completedDir), { recursive: true });
    mutateShortIdRegistry(root, created.task.id, 'release');
    fs.renameSync(taskDir, completedDir);
    let platformCalls = 0;
    const result = await createTask(candidate, {
      repoRoot: root,
      agentInfraVersion: 'v0.9.5',
      dependencies: {
        createIssue: (() => { platformCalls += 1; throw new Error('must not create an Issue'); }) as never
      }
    });
    assert.equal(result.status, 'no-op');
    assert.deepEqual(result.task, { id: created.task.id, shortId: null, state: 'completed' });
    assert.equal(platformCalls, 0);
    assert.deepEqual(parseTaskCreateResult(result), result);
  } finally {
    cleanupFixture(root);
  }
});

test('task-create result projection preserves control recovery evidence without changing the domain result', async () => {
  const root = fixture();
  try {
    const domainResult = await createTask(candidate, {
      repoRoot: root,
      agentInfraVersion: 'v0.9.5'
    });
    const projected = projectTaskCreateResult(domainResult, {
      requestId: '0123456789abcdef0123456789abcdef',
      accepted: true,
      recovery: 'none'
    });

    assert.deepEqual(projected.task, domainResult.task);
    assert.deepEqual(projected.control, {
      requestId: '0123456789abcdef0123456789abcdef',
      accepted: true,
      recovery: 'none'
    });
    assert.deepEqual(parseTaskCreateResult(projected), projected);
  } finally {
    cleanupFixture(root);
  }
});

test('task-create output-unavailable fallback is a failed result with inspectable recovery evidence', () => {
  const result = taskCreateOutputUnavailableResult('fedcba9876543210fedcba9876543210');
  assert.equal(result.status, 'failed');
  assert.equal(result.changed, false);
  assert.deepEqual(result.task, { id: null, shortId: null, state: null });
  assert.equal(result.issue, null);
  assert.deepEqual(result.control, {
    requestId: 'fedcba9876543210fedcba9876543210',
    accepted: true,
    recovery: 'inspect-domain-state'
  });
  assert.equal(result.error?.code, 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE');
  assert.equal(result.error?.retryable, false);
  assert.equal(taskCreateExitCode(result), 1);
  assert.deepEqual(parseTaskCreateResult(result), result);
});
