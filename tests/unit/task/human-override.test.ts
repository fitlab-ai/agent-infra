import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  consumeHumanOverride,
  diagnoseHumanOverrideForTask,
  failureId,
  HUMAN_OVERRIDE_COLUMNS,
  issueHumanOverride,
  renderHumanOverrideAudit,
  resolveOutcome,
  type HumanOverrideOptions
} from '../../../lib/task/human-override.ts';
import { applyTaskLifecycle } from '../../../lib/task/lifecycle.ts';

const TASK_ID = 'TASK-20260101-000001';
const METADATA = { timestamp: '2026-08-22 14:00:00+00:00', agentInfraVersion: 'v0.9.8-alpha.0' };
const SHORT_ID_FAILURE = failureId('lifecycle.apply', 'SHORT_ID_CAPACITY_EXCEEDED');

function fixture(state: 'active' | 'blocked' = 'blocked') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'human-override-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', state, TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  const ids = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [String(index + 1).padStart(2, '0'), `TASK-20260101-${String(index + 2).padStart(6, '0')}`]));
  fs.mkdirSync(path.join(repoRoot, '.agents', 'workspace', 'active'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids })}\n`);
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: ${state}\nupdated_at: old\nagent_infra_version: old\n---\n\n# Task\n\n## Activity Log\n\n`);
  return { repoRoot, taskMd: path.join(taskDir, 'task.md') };
}

function options(repoRoot: string): HumanOverrideOptions {
  return {
    repoRoot,
    now: () => '2026-08-22 14:00:00+00:00',
    metadataProvider: () => METADATA,
    randomSuffix: () => 'test'
  };
}

function removePullRequestColumn(content: string): string {
  const lines = content.split('\n');
  const headerIndex = lines.findIndex((line) => line.includes('| pull_request_number |'));
  assert.notEqual(headerIndex, -1);
  const cellIndex = HUMAN_OVERRIDE_COLUMNS.indexOf('pull_request_number') + 1;
  for (let index = headerIndex; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith('|') || !lines[index]!.endsWith('|')) break;
    const cells = lines[index]!.split('|');
    cells.splice(cellIndex, 1);
    lines[index] = cells.join('|');
  }
  return lines.join('\n');
}

test('outcome resolver returns the registered result for each context and fail-closes unknown facts', () => {
  const safe = resolveOutcome(SHORT_ID_FAILURE, 'safe-close', ['identity-confirmed-and-safe-close-proven']);
  assert.deepEqual(safe, {
    effect: 'apply-target',
    result: 'safe-closed',
    residual: 'task was atomically safe-closed without entering active or expanding short-id capacity',
    policyId: SHORT_ID_FAILURE,
    target: 'safe-close',
    contextId: 'identity-confirmed-and-safe-close-proven'
  });

  const uncertain = resolveOutcome(SHORT_ID_FAILURE, 'safe-close', ['identity-unconfirmed']);
  assert.equal(uncertain.result, 'recovery-required');
  assert.equal(uncertain.effect, 'no-write');
  assert.equal(uncertain.contextId, 'identity-unconfirmed');

  const unknown = resolveOutcome(SHORT_ID_FAILURE, 'safe-close', ['untrusted-fact']);
  assert.equal(unknown.result, 'recovery-required');
  assert.equal(unknown.effect, 'no-write');
  assert.equal(unknown.contextId, 'context-unmatched');
});

