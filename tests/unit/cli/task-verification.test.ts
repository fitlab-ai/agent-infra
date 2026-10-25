import { taskWorkspaceRoot } from '../../helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  VERIFICATION_CATALOG,
  renderTaskVerification,
  verifyTaskEvent
} from '../../../lib/task/verification.ts';
import { verifyInProcess } from '../../../lib/task/verification-engine.ts';
import { canonicalSemanticDigest } from '../../../lib/task/artifact-operations.ts';
import { sha256File } from '../../../lib/task/artifact-receipts.ts';
import { createTaskWorkspaceFixture } from '../../helpers.ts';

const EXPECTED_EVENTS = [
  'analyze.awaiting-input', 'analyze.completed', 'review-analysis.completed',
  'plan.completed', 'review-plan.completed', 'code.completed', 'review-code.completed',
  'manual-validation.completed', 'validation-run.completed', 'block-task.completed', 'cancel-task.completed',
  'commit.completed', 'complete-task.preflight', 'complete-task.hard-preflight', 'complete-task.completed',
  'create-pr.completed', 'create-task.completed', 'import-codescan.completed',
  'import-dependabot.completed', 'import-issue.completed', 'watch-pr.completed',
  'review-pr.completed'
] as const;

function fixture(state: 'active' | 'blocked' | 'completed' = 'active') {
  const { repoRoot: root } = createTaskWorkspaceFixture('task-verification-unit-');
  const taskId = 'TASK-20260101-000001';
  const taskDir = path.join(taskWorkspaceRoot(root),  state, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `---\nid: ${taskId}\n---\n`);
  fs.mkdirSync(path.join(taskDir, '.runtime'), { recursive: true });
  return { root, taskId, taskDir };
}

function engine(status: 'pass' | 'fail' | 'blocked') {
  return (input: { mode: string; skillName: string; checks: string[] }) => ({
    ...(input.mode === 'gate' ? { gate: status, checks: [] } : { status, type: input.checks[0], message: 'fixture' }),
    skill: input.skillName, summary: 'fixture summary', action: 'fixture action'
  });
}

test('verification catalog is a closed mapping of all business events', async () => {
  assert.deepEqual(Object.keys(VERIFICATION_CATALOG).sort(), [...EXPECTED_EVENTS].sort());
  const expected = {
    'analyze.awaiting-input': ['analyze-task', 'active', 'checks', undefined, ['task-meta']],
    'analyze.completed': ['analyze-task', 'active', 'gate', 'analysis', undefined],
    'review-analysis.completed': ['review-analysis', 'active', 'gate', 'review-analysis', undefined],
    'plan.completed': ['plan-task', 'active', 'gate', 'plan', undefined],
    'review-plan.completed': ['review-plan', 'active', 'gate', 'review-plan', undefined],
    'code.completed': ['code-task', 'active', 'gate', 'code', undefined],
    'review-code.completed': ['review-code', 'active', 'gate', 'review-code', undefined],
    'manual-validation.completed': ['complete-manual-validation', 'active', 'gate', 'manual-validation', undefined],
    'validation-run.completed': ['run-manual-validation', 'active', 'gate', 'validation-run', undefined],
    'block-task.completed': ['block-task', 'blocked', 'gate', undefined, undefined],
    'cancel-task.completed': ['cancel-task', 'completed', 'gate', undefined, undefined],
    'commit.completed': ['commit', 'active', 'gate', undefined, undefined],
    'complete-task.preflight': ['complete-task', 'active', 'checks', undefined, ['required-pr-delivery']],
    'complete-task.hard-preflight': ['complete-task', 'active', 'checks', undefined, ['required-pr-delivery']],
    'complete-task.completed': ['complete-task', 'completed', 'gate', undefined, undefined],
    'create-pr.completed': ['create-pr', 'active', 'gate', undefined, undefined],
    'create-task.completed': ['create-task', 'active', 'gate', undefined, undefined],
    'import-codescan.completed': ['import-codescan', 'active', 'gate', undefined, undefined],
    'import-dependabot.completed': ['import-dependabot', 'active', 'gate', undefined, undefined],
    'import-issue.completed': ['import-issue', 'active', 'gate', undefined, undefined],
    'watch-pr.completed': ['watch-pr', 'active', 'gate', undefined, undefined],
    'review-pr.completed': ['review-pr', 'active', 'gate', 'pr-review', undefined]
  } as const;
  for (const event of EXPECTED_EVENTS) {
    const spec = VERIFICATION_CATALOG[event];
    assert.deepEqual([spec.skill, spec.expectedState, spec.mode, spec.artifactFamily, spec.checks], expected[event]);
  }
});

