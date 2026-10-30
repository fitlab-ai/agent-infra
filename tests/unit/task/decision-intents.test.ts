import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { applyHumanDecision } from '../../../lib/task/decision-intents.ts';
import { applyLedgerIntent } from '../../../lib/task/ledger-intents.ts';
import { parseReworkIntentDocument } from '../../../lib/task/rework-intent.ts';
import { parseImplementationInputs } from '../../../lib/task/implementation-inputs.ts';
import { parseTypedTaskFrontmatter, updateTaskFrontmatter } from '../../../lib/task/frontmatter.ts';
import { createTempDir } from '../../helpers.ts';

function fixture(declaration = '') {
  const repoRoot = createTempDir('decision-intents-');
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(taskWorkspaceRoot(repoRoot),  'active', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\nupdated_at: old\nstatus: active\nagent_infra_version: v0.8.6-alpha.0\n---\n# Task\n\n## Review Disagreement Ledger\n\n| id | stage | round | severity | status | evidence |\n|----|-------|-------|----------|--------|----------|\n| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |\n\n## Human Decisions\n\n<!-- 使用 ai decide [--task <ref>] <裁决内容> -->\n\n## Implementation Inputs\n\n| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |\n|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|\n${declaration}\n\n## Activity Log\n\n- 2026-01-01 00:00:00+00:00 — **Create Task** by codex — created\n`);
  return { repoRoot, taskId, taskMd: path.join(taskDir, 'task.md') };
}

test('code decision falls back to declared intent and finalizes the same input', () => {
  for (const [needs, status] of [['true', 'pending'], ['false', 'not-required']] as const) {
    const f = fixture(`| II-1 | CD-1 | review-code.md#CD-1 | code | ${needs} | | declared | |`);
    try {
      const options = {
        repoRoot: f.repoRoot,
        metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
      };
      const result = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use A' }, options);
      assert.equal(result.status, 'applied');
      assert.equal(result.implementationInputId, 'II-1');
      assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use A' }, options).status, 'no-op');
      const content = fs.readFileSync(f.taskMd, 'utf8');
      assert.match(content, new RegExp(`\\| II-1 \\| CD-1 \\| task\\.md#HDR-1 \\| code \\| ${needs} \\| 2026-07-19 12:00:00\\+00:00 \\| ${status} \\|`));
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
  }
});

test('code decision rejects an explicit intent that conflicts with its declaration', () => {
  const f = fixture('| II-1 | CD-1 | review-code.md#CD-1 | code | true | | declared | |');
  try {
    const before = fs.readFileSync(f.taskMd);
    const result = applyHumanDecision({
      taskRef: f.taskId, selector: 'CD-1', decision: 'Use A', needsImplementation: false
    }, { repoRoot: f.repoRoot });
    assert.equal(result.error?.code, 'DECISION_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('code decision accepts an explicit intent that matches its declaration', () => {
  const f = fixture('| II-1 | CD-1 | review-code.md#CD-1 | code | true | | declared | |');
  try {
    const result = applyHumanDecision({
      taskRef: f.taskId, selector: 'CD-1', decision: 'Use A', needsImplementation: true
    }, {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.implementationInputId, 'II-1');
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), /\| II-1 \| CD-1 \| task\.md#HDR-1 \| code \| true \| .+ \| pending \|/);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('human decision atomically updates ledger, HDR, activity and implementation input', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.taskMd, fs.readFileSync(f.taskMd, 'utf8').replace('<!-- 使用 ai decide', '<!-- Use ai decide').replace(/\n/g, '\r\n'));
    const options = {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
    };
    const request = {
      taskRef: f.taskId, selector: 'CD-1', decision: 'Use A | keep \\ path.\nKeep the original identity.', needsImplementation: true
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

test('human decision consumes only the matching human-decision pause', () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.taskMd, `\n## Rework Intent\n\n| intent_id | finding_id | source_artifact | source_sha256 | target | classification | evidence_digest | task_fact_digest | status | declared_at | consumed_at |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| RI-1 | CD-1 | review-code.md | ${'a'.repeat(64)} | pause | human-decision | ${'b'.repeat(64)} | ${'c'.repeat(64)} | pending | 2026-01-01T00:00:00.000Z | |\n| RI-2 | CD-2 | review-code.md | ${'d'.repeat(64)} | pause | insufficient-evidence | ${'e'.repeat(64)} | ${'f'.repeat(64)} | pending | 2026-01-01T00:00:00.000Z | |\n`);
    const result = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use A', needsImplementation: false }, {
      repoRoot: f.repoRoot,
      metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' })
    });
    assert.equal(result.status, 'applied');
    const content = fs.readFileSync(f.taskMd, 'utf8');
    assert.match(content, /\| RI-1 \| CD-1 \|[^\n]+\| consumed \|/);
    assert.match(content, /\| RI-2 \| CD-2 \|[^\n]+\| pending \|/);
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
  const declaration = '| II-1 | CD-1 | review-code.md#CD-1 | code | true | | declared | |';
  const f = fixture(declaration);
  try {
    const before = fs.readFileSync(f.taskMd);
    const result = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'A' }, {
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

test('human decision persists and reports a missing activity log', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.taskMd, fs.readFileSync(f.taskMd, 'utf8').replace(/## Activity Log[\s\S]*$/, ''));
    const result = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use A', needsImplementation: true }, { repoRoot: f.repoRoot });
    assert.equal(result.status, 'applied');
    assert.equal(result.warnings?.[0]?.code, 'ACTIVITY_LOG_UNAVAILABLE');
    assert.match(fs.readFileSync(f.taskMd, 'utf8'), /\| CD-1 \| code \| 1 \| major \| human-decided \|/);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});


test('explicit replacement retains old ruling and input while closing only the matching open operation', () => {
  const f = fixture();
  try {
    const options = { repoRoot: f.repoRoot, metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' }) };
    const initial = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use A', needsImplementation: true }, options);
    assert.equal(initial.status, 'applied');
    const content = updateTaskFrontmatter(fs.readFileSync(f.taskMd, 'utf8'), { lifecycle_execution: JSON.stringify({ version: 1, open: [{ family: 'code', agent: 'codex', startedAt: '2026-07-19 12:00:00+00:00', round: 2, implementationInput: 'II-1' }, { family: 'manual-validation', agent: 'codex', startedAt: '2026-07-19 12:00:00+00:00' }], prReview: { open: null, terminals: [] } }) });
    fs.writeFileSync(f.taskMd, content);
    const replacement = applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use B\nKeep the new identity.', needsImplementation: true, supersede: 'HDR-1' }, options);
    assert.equal(replacement.status, 'applied');
    assert.equal(replacement.recordId, 'HDR-2');
    const after = fs.readFileSync(f.taskMd, 'utf8');
    assert.match(after, /### HDR-1[\s\S]*Use A/);
    assert.match(after, /### HDR-2[\s\S]*Use B/);
    const inputs = parseImplementationInputs(after).rows;
    assert.equal(inputs.find((row) => row.id === 'II-1')?.status, 'superseded');
    assert.equal(inputs.find((row) => row.id === 'II-1')?.consumedBy, '');
    assert.equal(inputs.find((row) => row.id === 'II-2')?.status, 'pending');
    const state = JSON.parse(parseTypedTaskFrontmatter(after).lifecycle_execution as string);
    assert.deepEqual(state.open.map((row: { family: string }) => row.family), ['manual-validation']);
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use B\nKeep the new identity.', needsImplementation: true, supersede: 'HDR-1' }, options).status, 'no-op');
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use', needsImplementation: true, supersede: 'HDR-1' }, options).error?.code, 'DECISION_CONFLICT');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});


test('replacement of a historical ruling binds the original review to rework and keeps the new decision distinct', () => {
  const f = fixture();
  try {
    const options = { repoRoot: f.repoRoot, metadataProvider: () => ({ timestamp: '2026-07-19 12:00:00+00:00', agentInfraVersion: 'v0.8.6-alpha.0' }) };
    const review = '# Review\n\n### CD-1: Finding\n\nThe original evidence.\n';
    fs.writeFileSync(path.join(path.dirname(f.taskMd), 'review-code.md'), review);
    const hash = createHash('sha256').update(review).digest('hex');
    const classify = (id: string) => applyLedgerIntent({ kind: 'rework-intent-upsert', taskRef: f.taskId, intentId: id, findingId: 'CD-1', sourceArtifact: 'review-code.md', sourceSha256: hash, classification: 'implementation' }, options);
    assert.equal(classify('RI-1').status, 'applied');
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use A', needsImplementation: true }, options).status, 'applied');
    fs.writeFileSync(f.taskMd, fs.readFileSync(f.taskMd, 'utf8').replace('- **审查来源**：review-code.md#CD-1\n', ''));
    const replacement = { taskRef: f.taskId, selector: 'CD-1', decision: 'Use B', needsImplementation: true, supersede: 'HDR-1' };
    const before = fs.readFileSync(f.taskMd);
    assert.equal(applyHumanDecision(replacement, options).status, 'failed');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
    assert.equal(applyHumanDecision({ ...replacement, reviewSource: 'review-code.md#CD-1' }, options).status, 'applied');
    assert.equal(classify('RI-2').status, 'applied');
    const parsed = parseReworkIntentDocument(fs.readFileSync(f.taskMd, 'utf8'));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.intents.at(-1)?.classification, 'implementation');
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});


test('standalone code decisions can be replaced without inventing a review finding', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.taskMd, fs.readFileSync(f.taskMd, 'utf8').replace('| CD-1 | code | 1 | major | needs-human-decision | review-code.md#CD-1 |', '| HD-1 | code | - | decision | needs-human-decision | code.md#HD-1 |'));
    const options = { repoRoot: f.repoRoot };
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'HD-1', decision: 'First', needsImplementation: false }, options).status, 'applied');
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'HD-1', decision: 'Next', needsImplementation: true, supersede: 'HDR-1' }, options).status, 'applied');
    assert.deepEqual(parseImplementationInputs(fs.readFileSync(f.taskMd, 'utf8')).rows.map((row) => row.status), ['superseded', 'pending']);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});


test('rework classification distinguishes decision content and implementation intent while retaining unchanged evidence protection', () => {
  for (const variant of ['content', 'intent'] as const) {
    const f = fixture();
    try {
      const options = { repoRoot: f.repoRoot };
      const review = '# Review\n\n### CD-1: Finding\n\nOriginal evidence.\n';
      fs.writeFileSync(path.join(path.dirname(f.taskMd), 'review-code.md'), review);
      const hash = createHash('sha256').update(review).digest('hex');
      const decide = (decision: string, needsImplementation: boolean, supersede?: string) => applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision, needsImplementation, supersede }, options);
      const classify = (id: string) => applyLedgerIntent({ kind: 'rework-intent-upsert', taskRef: f.taskId, intentId: id, findingId: 'CD-1', sourceArtifact: 'review-code.md', sourceSha256: hash, classification: 'implementation' }, options);
      const first = 'Chosen direction\nImplement A';
      const next = variant === 'content' ? 'Chosen direction\nImplement B' : first;
      const needs = variant === 'content';
      assert.equal(decide(first, true).status, 'applied');
      assert.equal(classify('RI-1').status, 'applied');
      assert.equal(decide(next, needs, 'HDR-1').status, 'applied');
      assert.equal(classify('RI-2').status, 'applied');
      assert.equal(decide(next, needs, 'HDR-2').status, 'applied');
      assert.equal(classify('RI-3').status, 'applied');
      const parsed = parseReworkIntentDocument(fs.readFileSync(f.taskMd, 'utf8'));
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.deepEqual(parsed.intents.map((item) => item.classification), ['implementation', 'implementation', 'insufficient-evidence']);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
  }
});

test('replacement replay compares complete previous ruling and review source identities', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.taskMd, fs.readFileSync(f.taskMd, 'utf8').replace('review-code.md#CD-1', 'review-code.md#CD-1-detail'));
    const options = { repoRoot: f.repoRoot };
    assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: 'Use 1', needsImplementation: true }, options).status, 'applied');
    for (let i = 2; i <= 11; i++) assert.equal(applyHumanDecision({ taskRef: f.taskId, selector: 'CD-1', decision: `Use ${i}`, needsImplementation: true, supersede: `HDR-${i - 1}` }, options).status, 'applied');
    const request = { taskRef: f.taskId, selector: 'CD-1', decision: 'Use 11', needsImplementation: true, supersede: 'HDR-10', reviewSource: 'review-code.md#CD-1-detail' };
    assert.equal(applyHumanDecision(request, options).status, 'no-op');
    const before = fs.readFileSync(f.taskMd);
    assert.equal(applyHumanDecision({ ...request, supersede: 'HDR-1' }, options).error?.code, 'DECISION_CONFLICT');
    assert.equal(applyHumanDecision({ ...request, reviewSource: 'review-code.md#CD-1' }, options).error?.code, 'DECISION_CONFLICT');
    assert.deepEqual(fs.readFileSync(f.taskMd), before);
  } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});
