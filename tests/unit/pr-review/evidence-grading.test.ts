import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyScenario,
  collectHostCandidates,
  decide,
  deriveTaskIssueMatches,
  evaluateHead,
  extractClosingIssueNumbers,
  gradeRisk,
  HostResolutionError,
  resolveHostFromCandidates,
  selectMode
} from '../../../lib/pr-review/evidence-grading.ts';
import type {
  ArtifactPresence,
  HeadState,
  HostCandidate,
  HostResolution,
  RiskFactors
} from '../../../lib/pr-review/evidence-grading.ts';
import { buildBoundFact, encodePrDeliveryFact } from '../../../lib/task/pr-delivery-fact.ts';

const UNIQUE_HOST: HostResolution = {
  kind: 'unique', taskId: 'TASK-20260101-000001', taskDir: '/tmp/task', issueNumber: 7, prNumber: 42
};
const NONE_HOST: HostResolution = { kind: 'none' };
const AMBIGUOUS_HOST: HostResolution = {
  kind: 'ambiguous',
  candidates: [{ taskId: 'TASK-1', issueNumber: 7 }, { taskId: 'TASK-2', issueNumber: 8 }]
};

function fullPresence(overrides: Partial<ArtifactPresence> = {}): ArtifactPresence {
  return {
    hasAnalysis: true,
    hasPlan: true,
    hasCode: true,
    hasReviewAnalysis: true,
    hasReviewPlan: true,
    hasReviewCode: true,
    hasPriorPrReview: true,
    ...overrides
  };
}

function head(overrides: Partial<HeadState> = {}): HeadState {
  return {
    currentHeadSha: 'a'.repeat(40),
    priorHeadSha: 'a'.repeat(40),
    issueNumberBound: true,
    taskIssueMatches: true,
    prNumberBound: true,
    taskPrMatches: true,
    ...overrides
  };
}

function lowRisk(overrides: Partial<RiskFactors> = {}): RiskFactors {
  return {
    changeSize: 'LOW', sensitivity: 'LOW', structural: 'LOW',
    testCoverage: 'LOW', sourceCredibility: 'LOW', recoveryImpact: 'LOW',
    ...overrides
  };
}

// --- Host resolution (PL-4, AN-6) ---

test('resolveHostFromCandidates collapses zero/one/many into none/unique/ambiguous', () => {
  assert.deepEqual(resolveHostFromCandidates([]), { kind: 'none' });

  const single: HostCandidate = {
    taskId: 'TASK-20260101-000001', taskDir: '/tmp/t1', issueNumber: 7, prNumber: 42
  };
  assert.deepEqual(resolveHostFromCandidates([single]), {
    kind: 'unique', taskId: 'TASK-20260101-000001', taskDir: '/tmp/t1', issueNumber: 7, prNumber: 42
  });

  const second: HostCandidate = {
    taskId: 'TASK-20260102-000002', taskDir: '/tmp/t2', issueNumber: 8, prNumber: null
  };
  assert.deepEqual(resolveHostFromCandidates([single, second]), {
    kind: 'ambiguous',
    candidates: [
      { taskId: 'TASK-20260101-000001', issueNumber: 7 },
      { taskId: 'TASK-20260102-000002', issueNumber: 8 }
    ]
  });
});

test('extractClosingIssueNumbers parses Closes/Fixes lists with case and separator variants', () => {
  assert.deepEqual(extractClosingIssueNumbers('Closes #1'), [1]);
  assert.deepEqual(extractClosingIssueNumbers('Fixes: #2, #3'), [2, 3]);
  assert.deepEqual(extractClosingIssueNumbers('fixes #4 #5'), [4, 5]);
  assert.deepEqual(extractClosingIssueNumbers('RESOLVES #6, #7\n\nBody text'), [6, 7]);
  assert.deepEqual(extractClosingIssueNumbers('No keywords here #9'), []);
  assert.deepEqual(extractClosingIssueNumbers('Closes #1, closes #1'), [1]);
  assert.deepEqual(extractClosingIssueNumbers(''), []);
});