test('artifact lifecycle activity checks accept a current stage record after a downstream action', async () => {
  const stages = [
    { skill: 'analyze-task', family: 'analysis', event: 'analyze.completed', action: 'Analyze Task', output: 'analysis.md', inputFamily: null, later: 'Plan Task (Round 1)' },
    { skill: 'plan-task', family: 'plan', event: 'plan.completed', action: 'Plan Task', output: 'plan.md', inputFamily: 'analysis', later: 'Code Task (Round 1)' },
    { skill: 'review-analysis', family: 'review-analysis', event: 'review-analysis.completed', action: 'Review Analysis', output: 'review-analysis.md', inputFamily: 'analysis', later: 'Plan Task (Round 1)' },
    { skill: 'review-plan', family: 'review-plan', event: 'review-plan.completed', action: 'Review Plan', output: 'review-plan.md', inputFamily: 'plan', later: 'Code Task (Round 1)' },
    { skill: 'code-task', family: 'code', event: 'code.completed', action: 'Code Task', output: 'code.md', inputFamily: 'plan', later: 'Review Code (Round 1)' },
    { skill: 'review-code', family: 'review-code', event: 'review-code.completed', action: 'Review Code', output: 'review-code.md', inputFamily: 'code', later: 'Commit' }
  ] as const;

  for (const stage of stages) {
    const f = fixture();
    try {
      const input = stage.inputFamily ? `${stage.inputFamily}.md` : null;
      const inputPath = input ? path.join(f.taskDir, input) : null;
      const outputPath = path.join(f.taskDir, stage.output);
      if (inputPath) fs.writeFileSync(inputPath, `# ${stage.inputFamily}\n`);
      fs.writeFileSync(outputPath, `# ${stage.family}\n`);
      const prerequisiteAction = stage.inputFamily === 'analysis' ? 'Analyze Task'
        : stage.inputFamily === 'plan' ? 'Plan Task'
          : stage.inputFamily === 'code' ? 'Code Task' : null;
      const prerequisiteFact = input && inputPath && prerequisiteAction ? {
        event: stage.inputFamily === 'analysis' ? 'analyze.completed' : `${stage.inputFamily}.completed`,
        output: input, outputSha256: sha256File(inputPath),
        semanticDigest: canonicalSemanticDigest(fs.readFileSync(inputPath, 'utf8')),
        requestId: `${f.taskId}:${stage.inputFamily}`, result: '{}', lifecycleInputs: []
      } : null;
      const lifecycleInputs = inputPath
        ? [{ name: input!, sha256: sha256File(inputPath) }]
        : [];
      const fact = {
        event: stage.event,
        output: stage.output,
        outputSha256: sha256File(outputPath),
        semanticDigest: canonicalSemanticDigest(fs.readFileSync(outputPath, 'utf8')),
        requestId: `${f.taskId}:${stage.family}`,
        result: '{}',
        lifecycleInputs
      };
      const facts = prerequisiteFact ? [prerequisiteFact, fact] : [fact];
      const receiptRows = facts.flatMap((completion) => completion.lifecycleInputs.map((relation) => {
        const event = completion.event === 'analyze.completed' ? 'analysis.completed' : completion.event;
        return `| ${event} | ${completion.output} | ${relation.name} | ${relation.sha256} | 2026-01-01 00:00:03+00:00 |`;
      }));
      fs.writeFileSync(path.join(f.taskDir, 'task.md'), [
        '---',
        `id: ${f.taskId}`,
        'status: active',
        `completion_facts: '${JSON.stringify(facts)}'`,
        '---',
        '',
        '## Activity Log',
        '',
        ...(prerequisiteFact ? [
          `- 2026-01-01 00:00:00+00:00 — **${prerequisiteAction} (Round 1) [started]** by codex — started`,
          `- 2026-01-01 00:00:01+00:00 — **${prerequisiteAction} (Round 1)** by codex — Completed → ${input}`
        ] : []),
        `- 2026-01-01 00:00:02+00:00 — **${stage.action} (Round 1) [started]** by codex — started`,
        `- 2026-01-01 00:00:03+00:00 — **${stage.action} (Round 1)** by codex — Completed → ${stage.output}`,
        `- 2026-01-01 00:00:04+00:00 — **${stage.later}** by codex — Later independent stage`,
        '', '## Artifact Lifecycle Receipts', '',
        '| event | output | input | input_sha256 | completed_at |',
        '| --- | --- | --- | --- | --- |', ...receiptRows
      ].join('\n'));

      const result = await verifyInProcess({
        mode: 'checks', skillName: stage.skill, taskDir: f.taskDir,
        artifactFile: stage.output, checks: ['activity-log'], repositoryRoot: process.cwd()
      });
      assert.equal(result.status, 'pass', `${stage.skill}: ${result.message}`);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('artifact lifecycle activity checks reject stale inputs, missing facts, older rounds, and started-only rows', async () => {
  const f = fixture();
  const inputPath = path.join(f.taskDir, 'analysis.md');
  const outputPath = path.join(f.taskDir, 'plan.md');
  fs.writeFileSync(inputPath, '# Analysis\n');
  fs.writeFileSync(outputPath, '# Plan\n');
  const analysisFact = {
    event: 'analyze.completed', output: 'analysis.md', outputSha256: sha256File(inputPath),
    semanticDigest: canonicalSemanticDigest(fs.readFileSync(inputPath, 'utf8')),
    requestId: `${f.taskId}:analysis`, result: '{}', lifecycleInputs: []
  };
  const fact = {
    event: 'plan.completed', output: 'plan.md', outputSha256: sha256File(outputPath),
    semanticDigest: canonicalSemanticDigest(fs.readFileSync(outputPath, 'utf8')),
    requestId: `${f.taskId}:plan`, result: '{}',
    lifecycleInputs: [{ name: 'analysis.md', sha256: sha256File(inputPath) }]
  };
  const taskPath = path.join(f.taskDir, 'task.md');
  const analysisRows = [
    '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started',
    '- 2026-01-01 00:00:01+00:00 — **Analyze Task (Round 1)** by codex — Completed → analysis.md'
  ];
  const taskContent = (rows: string[], facts = [fact], extraFacts: typeof fact[] = []) => {
    const allFacts = [analysisFact, ...facts, ...extraFacts];
    const receiptRows = allFacts.flatMap((completion) => completion.lifecycleInputs.map((input) => {
      const event = completion.event === 'analyze.completed' ? 'analysis.completed' : completion.event;
      return `| ${event} | ${completion.output} | ${input.name} | ${input.sha256} | 2026-01-01 00:00:03+00:00 |`;
    }));
    return [
      '---', `id: ${f.taskId}`, 'status: active', `completion_facts: '${JSON.stringify(allFacts)}'`, '---',
      '', '## Activity Log', '', ...analysisRows, ...rows,
      '', '## Artifact Lifecycle Receipts', '',
      '| event | output | input | input_sha256 | completed_at |',
      '| --- | --- | --- | --- | --- |', ...receiptRows
    ].join('\n');
  };
  const verify = async (artifactFile = 'plan.md') => verifyInProcess({
    mode: 'checks', skillName: 'plan-task', taskDir: f.taskDir,
    artifactFile, checks: ['activity-log'], repositoryRoot: process.cwd()
  });
  try {
    fs.writeFileSync(taskPath, taskContent([
      '- 2026-01-01 00:00:02+00:00 — **Plan Task (Round 1) [started]** by codex — started',
      '- 2026-01-01 00:00:03+00:00 — **Plan Task (Round 1)** by codex — Completed → plan.md',
      '- 2026-01-01 00:00:04+00:00 — **Code Task (Round 1)** by codex — Later downstream stage'
    ]));
    fs.writeFileSync(inputPath, '# Analysis changed\n');
    let result = await verify();
    assert.equal(result.status, 'fail');
    assert.match(result.message, /Current plan artifact is unavailable/);

    fs.writeFileSync(inputPath, '# Analysis\n');
    fs.writeFileSync(taskPath, taskContent([
      '- 2026-01-01 00:00:02+00:00 — **Plan Task (Round 1) [started]** by codex — started',
      '- 2026-01-01 00:00:03+00:00 — **Plan Task (Round 1)** by codex — Completed → plan.md'
    ], []));
    result = await verify();
    assert.equal(result.status, 'fail');
    assert.match(result.message, /Current plan artifact is unavailable/);

    const planR2Path = path.join(f.taskDir, 'plan-r2.md');
    fs.writeFileSync(planR2Path, '# New Plan\n');
    const planR2Fact = {
      event: 'plan.completed', output: 'plan-r2.md', outputSha256: sha256File(planR2Path),
      semanticDigest: canonicalSemanticDigest(fs.readFileSync(planR2Path, 'utf8')),
      requestId: `${f.taskId}:plan-r2`, result: '{}',
      lifecycleInputs: [{ name: 'analysis.md', sha256: sha256File(inputPath) }]
    };
    fs.writeFileSync(taskPath, taskContent([
      '- 2026-01-01 00:00:02+00:00 — **Plan Task (Round 1) [started]** by codex — started',
      '- 2026-01-01 00:00:03+00:00 — **Plan Task (Round 1)** by codex — Completed → plan.md',
      '- 2026-01-01 00:00:04+00:00 — **Plan Task (Round 2) [started]** by codex — started',
      '- 2026-01-01 00:00:05+00:00 — **Plan Task (Round 2)** by codex — Completed → plan-r2.md'
    ], [fact], [planR2Fact]));
    result = await verify('plan.md');
    assert.equal(result.status, 'fail');
    assert.match(result.message, /not the current plan artifact/);

    fs.rmSync(path.join(f.taskDir, 'plan-r2.md'));
    fs.writeFileSync(taskPath, taskContent([
      '- 2026-01-01 00:00:02+00:00 — **Plan Task (Round 1) [started]** by codex — Resuming → plan.md'
    ]));
    result = await verify();
    assert.equal(result.status, 'pass');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('plan activity checks preserve completion facts after a human decision', async () => {
  const f = fixture();
  const analysisPath = path.join(f.taskDir, 'analysis.md');
  const planPath = path.join(f.taskDir, 'plan.md');
  fs.writeFileSync(analysisPath, '# Analysis\n');
  fs.writeFileSync(planPath, '# Plan\n');
  const analysisFact = {
    event: 'analyze.completed', output: 'analysis.md', outputSha256: sha256File(analysisPath),
    semanticDigest: canonicalSemanticDigest(fs.readFileSync(analysisPath, 'utf8')),
    requestId: `${f.taskId}:analysis`, result: '{}', lifecycleInputs: []
  };
  const fact = {
    event: 'plan.completed', output: 'plan.md', outputSha256: sha256File(planPath),
    semanticDigest: canonicalSemanticDigest(fs.readFileSync(planPath, 'utf8')),
    requestId: `${f.taskId}:plan`, result: '{}',
    lifecycleInputs: [{ name: 'analysis.md', sha256: sha256File(analysisPath) }]
  };
  const receiptRows = fact.lifecycleInputs.map((input) =>
    `| plan.completed | plan.md | ${input.name} | ${input.sha256} | 2026-01-01 00:00:03+00:00 |`);
  fs.writeFileSync(path.join(f.taskDir, 'task.md'), [
    '---', `id: ${f.taskId}`, 'status: active', `completion_facts: '${JSON.stringify([analysisFact, fact])}'`, '---',
    '', '## Activity Log', '',
    '- 2026-01-01 00:00:00+00:00 — **Analyze Task (Round 1) [started]** by codex — started',
    '- 2026-01-01 00:00:01+00:00 — **Analyze Task (Round 1)** by codex — Completed → analysis.md',
    '- 2026-01-01 00:00:02+00:00 — **Plan Task (Round 1) [started]** by codex — started',
    '- 2026-01-01 00:00:03+00:00 — **Plan Task (Round 1)** by codex — Completed → plan.md',
    '- 2026-01-01 00:00:04+00:00 — **Human Decision** by human — Accepted plan',
    '', '## Artifact Lifecycle Receipts', '',
    '| event | output | input | input_sha256 | completed_at |',
    '| --- | --- | --- | --- | --- |', ...receiptRows
  ].join('\n'));
  try {
    const result = await verifyInProcess({
      mode: 'checks', skillName: 'plan-task', taskDir: f.taskDir,
      artifactFile: 'plan.md', checks: ['activity-log'], repositoryRoot: process.cwd()
    });
    assert.equal(result.status, 'pass', result.message);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('artifact verification ignores Activity Log deletion, damage, and reordering but rejects changed input facts', async () => {
  const f = fixture();
  const analysisPath = path.join(f.taskDir, 'analysis.md');
  const planPath = path.join(f.taskDir, 'plan.md');
  fs.writeFileSync(analysisPath, '# Analysis\n');
  fs.writeFileSync(planPath, '# Plan\n');
  const analysisFact = {
    event: 'analyze.completed', output: 'analysis.md', outputSha256: sha256File(analysisPath),
    semanticDigest: canonicalSemanticDigest(fs.readFileSync(analysisPath, 'utf8')),
    requestId: `${f.taskId}:analysis`, result: '{}', lifecycleInputs: []
  };
  const fact = {
    event: 'plan.completed', output: 'plan.md', outputSha256: sha256File(planPath),
    semanticDigest: canonicalSemanticDigest(fs.readFileSync(planPath, 'utf8')),
    requestId: `${f.taskId}:plan`, result: '{}',
    lifecycleInputs: [{ name: 'analysis.md', sha256: sha256File(analysisPath) }]
  };
  const receipt = `| plan.completed | plan.md | analysis.md | ${sha256File(analysisPath)} | 2026-01-01 00:00:03+00:00 |`;
  const taskPath = path.join(f.taskDir, 'task.md');
  const base = [
    '---', `id: ${f.taskId}`, 'status: active', `completion_facts: '${JSON.stringify([analysisFact, fact])}'`, '---',
    '', '## Activity Log', '',
    '- 2026-01-01 00:00:00+00:00 — **Plan Task (Round 1) [started]** by codex — started',
    '- 2026-01-01 00:00:01+00:00 — **Plan Task (Round 1)** by codex — Completed → plan.md',
    '', '## Artifact Lifecycle Receipts', '',
    '| event | output | input | input_sha256 | completed_at |', '| --- | --- | --- | --- | --- |', receipt
  ].join('\n');
  const verify = () => verifyInProcess({
    mode: 'checks', skillName: 'plan-task', taskDir: f.taskDir,
    artifactFile: 'plan.md', checks: ['activity-log'], repositoryRoot: process.cwd()
  });
  try {
    fs.writeFileSync(taskPath, base);
    assert.equal((await verify()).status, 'pass');

    const withoutLog = base.replace(/\n## Activity Log\n[\s\S]*?(?=\n## Artifact Lifecycle Receipts)/u, '');
    fs.writeFileSync(taskPath, withoutLog);
    assert.equal((await verify()).status, 'pass');

    const damaged = base.replace('**Plan Task (Round 1)** by codex', '**Plan Task (Round 1) by codex');
    fs.writeFileSync(taskPath, damaged);
    assert.equal((await verify()).status, 'pass');

    const reordered = base.replace(
      /(- 2026-01-01 00:00:00\+00:00 — \*\*Plan Task \(Round 1\) \[started\]\*\* by codex — started)\n(- 2026-01-01 00:00:01\+00:00 — \*\*Plan Task \(Round 1\)\*\* by codex — Completed → plan\.md)/u,
      '$2\n$1'
    );
    fs.writeFileSync(taskPath, reordered);
    assert.equal((await verify()).status, 'pass');

    fs.writeFileSync(analysisPath, '# Changed Analysis\n');
    const invalid = await verify();
    assert.equal(invalid.status, 'fail');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('verification rejects workspace and artifact identity mismatches before invoking checks', async () => {
  const f = fixture();
  let calls = 0;
  const checkEngine = (input: Parameters<ReturnType<typeof engine>>[0]) => { calls += 1; return engine('pass')(input); };
  const wrongState = await verifyTaskEvent({ taskRef: f.taskId, event: 'block-task.completed' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(wrongState.error?.code, 'VERIFY_TASK_STATE_MISMATCH');
  const missingArtifact = await verifyTaskEvent({ taskRef: f.taskId, event: 'code.completed' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(missingArtifact.error?.code, 'VERIFY_ARTIFACT_REQUIRED');
  const extraArtifact = await verifyTaskEvent({ taskRef: f.taskId, event: 'commit.completed', artifact: 'code.md' }, { repoRoot: f.root, engine: checkEngine });
  assert.equal(extraArtifact.error?.code, 'VERIFY_ARTIFACT_UNEXPECTED');
  assert.equal(calls, 0);
});

test('preflight stops on the first non-pass and preserves blocked exit semantics', async () => {
  const f = fixture();
  let calls = 0;
  const result = await verifyTaskEvent({ taskRef: f.taskId, event: 'complete-task.preflight' }, {
    repoRoot: f.root,
    engine(input: Parameters<ReturnType<typeof engine>>[0]) { calls += 1; return engine('blocked')(input); }
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.invocations.length, 1);
  assert.equal(calls, 1);
});

test('text output summarizes passing checks and keeps soft warnings', () => {
  const text = renderTaskVerification({
    status: 'pass', changed: false, event: 'code.completed', requestRef: 'TASK-20260101-000001',
    taskId: 'TASK-20260101-000001', taskDir: '/tmp/task', taskState: 'active', skill: 'code-task', mode: 'checks', artifact: 'code.md', error: null,
    invocations: [{
      status: 'pass', exitCode: 0,
      payload: {
        skill: 'code-task', type: 'platform-sync', status: 'pass', checks: [{
          type: 'platform-sync', checkId: 'platform.comment-content', status: 'fail', effectiveStatus: 'pass',
          classification: 'soft', reason: 'check_failed', message: 'Comment content mismatch for code', action: 'Synchronize the comment'
        }], action: 'All declared checks passed'
      }
    }]
  });
  assert.match(text, /Verification: pass \| Target: code\.completed \(code\.md\) \| Skill: code-task/);
  assert.match(text, /Result: 1 passed, 0 failed/);
  assert.match(text, /Warning: platform\.comment-content \(check_failed\) - Comment content mismatch for code; Synchronize the comment/);
  assert.doesNotMatch(text, /\[pass\] platform\.comment-content/);
});

test('text output warns when a blocked platform check is normalized to pass', () => {
  const text = renderTaskVerification({
    status: 'pass', changed: false, event: 'code.completed', requestRef: 'TASK-20260101-000001',
    taskId: 'TASK-20260101-000001', taskDir: '/tmp/task', taskState: 'active', skill: 'code-task', mode: 'checks', artifact: 'code.md', error: null,
    invocations: [{
      status: 'pass', exitCode: 0,
      payload: {
        skill: 'code-task', type: 'platform-sync', status: 'pass', checks: [{
          type: 'platform-sync', checkId: 'platform.in-labels-computed', status: 'blocked', effectiveStatus: 'pass',
          classification: 'soft', reason: 'network_error', message: 'GitHub is unavailable', action: 'Retry after restoring access'
        }], action: 'All declared checks passed'
      }
    }]
  });
  assert.match(text, /Result: 1 passed, 0 failed/);
  assert.match(text, /Warning: platform\.in-labels-computed \(raw BLOCKED; network_error\) - GitHub is unavailable; Retry after restoring access/);
});

test('text output preserves human-decided post-review exemption notices on passing checks', () => {
  const message = 'Human-decided post-review exemption overrode PR_MERGE_IDENTITY_INVALID: PR merge identity does not match the reviewed head; PRC-1: maintainer allowed reviewed and merged identities';
  const text = renderTaskVerification({
    status: 'pass', changed: false, event: 'complete-task.completed', requestRef: 'TASK-20260101-000001',
    taskId: 'TASK-20260101-000001', taskDir: '/tmp/task', taskState: 'active', skill: 'complete-task', mode: 'gate', artifact: null, error: null,
    invocations: [{
      status: 'pass', exitCode: 0,
      payload: {
        skill: 'complete-task', gate: 'pass', checks: [{
          type: 'post-review-commit', checkId: 'post-review-commit', status: 'pass', effectiveStatus: 'pass',
          reason: 'OK', message, action: 'No action required'
        }], summary: '1 passed, 0 failed', action: 'All declared checks passed'
      }
    }]
  });
  assert.match(text, /Result: 1 passed, 0 failed/);
  assert.match(text, /Notice: post-review-commit - Human-decided post-review exemption overrode PR_MERGE_IDENTITY_INVALID/);
  assert.match(text, /PRC-1: maintainer allowed reviewed and merged identities/);
});

test('text output lists only failed and blocked check diagnostics', () => {
  const text = renderTaskVerification({
    status: 'blocked', changed: false, event: 'complete-task.preflight', requestRef: 'TASK-20260101-000001',
    taskId: 'TASK-20260101-000001', taskDir: '/tmp/task', taskState: 'active', skill: 'complete-task', mode: 'checks', artifact: null, error: null,
    invocations: [{
      status: 'blocked', exitCode: 2,
      payload: {
        skill: 'complete-task', type: 'required-pr-delivery', status: 'blocked', checkId: 'required-pr-delivery',
        message: 'GitHub is unavailable', action: 'Retry after restoring access'
      }
    }]
  });
  assert.match(text, /Verification: blocked \| Target: complete-task\.preflight \| Skill: complete-task/);
  assert.match(text, /Result: 0 passed, 0 failed, 1 blocked/);
  assert.match(text, /\[BLOCKED\] required-pr-delivery \(CHECK_FAILED\) - GitHub is unavailable; Retry after restoring access/);
});

test('text output does not list names of passing checks', () => {
  const text = renderTaskVerification({
    status: 'pass', changed: false, event: 'code.completed', requestRef: 'TASK-20260101-000001',
    taskId: 'TASK-20260101-000001', taskDir: '/tmp/task', taskState: 'active', skill: 'code-task', mode: 'gate', artifact: 'code.md', error: null,
    invocations: [{
      status: 'pass', exitCode: 0,
      payload: {
        skill: 'code-task', gate: 'pass', checks: [
          { type: 'artifact', checkId: 'artifact.schema', status: 'pass', effectiveStatus: 'pass' },
          { type: 'snapshot', checkId: 'snapshot.fresh', status: 'pass', effectiveStatus: 'pass' }
        ], summary: '2 passed, 0 failed', action: 'All declared checks passed'
      }
    }]
  });
  assert.match(text, /Result: 2 passed, 0 failed/);
  assert.doesNotMatch(text, /artifact\.schema|snapshot\.fresh/);
});

test('unknown events fail with a stable verification error', async () => {
  const f = fixture();
  const unknown = await verifyTaskEvent({ taskRef: f.taskId, event: 'unknown.completed' }, { repoRoot: f.root });
  assert.equal(unknown.error?.code, 'VERIFY_EVENT_UNKNOWN');
});
