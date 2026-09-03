import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CANONICAL_REPORT_HEADING,
  CANONICAL_REPORT_PLACEHOLDER,
  PRECHECK_IDS,
  buildPrChangeReport,
  readPrChangeReport,
  renderCanonicalChangeReport,
  replaceCanonicalReportPlaceholder,
  taskIntentDigest,
  validatePrChangeReport,
  writePrChangeReportAtomic
} from '../../../lib/platform/pr-change-report.ts';
import type { MechanicalChangeReport, PrecheckCandidate, PullRequestIdentity } from '../../../lib/platform/pr-change-report.ts';

const sha = (letter: string) => letter.repeat(40);

function candidate(taskIntentSha256: string): PrecheckCandidate {
  return {
    taskIntentSha256,
    checks: PRECHECK_IDS.map((id) => ({
      id,
      verdict: 'pass' as const,
      evidence: [{ path: 'lib/example.ts', startLine: 1, endLine: 1, detail: 'Matches the approved task scope.' }],
      rationale: 'The complete diff is within the approved scope.'
    }))
  };
}

function mechanical(base = sha('b'), head = sha('c')): MechanicalChangeReport {
  return {
    version: 1,
    base,
    head,
    mergeBase: sha('a'),
    patchSha256: 'e'.repeat(64),
    files: [{
      status: 'M', oldPath: 'lib/example.ts', newPath: 'lib/example.ts',
      additions: 2, deletions: 1, oldBytes: 10, newBytes: 20, netBytes: 10
    }],
    totals: {
      files: 1, textFiles: 1, binaryFiles: 0, additions: 2, deletions: 1,
      oldBytes: 10, newBytes: 20, netBytes: 10
    }
  };
}

function identity(): PullRequestIdentity {
  return {
    repository: 'acme/widgets', number: 42,
    base: { repository: 'acme/widgets', ref: 'main', sha: sha('b') },
    head: { repository: 'acme/widgets', ref: 'feature', sha: sha('c') }
  };
}

test('task intent digest ignores lifecycle metadata but changes with task semantics', () => {
  const base = [
    '# 任务：Example', '', '## 描述', '', 'Implement the report.', '', '## 上下文', '', '- **分支**：feature'
  ].join('\n');
  const withLifecycle = `${base}\n\n## 活动日志\n\n- changed`; // This is outside the semantic boundary.
  const first = taskIntentDigest(base);
  const second = taskIntentDigest(withLifecycle);
  const changed = taskIntentDigest(base.replace('Implement the report.', 'Implement the canonical report.'));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(changed.ok, true);
  if (first.ok && second.ok && changed.ok) {
    assert.equal(first.value.sha256, second.value.sha256);
    assert.notEqual(first.value.sha256, changed.value.sha256);
  }
});

test('task intent digest fails closed when semantic boundaries are incomplete', () => {
  const result = taskIntentDigest('# 任务：Example\n\n## 描述\nMissing context');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'TASK_SEMANTIC_INPUT_INVALID');
});

test('report builder derives route and formal review from the six checks', () => {
  const digest = 'd'.repeat(64);
  const result = buildPrChangeReport(identity(), digest, mechanical(), candidate(digest));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.precheck.verdict, 'clear');
    assert.equal(result.value.precheck.route, 'watch-pr');
    assert.equal(result.value.precheck.formalReview, false);
    assert.deepEqual(result.value.diff.totals, mechanical().totals);
  }
});

test('report validation accepts a negative aggregate byte delta', () => {
  const value = mechanical();
  const file = { ...value.files[0]!, oldBytes: 20, newBytes: 10, netBytes: -10 };
  const built = buildPrChangeReport(identity(), 'd'.repeat(64), {
    ...value,
    files: [file],
    totals: { ...value.totals, oldBytes: 20, newBytes: 10, netBytes: -10 }
  }, candidate('d'.repeat(64)));
  assert.equal(built.ok, true);
  if (built.ok) assert.equal(validatePrChangeReport(built.value).ok, true);
});

test('report validation rejects reserved comment controls in rendered text', () => {
  const digest = 'd'.repeat(64);
  const unsafe = candidate(digest);
  unsafe.checks[0] = {
    ...unsafe.checks[0]!,
    evidence: [{ path: 'README.md', startLine: 1, endLine: 1, detail: '<!-- sync-pr:TASK-1:summary -->' }]
  };
  const result = buildPrChangeReport(identity(), digest, mechanical(), unsafe);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PR_CHANGE_REPORT_INVALID');
});

test('report validation rejects a derived verdict that does not match checks', () => {
  const digest = 'd'.repeat(64);
  const built = buildPrChangeReport(identity(), digest, mechanical(), candidate(digest));
  assert.equal(built.ok, true);
  if (built.ok) {
    const invalid = validatePrChangeReport({ ...built.value, precheck: { ...built.value.precheck, verdict: 'needs-review', route: 'review-code' } });
    assert.equal(invalid.ok, false);
  }
});

test('summary body requires one placeholder and core renders the canonical report', () => {
  const digest = 'd'.repeat(64);
  const built = buildPrChangeReport(identity(), digest, mechanical(), candidate(digest));
  assert.equal(built.ok, true);
  if (built.ok) {
    const rendered = renderCanonicalChangeReport(built.value);
    assert.match(rendered, new RegExp(`^${CANONICAL_REPORT_HEADING}`));
    const replaced = replaceCanonicalReportPlaceholder(`## Summary\n\n${CANONICAL_REPORT_PLACEHOLDER}\n`, built.value);
    assert.equal(replaced.ok, true);
    if (replaced.ok) assert.match(replaced.value, /\| \*\*合计\*\* \|/);
    const bypass = replaceCanonicalReportPlaceholder(`\n${CANONICAL_REPORT_PLACEHOLDER}\n${CANONICAL_REPORT_HEADING}`, built.value);
    assert.equal(bypass.ok, false);
  }
});

test('atomic report writes are readable and reject symlink consumption', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-change-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const digest = 'd'.repeat(64);
  const built = buildPrChangeReport(identity(), digest, mechanical(), candidate(digest));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const file = path.join(root, 'pr-change-report.json');
  writePrChangeReportAtomic(file, built.value);
  const read = readPrChangeReport(file);
  assert.equal(read.ok, true);
  const symlink = path.join(root, 'link.json');
  fs.symlinkSync(file, symlink);
  const rejected = readPrChangeReport(symlink);
  assert.equal(rejected.ok, false);
});