test('blocked task can issue and consume a local-declared override through task.md only', () => {
  const f = fixture();
  try {
    const issue = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'activate',
      operator: 'alice',
      reason: 'The task identity was verified from the blocked workspace.',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.equal(issue.status, 'applied');
    assert.ok(issue.ticketId);
    assert.equal(issue.identity.source, 'local-declared');
    assert.equal(issue.identity.verified, false);

    const consumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: issue.ticketId,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'activate',
      scope: 'task-lifecycle',
    }, options(f.repoRoot));
    assert.equal(consumed.status, 'applied', JSON.stringify(consumed));
    assert.equal(consumed.outcome.result, 'safe-closed');
    assert.equal(consumed.outcome.effect, 'apply-target');
    const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
    assert.match(content, /## Human Override Ledger/);
    assert.match(content, /local-declared/);
    assert.match(content, /safe-closed/);
    assert.match(content, /consumed/);
    assert.match(renderHumanOverrideAudit(content), /## Human Override Audit/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('override tickets are one-time and expired tickets do not mutate the ledger', () => {
  const f = fixture('blocked');
  try {
    const issue = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'activate',
      operator: 'alice',
      reason: 'bounded recovery',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.ok(issue.ticketId);
    const request = {
      taskRef: TASK_ID,
      ticketId: issue.ticketId,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close' as const,
      intent: 'activate' as const,
      scope: 'task-lifecycle',
    };
    assert.equal(consumeHumanOverride(request, options(f.repoRoot)).status, 'applied');
    const completedTaskMd = path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md');
    const beforeReplay = fs.readFileSync(completedTaskMd);
    const replay = consumeHumanOverride(request, options(f.repoRoot));
    assert.equal(replay.status, 'failed');
    assert.equal(replay.error.code, 'OVERRIDE_REPLAY');
    assert.deepEqual(fs.readFileSync(completedTaskMd), beforeReplay);

    const expiredFixture = fixture('blocked');
    const expired = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'activate',
      operator: 'bob',
      reason: 'expired test',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 14:00:01+00:00'
    }, { ...options(expiredFixture.repoRoot), now: () => '2026-08-22 14:00:00+00:00' });
    assert.ok(expired.ticketId);
    const expiredResult = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: expired.ticketId,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'activate',
      scope: 'task-lifecycle',
    }, { ...options(expiredFixture.repoRoot), now: () => '2026-08-22 14:00:02+00:00' });
    assert.equal(expiredResult.status, 'failed');
    assert.equal(expiredResult.error.code, 'OVERRIDE_EXPIRED');
    fs.rmSync(expiredFixture.repoRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('consuming state recovers when the effect commits before the final ledger write', () => {
  const f = fixture();
  try {
    const issue = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'activate',
      operator: 'alice',
      reason: 'recover an exhausted short-id registry',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.ok(issue.ticketId);
    let renames = 0;
    const failingWrite = {
      renameSync(from: string, to: string) {
        renames += 1;
        if (renames === 2) throw new Error('injected final ledger write failure');
        fs.renameSync(from, to);
      }
    };
    const request = {
      taskRef: TASK_ID,
      ticketId: issue.ticketId,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close' as const,
      scope: 'task-lifecycle',
    };
    const failed = consumeHumanOverride(request, { ...options(f.repoRoot), taskFileSystem: failingWrite });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.code, /RENAME_FAILED|TEMP_WRITE_FAILED/);
    const recovered = consumeHumanOverride(request, options(f.repoRoot));
    assert.equal(recovered.status, 'applied');
    assert.equal(recovered.outcome.result, 'safe-closed');
    const content = fs.readFileSync(path.join(f.repoRoot, '.agents', 'workspace', 'completed', TASK_ID, 'task.md'), 'utf8');
    assert.match(content, /\| .* \| consumed \|/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('caller cannot select a platform-verified identity through the core issue API', () => {
  const f = fixture();
  try {
    const result = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      operator: 'alice',
      reason: 'identity source is derived by the local entrypoint',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00',
      identitySource: 'platform-verified'
    }, options(f.repoRoot));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'OVERRIDE_IDENTITY_SOURCE_INVALID');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('issue refuses a ticket when the requested failure is not produced by the original intent', () => {
  const f = fixture();
  try {
    const result = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: SHORT_ID_FAILURE,
      target: 'safe-close',
      intent: 'cancel',
      operator: 'alice',
      reason: 'the intent does not hit the capacity producer',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'OVERRIDE_FAILURE_NOT_PRESENT');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('task-event state guard is a real producer failure for a blocked task', () => {
  const f = fixture('blocked');
  try {
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failureId('task-event', 'TASK_STATE_MISMATCH'),
      target: 'continue-local',
      operator: 'alice',
      reason: 'the blocked task was reviewed by an operator',
      scope: 'task-event',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('invalid orchestration state can be recorded without producing a manual capability', () => {
  const f = fixture('active');
  const orchestrationPath = path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID, 'orchestration.json');
  fs.writeFileSync(orchestrationPath, `${JSON.stringify({
    schemaVersion: 3,
    status: 'running',
    pendingDelegation: { status: 'prepared' }
  }, null, 2)}\n`);
  const failure = failureId('lifecycle-execution', 'ORCHESTRATION_STATE_INVALID');
  try {
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'external-contributor',
      reason: 'record the orchestration guard observed by the lifecycle producer',
      scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
    const consumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: issued.ticketId,
      failureId: failure,
      target: 'continue-local',
      scope: 'task-lifecycle'
    }, options(f.repoRoot));
    assert.equal(consumed.status, 'applied', JSON.stringify(consumed));
    assert.equal(consumed.outcome.effect, 'record-only');
    assert.equal(consumed.outcome.result, 'preserve-failure');
    assert.equal('manualOverride' in consumed, false);
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), new RegExp(`\\| ${issued.ticketId} \\|.*\\| consumed \\|`));
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), /ORCHESTRATION_STATE_INVALID/);
    assert.ok(fs.existsSync(path.join(f.repoRoot, '.agents', 'workspace', 'active', TASK_ID)));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('platform bind guard records real adapter failure evidence without producing a capability', () => {
  const f = fixture('active');
  fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
    task: { shortIdLength: 2 }, platform: { type: 'github' }
  }));
  const platformClient = {
    version: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    json: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    text: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } })
  } as NonNullable<HumanOverrideOptions['platformClient']>;
  const failure = failureId('platform.issue', 'PLATFORM_BIND_FAILED');
  const platformOptions = { ...options(f.repoRoot), platformClient };
  try {
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'external-contributor',
      reason: 'record the platform adapter failure without claiming the Issue passed',
      scope: 'platform.issue',
      issueNumber: 42,
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, platformOptions);
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
    const consumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: issued.ticketId,
      failureId: failure,
      target: 'continue-local',
      scope: 'platform.issue'
    }, platformOptions);
    assert.equal(consumed.status, 'applied', JSON.stringify(consumed));
    assert.equal(consumed.outcome.effect, 'record-only');
    assert.equal(consumed.outcome.result, 'preserve-failure');
    assert.equal('manualOverride' in consumed, false);
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), /AUTH_REQUIRED/);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('platform pull-request bind guard uses the same record-only path', () => {
  const f = fixture('active');
  fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
    task: { shortIdLength: 2 }, platform: { type: 'github' }
  }));
  const platformClient = {
    version: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    json: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    text: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } })
  } as NonNullable<HumanOverrideOptions['platformClient']>;
  const failure = failureId('platform.pull-request', 'PLATFORM_BIND_FAILED');
  const platformOptions = { ...options(f.repoRoot), platformClient };
  try {
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'external-contributor',
      reason: 'record the PR adapter failure without claiming the PR passed',
      scope: 'platform.pull-request',
      pullRequestNumber: 7,
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, platformOptions);
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
    const consumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: issued.ticketId,
      failureId: failure,
      target: 'continue-local',
      scope: 'platform.pull-request'
    }, platformOptions);
    assert.equal(consumed.status, 'applied', JSON.stringify(consumed));
    assert.equal(consumed.outcome.effect, 'record-only');
    assert.equal('manualOverride' in consumed, false);
    const content = fs.readFileSync(f.taskMd, 'utf8');
    assert.match(content, /pull_request_number/);
    assert.match(content, new RegExp(`\\| ${issued.ticketId} \\|.*\\| 7 \\|`));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('platform resource numbers reject non-safe positive integers before probe or write', () => {
  const cases = [
    { failureId: failureId('platform.issue', 'PLATFORM_BIND_FAILED'), target: 'continue-local', field: 'issueNumber' as const },
    { failureId: failureId('platform.pull-request', 'PLATFORM_BIND_FAILED'), target: 'continue-local', field: 'pullRequestNumber' as const }
  ];
  for (const item of cases) {
    for (const value of [0, -1, Number.NaN]) {
      const f = fixture('active');
      let probeCalls = 0;
      fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
        task: { shortIdLength: 2 }, platform: { type: 'github' }
      }));
      const platformClient = {
        version: () => { probeCalls += 1; return { ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'probe must not run', retryable: false } }; },
        json: () => { probeCalls += 1; return { ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'probe must not run', retryable: false } }; },
        text: () => { probeCalls += 1; return { ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'probe must not run', retryable: false } }; }
      } as NonNullable<HumanOverrideOptions['platformClient']>;
      const request = {
        taskRef: TASK_ID,
        failureId: item.failureId,
        target: item.target,
        operator: 'external-contributor',
        reason: 'reject invalid platform resource before probing',
        scope: item.failureId.split(':')[0]!,
        expiresAt: '2026-08-22 15:00:00+00:00',
        [item.field]: value
      };
      const before = fs.readFileSync(f.taskMd);
      try {
        const issued = issueHumanOverride(request, { ...options(f.repoRoot), platformClient });
        assert.equal(issued.status, 'failed', JSON.stringify(issued));
        assert.equal(issued.error.code, 'OVERRIDE_RESOURCE_INVALID');
        assert.equal(probeCalls, 0);
        assert.deepEqual(fs.readFileSync(f.taskMd), before);
      } finally {
        fs.rmSync(f.repoRoot, { recursive: true, force: true });
      }
    }
  }
});

