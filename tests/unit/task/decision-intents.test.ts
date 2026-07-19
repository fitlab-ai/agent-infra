import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyHumanDecision } from '../../../lib/task/decision-intents.ts';

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-intents-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nupdated_at: old\nagent_infra_version: old\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |\n\n## Human Decisions\n\n## Implementation Inputs\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n\n## Activity Log\n\n- 2026-01-01 00:00:00+00:00 — **Create Task** by codex — created\n`);
  return { repoRoot, taskId, taskMd: path.join(taskDir, 'task.md') };
}

test('human decision atomically updates ledger, HDR, activity and implementation input', () => {
  const f = fixture();
  try {
    const options = {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
    };
    const request = {
      taskRef: f.taskId, selector: 'CD-1', decision: 'Use A | keep \\ path.', needsImplementation: true
    };
    const applied = applyHumanDecision(request, options);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.recordId, 'HDR-1');
    assert.equal(applied.implementationInputId, 'II-1');
    const repeated = applyHumanDecision(request, options);
    assert.equal(repeated.status, 'no-op');
    const content = fs.readFileSync(f.taskMd, 'utf8');
    assert.match(content, /\| CD-1 \| code \| 1 \| major \| human-decided \| task\.md#HDR-1 \|/);
    assert.equal((content.match(/^### HDR-1$/gm) ?? []).length, 1);
    assert.equal((content.match(/\| II-1 \|/g) ?? []).length, 1);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('a different ruling for an already decided row fails without writes', () => {
  const f = fixture();
  try {
    const options = {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
    };
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'A', needsImplementation: false }, options).status, 'applied');
    const before = fs.readFileSync(f.taskMd);
    const conflict = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'B', needsImplementation: false }, options);
    assert.equal(conflict.status, 'failed');
    assert.equal(conflict.error?.code, 'DECISION_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('human decision leaves task bytes unchanged when the atomic rename fails', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.taskMd);
    const result = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'A', needsImplementation: true }, {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' }),
      fileSystem: { renameSync: () => { throw new Error('rename denied'); } },
      randomSuffix: () => 'decision-failure'
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'RENAME_FAILED');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
    assert.equal(fs.existsSync(path.join(path.dirname(f.taskMd), `.task.md.${process.pid}.decision-failure.tmp`)), false);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});
