import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyQualificationProposal } from '../../../lib/task/qualification-intents.ts';
import { applyQualificationConfirmation } from '../../../lib/qualify.ts';
import { parseQualificationConfirmations, parseTaskQualification } from '../../../lib/task/qualification-audit.ts';

const TASK_ID = 'TASK-20260101-000001';
const VERSION = 'v0.9.13-alpha.0';

function taskContent(): string {
  return `---
id: ${TASK_ID}
branch: agent-infra-feature-qualification
status: active
updated_at: 2026-01-01 00:00:00+00:00
agent_infra_version: ${VERSION}
---

# 任务：资格审计

## 任务输入

### 约束

| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Keep the public writer | derived | plan | plan.md | plan.md#scope |  |  |

### 候选与否决方案

| candidate_id | statement | status | constraint_ids | impact | evidence |
| --- | --- | --- | --- | --- | --- |
| A | Use the existing writer | pending | C-1 | Small | task.md#input |

## 审查分歧账本

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 人工裁决

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|

## 活动日志

- 2026-01-01 00:00:00+00:00 — **Create Task** by codex — created
`;
}

function fixture(): { repoRoot: string; taskMd: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-intents-'));
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), taskContent());
  return { repoRoot, taskMd: path.join(taskDir, 'task.md') };
}

function metadata() {
  return { timestamp: '2026-01-01 01:00:00+00:00', agentInfraVersion: VERSION };
}

test('proposal writes only pending qualification data and is idempotent', () => {
  const { repoRoot, taskMd } = fixture();
  try {
    const before = fs.readFileSync(taskMd, 'utf8');
    const parsed = parseTaskQualification(before);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const request = {
      taskRef: TASK_ID,
      expectedTaskInputDigest: parsed.qualification.taskInputDigest,
      constraints: [{
        constraintId: 'C-2', statement: 'Use atomic writes', status: 'assumption' as const,
        authority: 'model', source: 'analysis.md', evidence: 'analysis.md#risk', derivedFrom: [], approvalEvidence: ''
      }],
      candidates: [{
        candidateId: 'B', statement: 'Add a second writer', status: 'pending' as const,
        constraintIds: ['C-1'], impact: 'Larger change', evidence: 'analysis.md#options'
      }]
    };
    const applied = applyQualificationProposal(request, { repoRoot, metadataProvider: metadata });
    assert.equal(applied.status, 'applied');
    const after = fs.readFileSync(taskMd, 'utf8');
    const updated = parseTaskQualification(after);
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.qualification.constraints.some((row) => row.constraintId === 'C-2'), true);
    assert.equal(updated.qualification.candidates.some((row) => row.candidateId === 'B'), true);

    const repeated = applyQualificationProposal(request, { repoRoot, metadataProvider: metadata });
    assert.equal(repeated.status, 'no-op');
    assert.equal(repeated.changed, false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('proposal rejects confirmation authority and stale digest without changing task.md', () => {
  const { repoRoot, taskMd } = fixture();
  try {
    const before = fs.readFileSync(taskMd, 'utf8');
    const rejected = applyQualificationProposal({
      taskRef: TASK_ID,
      expectedTaskInputDigest: 'a'.repeat(64),
      constraints: [{
        constraintId: 'C-2', statement: 'No', status: 'confirmed' as never,
        authority: 'human-declared', source: 'user', evidence: 'user', derivedFrom: [], approvalEvidence: 'QCR-1'
      }]
    }, { repoRoot, metadataProvider: metadata });
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error?.code, 'QUALIFICATION_PROPOSAL_INVALID');

    const stale = applyQualificationProposal({
      taskRef: TASK_ID,
      expectedTaskInputDigest: 'b'.repeat(64),
      constraints: [{
        constraintId: 'C-2', statement: 'No', status: 'assumption' as const,
        authority: 'model', source: 'user', evidence: 'user', derivedFrom: [], approvalEvidence: ''
      }]
    }, { repoRoot, metadataProvider: metadata });
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error?.code, 'QUALIFICATION_DIGEST_CONFLICT');
    assert.equal(fs.readFileSync(taskMd, 'utf8'), before);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('top-level qualification confirms the current digest and creates a core-owned QCR', () => {
  const { repoRoot, taskMd } = fixture();
  try {
    const initial = parseTaskQualification(fs.readFileSync(taskMd, 'utf8'));
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    const result = applyQualificationConfirmation({
      taskRef: TASK_ID, constraintId: 'C-1', expectedDigest: initial.qualification.constraintDigest,
      rationale: '人工确认该约束来源和语义。'
    }, { repoRoot, metadataProvider: metadata });
    assert.equal(result.status, 'applied');
    assert.equal(result.qcrId, 'QCR-1');
    const content = fs.readFileSync(taskMd, 'utf8');
    assert.match(content, /\| C-1 \| Keep the public writer \| confirmed \| human-declared \| plan\.md \| plan\.md#scope \|  \| QCR-1 \|/);
    const confirmations = parseQualificationConfirmations(content);
    assert.equal(confirmations.ok, true);
    if (confirmations.ok) {
      assert.equal(confirmations.confirmations[0]?.actor, 'human-declared');
      assert.equal(confirmations.confirmations[0]?.entrypoint, 'ai qualify');
      assert.equal(confirmations.confirmations[0]?.approvedDigest, initial.qualification.constraintDigest);
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