test('collectHostCandidates scans active tasks and prioritizes verified fact identity hits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-host-'));
  try {
    const active = path.join(root, '.agents', 'workspace', 'active');
    const writeTask = (taskId: string, frontmatter: string) => {
      const dir = path.join(active, taskId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'task.md'), `---\nid: ${taskId}\n${frontmatter}---\n`);
    };
    const factLine = (number: number) => `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildBoundFact({ identity: { resource: { kind: 'number', value: number }, repository: 'acme/widgets', url: `https://github.com/acme/widgets/pull/${number}`, head: { repository: 'acme/widgets', ref: 'feature', sha: 'a'.repeat(40) }, base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) } }, source: 'created', verifiedAt: '2026-01-01T00:00:00.000Z', remoteState: 'open' })))}`;
    writeTask('TASK-1', `issue_number: 7\n${factLine(42)}\n`);
    writeTask('TASK-2', 'issue_number: 7\n');
    writeTask('TASK-3', 'issue_number: 9\n');
    writeTask('TASK-4', `issue_number: 10\n${factLine(99)}\n`);

    const candidates = collectHostCandidates({ prNumber: 42, closingIssues: [7, 9], workspaceRoot: root });
    const byId = new Map(candidates.map((candidate) => [candidate.taskId, candidate]));
    // TASK-1 matches by fact identity (42) and issue (7); identity wins as a single candidate.
    assert.equal(candidates.length, 3);
    assert.deepEqual(byId.get('TASK-1'), { taskId: 'TASK-1', taskDir: path.join(active, 'TASK-1'), issueNumber: 7, prNumber: 42 });
    assert.deepEqual(byId.get('TASK-2'), { taskId: 'TASK-2', taskDir: path.join(active, 'TASK-2'), issueNumber: 7, prNumber: null });
    assert.deepEqual(byId.get('TASK-3'), { taskId: 'TASK-3', taskDir: path.join(active, 'TASK-3'), issueNumber: 9, prNumber: null });
    assert.equal(byId.has('TASK-4'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectHostCandidates tolerates a missing workspace root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-empty-'));
  try {
    assert.deepEqual(collectHostCandidates({ prNumber: 42, closingIssues: [7], workspaceRoot: root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deriveTaskIssueMatches mechanically derives the S1(a) trust factor from resolved data', () => {
  // unique host whose bound issue_number is among the PR closing issues -> trusted
  assert.equal(deriveTaskIssueMatches(UNIQUE_HOST, [7, 9]), true);
  assert.equal(deriveTaskIssueMatches(UNIQUE_HOST, [9]), false);
  // none / ambiguous hosts and unbounded tasks cannot be confirmed -> false (fail closed)
  assert.equal(deriveTaskIssueMatches(NONE_HOST, [7]), false);
  assert.equal(deriveTaskIssueMatches(AMBIGUOUS_HOST, [7]), false);
  assert.equal(deriveTaskIssueMatches({ ...UNIQUE_HOST, issueNumber: 0 }, [7]), false);
});

// --- Interception behaviour (PL-4, AN-6): ambiguous host fails closed ---

test('classifyScenario and decide reject an ambiguous host', () => {
  assert.throws(() => classifyScenario(AMBIGUOUS_HOST, fullPresence(), head()), HostResolutionError);
  assert.throws(
    () => decide({ host: AMBIGUOUS_HOST, presence: fullPresence(), head: head(), riskFactors: lowRisk() }),
    (error: unknown) => error instanceof HostResolutionError && error.code === 'HOST_AMBIGUOUS'
  );
});

// --- S1/S2/S3 classification (PL-3/PL-5/PL-9) ---

test('classifyScenario returns S1 for a fully trusted aligned review', () => {
  assert.equal(classifyScenario(UNIQUE_HOST, fullPresence(), head()), 'S1');
});

test('classifyScenario returns S2 when review-analysis is missing (PL-3)', () => {
  assert.equal(classifyScenario(UNIQUE_HOST, fullPresence({ hasReviewAnalysis: false }), head()), 'S2');
});

test('classifyScenario returns S2 when review-plan is missing (PL-3)', () => {
  assert.equal(classifyScenario(UNIQUE_HOST, fullPresence({ hasReviewPlan: false }), head()), 'S2');
});

test('classifyScenario returns S2 when taskIssueMatches is false (S1(a) untrusted)', () => {
  assert.equal(classifyScenario(UNIQUE_HOST, fullPresence(), head({ taskIssueMatches: false })), 'S2');
});

test('classifyScenario returns S2 when the prior head drifted', () => {
  assert.equal(classifyScenario(UNIQUE_HOST, fullPresence(), head({ priorHeadSha: 'b'.repeat(40) })), 'S2');
});

test('classifyScenario returns S2 when there is no prior pr-review (first review, AN-7)', () => {
  const presence = fullPresence({ hasPriorPrReview: false });
  assert.equal(classifyScenario(UNIQUE_HOST, presence, head({ priorHeadSha: null })), 'S2');
});

test('classifyScenario returns S3 for a missing host', () => {
  assert.equal(classifyScenario(NONE_HOST, fullPresence(), head()), 'S3');
});

test('classifyScenario returns S3 for a task with no lifecycle artifacts and no prior review', () => {
  const presence = {
    hasAnalysis: false, hasPlan: false, hasCode: false,
    hasReviewAnalysis: false, hasReviewPlan: false, hasReviewCode: false, hasPriorPrReview: false
  };
  assert.equal(classifyScenario(UNIQUE_HOST, presence, head()), 'S3');
});

test('classifyScenario returns S2 for a task with only review-code (PL-5)', () => {
  const presence = {
    hasAnalysis: false, hasPlan: false, hasCode: false,
    hasReviewAnalysis: false, hasReviewPlan: false, hasReviewCode: true, hasPriorPrReview: false
  };
  assert.equal(classifyScenario(UNIQUE_HOST, presence, head()), 'S2');
});

test('classifyScenario returns S2 for a task with only review-analysis (PL-9)', () => {
  const presence = {
    hasAnalysis: false, hasPlan: false, hasCode: false,
    hasReviewAnalysis: true, hasReviewPlan: false, hasReviewCode: false, hasPriorPrReview: false
  };
  assert.equal(classifyScenario(UNIQUE_HOST, presence, head()), 'S2');
});

test('classifyScenario returns S2 for a task with only review-plan (PL-9)', () => {
  const presence = {
    hasAnalysis: false, hasPlan: false, hasCode: false,
    hasReviewAnalysis: false, hasReviewPlan: true, hasReviewCode: false, hasPriorPrReview: false
  };
  assert.equal(classifyScenario(UNIQUE_HOST, presence, head()), 'S2');
});

// --- Freshness and alignment (AN-7) ---

test('evaluateHead is n/a on first review and stale/misaligned on drift', () => {
  assert.deepEqual(evaluateHead(head({ priorHeadSha: null })), { freshness: 'n/a', alignment: 'n/a' });
  assert.deepEqual(evaluateHead(head({ priorHeadSha: 'a'.repeat(40) })), { freshness: 'fresh', alignment: 'aligned' });
  assert.deepEqual(evaluateHead(head({ priorHeadSha: 'b'.repeat(40) })), { freshness: 'stale', alignment: 'misaligned' });
  assert.deepEqual(evaluateHead(head({ taskPrMatches: false })), { freshness: 'fresh', alignment: 'misaligned' });
});

// --- Risk grading (AN-5: pure evidence, no identity) ---

test('gradeRisk elevates priority factors first and ignores identity fields', () => {
  assert.equal(gradeRisk(lowRisk({ sensitivity: 'HIGH' })), 'HIGH');
  assert.equal(gradeRisk(lowRisk({ sourceCredibility: 'HIGH' })), 'HIGH');
  assert.equal(gradeRisk(lowRisk({ changeSize: 'HIGH' })), 'MEDIUM');
  assert.equal(gradeRisk(lowRisk()), 'LOW');
});

test('RiskFactors input has exactly the six pure-evidence factors (no identity)', () => {
  assert.deepEqual(
    Object.keys(lowRisk()).sort(),
    ['changeSize', 'recoveryImpact', 'sensitivity', 'sourceCredibility', 'structural', 'testCoverage'].sort()
  );
});

// --- Mode selection matrix (AN-7) ---

test('selectMode follows the S1/S2/S3 matrix with audit fallback', () => {
  assert.equal(selectMode('S3', 'n/a', 'n/a', 'LOW'), 'reconstruct');
  assert.equal(selectMode('S2', 'stale', 'misaligned', 'HIGH'), 'audit');
  assert.equal(selectMode('S1', 'fresh', 'aligned', 'LOW'), 'verify');
  assert.equal(selectMode('S1', 'fresh', 'aligned', 'MEDIUM'), 'verify');
  assert.equal(selectMode('S1', 'fresh', 'aligned', 'HIGH'), 'audit');
  assert.equal(selectMode('S1', 'stale', 'misaligned', 'LOW'), 'audit');
  assert.equal(selectMode('S1', 'n/a', 'n/a', 'LOW'), 'audit');
});

// --- decide pipeline ---

test('decide produces a traceable first-review audit decision for a full task', () => {
  const presence = fullPresence({ hasPriorPrReview: false });
  const record = decide({ host: UNIQUE_HOST, presence, head: head({ priorHeadSha: null }), riskFactors: lowRisk() });
  assert.equal(record.scenario, 'S2');
  assert.equal(record.mode, 'audit');
  assert.equal(record.firstReview, true);
  assert.equal(record.freshness, 'n/a');
  assert.ok(record.reason.includes('mode audit'));
});

test('decide produces verify for a trusted aligned repeat review at low risk', () => {
  const record = decide({ host: UNIQUE_HOST, presence: fullPresence(), head: head(), riskFactors: lowRisk() });
  assert.equal(record.scenario, 'S1');
  assert.equal(record.mode, 'verify');
  assert.equal(record.firstReview, false);
  assert.equal(record.risk, 'LOW');
});

test('decide produces reconstruct for a host-less PR', () => {
  const presence = fullPresence({ hasPriorPrReview: false });
  const record = decide({ host: NONE_HOST, presence, head: head({ priorHeadSha: null }), riskFactors: lowRisk() });
  assert.equal(record.scenario, 'S3');
  assert.equal(record.mode, 'reconstruct');
});
