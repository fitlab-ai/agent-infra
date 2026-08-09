import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyLedgerIntent } from '../../../lib/task/ledger-intents.ts';

const METADATA = { timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' };

function fixture(rows: string[] = []) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-intents-'));
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(repoRoot, '.agents', 'workspace', 'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nupdated_at: 2026-01-01 00:00:00+00:00\nagent_infra_version: old\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n${rows.join('\n')}\n\n## Implementation Inputs\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n`);
  return { repoRoot, taskId, taskMd: path.join(taskDir, 'task.md') };
}

test('finding upsert allocates per-stage ids and replays as no-op', () => {
  const f = fixture();
  try {
    const request = {
      kind: 'finding-upsert' as const, taskRef: f.taskId, stage: 'analysis' as const,
      reviewArtifact: 'review-analysis.md', ordinal: 1, severity: 'major' as const,
      evidence: 'review-analysis.md#AN-1'
    };
    const applied = applyLedgerIntent(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.entityId, 'AN-1');
    const repeated = applyLedgerIntent(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(repeated.status, 'no-op');
    assert.equal((fs.readFileSync(f.taskMd, 'utf8').match(/\| AN-1 \|/g) ?? []).length, 1);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('finding natural identity rejects conflicting retries and allocates ordered ordinals', () => {
  const f = fixture();
  try {
    const options = { repoRoot: f.repoRoot, metadataProvider: () => METADATA };
    const first = { kind: 'finding-upsert' as const, taskRef: f.taskId, stage: 'code' as const, reviewArtifact: 'review-code.md', ordinal: 1, severity: 'major' as const, evidence: 'review-code.md#finding-1' };
    assert.equal(applyLedgerIntent(first, options).entityId, 'CD-1');
    const conflict = applyLedgerIntent({ ...first, evidence: 'review-code.md#changed' }, options);
    assert.equal(conflict.error?.code, 'LEDGER_IDENTITY_CONFLICT');
    const second = applyLedgerIntent({ ...first, ordinal: 2, severity: 'minor', evidence: 'review-code.md#finding-2' }, options);
    assert.equal(second.entityId, 'CD-2');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('finding upsert derives the ledger round from the canonical review artifact', () => {
  const f = fixture();
  try {
    const result = applyLedgerIntent({
      kind: 'finding-upsert', taskRef: f.taskId, stage: 'plan', reviewArtifact: 'review-plan-r3.md',
      ordinal: 1, severity: 'blocker', evidence: 'review-plan-r3.md#PL-new'
    }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(result.after?.round, '3');
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), /\| PL-1 \| plan \| 3 \| blocker \| open \|/);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('finding response and review enforce the handshake matrix and round', () => {
  const f = fixture(['| PL-1 | plan | 1 | major | open | review-plan.md#PL-1 |']);
  try {
    const responded = applyLedgerIntent({
      kind: 'finding-respond', taskRef: f.taskId, id: 'PL-1', round: 2,
      status: 'adjusted', evidence: 'plan-r2.md:80'
    }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(responded.status, 'applied');
    const reviewed = applyLedgerIntent({
      kind: 'finding-review', taskRef: f.taskId, id: 'PL-1',
      status: 'confirmed', evidence: 'review-plan-r2.md#PL-1'
    }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(reviewed.status, 'applied');
    const invalid = applyLedgerIntent({
      kind: 'finding-review', taskRef: f.taskId, id: 'PL-1',
      status: 'open', evidence: 'review-plan-r3.md#PL-1'
    }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(invalid.status, 'failed');
    assert.equal(invalid.error?.code, 'LEDGER_TRANSITION_INVALID');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('finding review closes open minor findings in the same round for every stage', () => {
  for (const [id, stage, reviewArtifact] of [
    ['AN-1', 'analysis', 'review-analysis.md'],
    ['PL-1', 'plan', 'review-plan.md'],
    ['CD-1', 'code', 'review-code.md']
  ] as const) {
    const evidence = `${reviewArtifact}#${id}-fixed`;
    const f = fixture([`| ${id} | ${stage} | 1 | minor | open | ${reviewArtifact}#${id} |`]);
    try {
      const request = {
        kind: 'finding-review' as const, taskRef: f.taskId, id,
        status: 'closed' as const, evidence
      };
      const result = applyLedgerIntent(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
      assert.equal(result.status, 'applied', id);
      assert.equal(result.after?.status, 'closed');
      assert.equal(result.after?.round, '1');
      assert.equal(result.after?.evidence, evidence);
      const repeated = applyLedgerIntent(request, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
      assert.equal(repeated.status, 'no-op');
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
  }
});

test('finding review rejects same-round close for non-minor open findings', () => {
  for (const severity of ['blocker', 'major'] as const) {
    const f = fixture([`| CD-1 | code | 1 | ${severity} | open | review-code.md#CD-1 |`]);
    try {
      const before = fs.readFileSync(f.taskMd);
      const result = applyLedgerIntent({
        kind: 'finding-review', taskRef: f.taskId, id: 'CD-1',
        status: 'closed', evidence: `review-code.md#CD-1-${severity}-fixed`
      }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'LEDGER_TRANSITION_INVALID');
      assert.deepEqual(fs.readFileSync(f.taskMd), before);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
  }
});

test('finding review accepts every legal disposition and rejects every other disposition', () => {
  const matrix = {
    accepted: ['closed', 'open', 'needs-human-decision'],
    adjusted: ['confirmed', 'open', 'needs-human-decision'],
    refuted: ['confirmed', 'open', 'needs-human-decision'],
    'cannot-judge': ['open', 'needs-human-decision']
  } as const;
  const dispositions = ['confirmed', 'closed', 'open', 'needs-human-decision'] as const;
  for (const [response, allowed] of Object.entries(matrix)) {
    for (const disposition of dispositions) {
      const f = fixture([`| AN-1 | analysis | 2 | major | ${response} | analysis-r2.md#AN-1 |`]);
      try {
        const before = fs.readFileSync(f.taskMd);
        const result = applyLedgerIntent({
          kind: 'finding-review', taskRef: f.taskId, id: 'AN-1', status: disposition,
          evidence: `review-analysis-r2.md#AN-1-${disposition}`
        }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
        assert.equal(result.status, allowed.includes(disposition as never) ? 'applied' : 'failed', `${response} -> ${disposition}`);
        if (!allowed.includes(disposition as never)) assert.deepEqual(fs.readFileSync(f.taskMd), before);
      } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
    }
  }
});

test('finding responses cover all executor states and reopening stops at the round limit', () => {
  for (const [index, status] of (['accepted', 'adjusted', 'refuted', 'cannot-judge'] as const).entries()) {
    const f = fixture([`| CD-1 | code | 1 | major | open | review-code.md#CD-1 |`]);
    try {
      const result = applyLedgerIntent({
        kind: 'finding-respond', taskRef: f.taskId, id: 'CD-1', round: 2, status,
        evidence: `code-r2.md#CD-1-${index + 1}`
      }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
      assert.equal(result.status, 'applied');
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
  }
  const limited = fixture(['| PL-1 | plan | 3 | major | adjusted | plan-r3.md#PL-1 |']);
  try {
    const before = fs.readFileSync(limited.taskMd);
    const result = applyLedgerIntent({
      kind: 'finding-review', taskRef: limited.taskId, id: 'PL-1', status: 'open',
      evidence: 'review-plan-r3.md#PL-1'
    }, { repoRoot: limited.repoRoot, metadataProvider: () => METADATA });
    assert.equal(result.error?.code, 'LEDGER_TRANSITION_INVALID');
    assert.deepEqual(fs.readFileSync(limited.taskMd), before);
  } finally { fs.rmSync(limited.repoRoot, { recursive: true, force: true }); }
});

test('decision ids are global and decision upsert is dry-run safe', () => {
  const f = fixture([
    '| HD-2 | analysis | - | decision | human-decided | task.md#HDR-1 |',
    '| CD-7 | code | 1 | minor | closed | review-code.md#CD-7 |'
  ]);
  try {
    const inspected = applyLedgerIntent({ kind: 'decision-next-id', taskRef: f.taskId }, { repoRoot: f.repoRoot });
    assert.equal(inspected.entityId, 'HD-3');
    const before = fs.readFileSync(f.taskMd);
    const planned = applyLedgerIntent({
      kind: 'decision-upsert', taskRef: f.taskId, id: 'HD-3', stage: 'code', artifact: 'code.md', needsImplementation: true, dryRun: true
    }, { repoRoot: f.repoRoot, metadataProvider: () => METADATA });
    assert.equal(planned.status, 'planned');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('code escalation atomically declares implementation intent and replays without a new id', () => {
  const f = fixture(['| CD-1 | code | 2 | major | adjusted | code-r2.md#CD-1 |']);
  try {
    const options = { repoRoot: f.repoRoot, metadataProvider: () => METADATA };
    const request = {
      kind: 'finding-review' as const, taskRef: f.taskId, id: 'CD-1',
      status: 'needs-human-decision' as const, evidence: 'review-code-r2.md#CD-1', needsImplementation: false
    };
    assert.equal(applyLedgerIntent(request, options).status, 'applied');
    assert.equal(applyLedgerIntent(request, options).status, 'no-op');
    const content = fs.readFileSync(f.taskMd, 'utf8');
    assert.equal((content.match(/\| II-1 \|/g) ?? []).length, 1);
    assert.match(content, /\| II-1 \| CD-1 \| review-code-r2\.md#CD-1 \| code \| false \|\s*\| declared \|/);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('implementation intent is required only for code escalation', () => {
  const code = fixture(['| CD-1 | code | 2 | major | adjusted | code-r2.md#CD-1 |']);
  try {
    const before = fs.readFileSync(code.taskMd);
    const result = applyLedgerIntent({
      kind: 'finding-review', taskRef: code.taskId, id: 'CD-1',
      status: 'needs-human-decision', evidence: 'review-code-r2.md#CD-1'
    }, { repoRoot: code.repoRoot, metadataProvider: () => METADATA });
    assert.equal(result.status, 'failed');
    assert.deepEqual(fs.readFileSync(code.taskMd), before);
  } finally { fs.rmSync(code.repoRoot, { recursive: true, force: true }); }

  const plan = fixture();
  try {
    const result = applyLedgerIntent({
      kind: 'decision-upsert', taskRef: plan.taskId, id: 'HD-1', stage: 'plan', artifact: 'plan.md', needsImplementation: true
    }, { repoRoot: plan.repoRoot, metadataProvider: () => METADATA });
    assert.equal(result.status, 'failed');
  } finally { fs.rmSync(plan.repoRoot, { recursive: true, force: true }); }
});

test('ledger intents translate shared table parser failures into ledger domain errors', () => {
  const duplicate = fixture([
    '| CD-1 | code | 1 | minor | open | review-code.md#minor-1 |',
    '| CD-1 | code | 1 | minor | open | review-code.md#minor-1 |'
  ]);
  try {
    const result = applyLedgerIntent({ kind: 'decision-next-id', taskRef: duplicate.taskId }, { repoRoot: duplicate.repoRoot });
    assert.equal(result.error?.code, 'LEDGER_DUPLICATE_ID');
  } finally { fs.rmSync(duplicate.repoRoot, { recursive: true, force: true }); }

  const malformed = fixture();
  try {
    const content = fs.readFileSync(malformed.taskMd, 'utf8').replace('| id | stage | round | severity | status | evidence |', '| wrong | schema |');
    fs.writeFileSync(malformed.taskMd, content);
    const result = applyLedgerIntent({ kind: 'decision-next-id', taskRef: malformed.taskId }, { repoRoot: malformed.repoRoot });
    assert.equal(result.error?.code, 'LEDGER_DOCUMENT_INVALID');
  } finally { fs.rmSync(malformed.repoRoot, { recursive: true, force: true }); }
});