test('platform pull-request tickets reject a different resource number without mutation', () => {
  const f = fixture('active');
  fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
    task: { shortIdLength: 2 }, platform: { type: 'github' }
  }));
  const platformClient = {
    version: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    json: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    text: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } })
  } as NonNullable<HumanOverrideOptions['platformClient']>;
  const failure = failureId('platform.pull-request', 'PLATFORM_BIND_FAILED');
  const platformOptions = { ...options(f.repoRoot), platformClient };
  try {
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'external-contributor',
      reason: 'bind the ticket to PR 7',
      scope: 'platform.pull-request',
      pullRequestNumber: 7,
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, platformOptions);
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
    const before = fs.readFileSync(f.taskMd);
    const consumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: issued.ticketId,
      failureId: failure,
      target: 'continue-local',
      scope: 'platform.pull-request',
      pullRequestNumber: 8
    }, platformOptions);
    assert.equal(consumed.status, 'failed');
    assert.equal(consumed.error.code, 'OVERRIDE_RESOURCE_MISMATCH');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('legacy pull-request tickets without a durable resource binding fail closed for reissue', () => {
  const f = fixture('active');
  fs.writeFileSync(path.join(f.repoRoot, '.agents', '.airc.json'), JSON.stringify({
    task: { shortIdLength: 2 }, platform: { type: 'github' }
  }));
  const platformClient = {
    version: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    json: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } }),
    text: () => ({ ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'test authentication failure', retryable: false } })
  } as NonNullable<HumanOverrideOptions['platformClient']>;
  const failure = failureId('platform.pull-request', 'PLATFORM_BIND_FAILED');
  const platformOptions = { ...options(f.repoRoot), platformClient };
  try {
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'external-contributor',
      reason: 'create a legacy ticket fixture',
      scope: 'platform.pull-request',
      pullRequestNumber: 7,
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, platformOptions);
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
    fs.writeFileSync(f.taskMd, removePullRequestColumn(fs.readFileSync(f.taskMd, 'utf8')));
    const reissued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'external-contributor',
      reason: 'reissue with a durable PR binding',
      scope: 'platform.pull-request',
      pullRequestNumber: 8,
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, platformOptions);
    assert.equal(reissued.status, 'applied', JSON.stringify(reissued));
    const reconsumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: reissued.ticketId,
      failureId: failure,
      target: 'continue-local',
      scope: 'platform.pull-request'
    }, platformOptions);
    assert.equal(reconsumed.status, 'applied', JSON.stringify(reconsumed));
    const before = fs.readFileSync(f.taskMd);
    const consumed = consumeHumanOverride({
      taskRef: TASK_ID,
      ticketId: issued.ticketId,
      failureId: failure,
      target: 'continue-local',
      scope: 'platform.pull-request'
    }, platformOptions);
    assert.equal(consumed.status, 'failed');
    assert.equal(consumed.error.code, 'OVERRIDE_RESOURCE_BINDING_MISSING');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('diagnosis aggregates independent producer probes from one task snapshot', () => {
  const f = fixture('blocked');
  try {
    const diagnosis = diagnoseHumanOverrideForTask(TASK_ID, undefined, undefined, options(f.repoRoot));
    assert.equal(diagnosis.status, 'ready', JSON.stringify(diagnosis));
    assert.equal(diagnosis.taskId, TASK_ID);
    assert.equal(diagnosis.state, 'blocked');
    assert.ok(diagnosis.blockedBy.some((item) => item.failureId === 'task-event:TASK_STATE_MISMATCH'));
    assert.ok(diagnosis.probes.some((item) => item.failureId === 'task-event:TASK_STATE_MISMATCH' && item.status === 'observed'));
    assert.equal(diagnosis.probes.find((item) => item.failureId === 'task-event:EVENT_TRANSITION_INVALID')?.status, 'not-observed');
    assert.equal(diagnosis.probes.find((item) => item.failureId === 'task-event:EVENT_START_MISSING')?.status, 'not-observed');
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('generic local effects remain consuming until the producer effect commits', () => {
  const f = fixture('blocked');
  try {
    const failure = failureId('activity-intent', 'TASK_STATE_MISMATCH');
    const issued = issueHumanOverride({
      taskRef: TASK_ID,
      failureId: failure,
      target: 'continue-local',
      operator: 'alice',
      reason: 'bounded local recovery',
      scope: 'activity-intent',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(f.repoRoot));
    assert.equal(issued.status, 'applied', JSON.stringify(issued));

    const request = {
      taskRef: TASK_ID,
      ticketId: issued.ticketId,
      failureId: failure,
      target: 'continue-local' as const,
      scope: 'activity-intent'
    };
    const first = consumeHumanOverride(request, {
      ...options(f.repoRoot),
      effectExecutor: () => ({ code: 'EFFECT_FAILED', message: 'injected producer failure' })
    });
    assert.equal(first.status, 'failed');
    assert.equal(first.error.code, 'EFFECT_FAILED');
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), new RegExp(`\\| ${issued.ticketId} \\|.*\\| consuming \\|`));

    const recovered = consumeHumanOverride(request, {
      ...options(f.repoRoot),
      effectExecutor: () => null
    });
    assert.equal(recovered.status, 'applied', JSON.stringify(recovered));
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), new RegExp(`\\| ${issued.ticketId} \\|.*\\| consumed \\|`));
  } finally {
    fs.rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('producer probe reads an existing lifecycle failure journal without resuming it', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'human-override-journal-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.agents', '.airc.json'), JSON.stringify({ task: { shortIdLength: 2 } }));
  fs.writeFileSync(path.join(repoRoot, '.agents', 'workspace', 'active', '.short-ids.json'), `${JSON.stringify({ version: 1, ids: { '01': TASK_ID } })}\n`);
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${TASK_ID}\nstatus: active\nupdated_at: old\nagent_infra_version: old\n---\n\n# Task\n\n## Activity Log\n\n`);
  try {
    const initial = applyTaskLifecycle({ taskRef: TASK_ID, intent: 'complete', agent: 'codex' }, {
      repoRoot,
      directoryRenameSync: () => { throw new Error('injected rename failure'); },
      metadataProvider: () => METADATA
    });
    assert.equal(initial.status, 'failed');
    assert.equal(initial.error?.code, 'LIFECYCLE_DIRECTORY_RENAME_FAILED');
    assert.equal(fs.existsSync(path.join(taskDir, '.task-lifecycle.json')), true);

    const failure = failureId('lifecycle.apply', 'LIFECYCLE_DIRECTORY_RENAME_FAILED');
    const issued = issueHumanOverride({
      taskRef: TASK_ID, failureId: failure, target: 'retry-same-intent', intent: 'complete',
      operator: 'alice', reason: 'retry the recorded directory move', scope: 'task-lifecycle',
      expiresAt: '2026-08-22 15:00:00+00:00'
    }, options(repoRoot));
    assert.equal(issued.status, 'applied', JSON.stringify(issued));
    assert.equal(fs.existsSync(path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID)), true);
    assert.equal(fs.existsSync(path.join(repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), false);

    const consumed = consumeHumanOverride({
      taskRef: TASK_ID, ticketId: issued.ticketId, failureId: failure,
      target: 'retry-same-intent', intent: 'complete', scope: 'task-lifecycle'
    }, options(repoRoot));
    assert.equal(consumed.status, 'applied', JSON.stringify(consumed));
    assert.equal(fs.existsSync(path.join(repoRoot, '.agents', 'workspace', 'completed', TASK_ID)), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
