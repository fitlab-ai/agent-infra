import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  validatePrecheckCandidate,
  validateMechanicalReport,
  validatePrChangeReport,
  writePrChangeReportAtomic
} from '../../../lib/platform/pr-change-report.ts';
import type { ChangeFile, MechanicalChangeReport, PrecheckCandidate, PullRequestIdentity } from '../../../lib/platform/pr-change-report.ts';
import { createTempDir } from '../../helpers.ts';

const sha = (letter: string) => letter.repeat(40);

function withLocations<T extends Omit<ChangeFile, 'locations'>>(files: T[]) {
  return files.map((file) => ({ ...file, locations: file.additions === null ? [] : [
    ...(file.additions ? [{ side: 'new' as const, startLine: 1, endLine: file.additions }] : []),
    ...(file.deletions ? [{ side: 'old' as const, startLine: 1, endLine: file.deletions }] : [])
  ] }));
}

function bundle(base: string, head: string, files: ReturnType<typeof withLocations>, totals: MechanicalChangeReport['full']['totals']): MechanicalChangeReport {
  return { version: 2, base, head, full: { kind: 'merge-base', from: sha('a'), to: head, mergeBase: sha('a'), patchSha256: 'e'.repeat(64), files, totals },
    increment: { status: 'unconfirmed', fromHead: null, toHead: head, sourceReportSha256: null, diff: null } };
}

function candidate(taskIntentSha256: string, diff = mechanical()): PrecheckCandidate {
  const full = diff.full.files;
  const increment = diff.increment.diff?.files ?? [];
  const allocations = (files: typeof full) => files.flatMap((file) => file.locations.map((location) => ({ path: file.oldPath ?? file.newPath!, ...location })));
  return {
    taskIntentSha256,
    checks: PRECHECK_IDS.map((id) => ({
      id,
      verdict: 'pass' as const,
      evidence: [{ path: 'lib/example.ts', startLine: 1, endLine: 1, detail: 'Matches the approved task scope.' }],
      rationale: 'The complete diff is within the approved scope.',
      ...(id === 'change-composition' ? { groups: [{
        id: 'summary-content', target: 'Structure managed comment content', behaviorChange: 'Validate and render typed content.',
        necessity: 'Keep required content complete.', files: [...new Set([...full, ...increment].map((file) => file.oldPath ?? file.newPath!))],
        locations: { full: allocations(full), increment: allocations(increment) },
        tests: { coverage: 'Existing unit and integration contracts cover the change.', cost: 'No new fixture beyond this candidate.' }
      }], unassigned: { full: [], increment: [] } } : {})
    }))
  };
}

function detailedCandidate(taskIntentSha256: string, diff = mechanical()): PrecheckCandidate {
  const full = diff.full.files;
  const increment = diff.increment.diff?.files ?? [];
  const allocations = (files: typeof full) => files.flatMap((file) => file.locations.map((location) => ({ path: file.oldPath ?? file.newPath!, ...location })));
  return {
    taskIntentSha256,
    checks: PRECHECK_IDS.map((id, index) => ({
      id,
      verdict: 'pass' as const,
      evidence: [{
        path: `checks/${id}.ts`, startLine: index + 10, endLine: index + 11,
        detail: `Evidence-${id}-<detail>`
      }],
      rationale: `Rationale-${id}-responsibility-${index}`,
      ...(id === 'change-composition' ? { groups: [{
        id: 'summary-content', target: 'Structured content', behaviorChange: 'Add structure validation.', necessity: 'Prevent missing sections.',
        files: [...new Set([...full, ...increment].map((file) => file.oldPath ?? file.newPath!))],
        locations: { full: allocations(full), increment: allocations(increment) },
        tests: { coverage: 'Tests exercise required paths.', cost: 'One shared fixture.' }
      }], unassigned: { full: [], increment: [] } } : {})
    }))
  };
}

function mechanical(base = sha('b'), head = sha('c')): MechanicalChangeReport {
  const files = withLocations([{
      status: 'M', oldPath: 'lib/example.ts', newPath: 'lib/example.ts',
      additions: 2, deletions: 1, oldBytes: 10, newBytes: 20, netBytes: 10
    }]);
  return bundle(base, head, files, {
      files: 1, textFiles: 1, binaryFiles: 0, additions: 2, deletions: 1,
      oldBytes: 10, newBytes: 20, netBytes: 10
    });
}

function categorizedMechanical(base = sha('b'), head = sha('c')): MechanicalChangeReport {
  const files = withLocations([
    { status: 'M', oldPath: 'lib/example.ts', newPath: 'lib/example.ts', additions: 4, deletions: 1, oldBytes: 10, newBytes: 13, netBytes: 3 },
    { status: 'M', oldPath: 'tests/example.test.ts', newPath: 'tests/example.test.ts', additions: 2, deletions: 0, oldBytes: 5, newBytes: 7, netBytes: 2 },
    { status: 'A', oldPath: null, newPath: 'templates/example.md', additions: 3, deletions: 0, oldBytes: 0, newBytes: 20, netBytes: 20 },
    { status: 'D', oldPath: '.agents/example.md', newPath: null, additions: 0, deletions: 2, oldBytes: 10, newBytes: 0, netBytes: -10 },
    { status: 'M', oldPath: 'README.md', newPath: 'README.md', additions: null, deletions: null, oldBytes: 0, newBytes: 4, netBytes: 4 },
    { status: 'A', oldPath: null, newPath: 'package.json', additions: 1, deletions: 0, oldBytes: 0, newBytes: 1, netBytes: 1 }
  ]);
  return bundle(base, head, files, {
      files: 6, textFiles: 5, binaryFiles: 1, additions: 10, deletions: 3,
      oldBytes: 25, newBytes: 45, netBytes: 20
    });
}

function representativeMechanical(base = sha('b'), head = sha('c')): MechanicalChangeReport {
  const files = withLocations([
    { status: 'M', oldPath: 'lib/large.ts', newPath: 'lib/large.ts', additions: 8, deletions: 4, oldBytes: 100, newBytes: 110, netBytes: 10 },
    { status: 'M', oldPath: 'tests/large.test.ts', newPath: 'tests/large.test.ts', additions: 6, deletions: 6, oldBytes: 20, newBytes: 20, netBytes: 0 },
    { status: 'A', oldPath: null, newPath: 'templates/large.md', additions: 7, deletions: 0, oldBytes: 0, newBytes: 90, netBytes: 90 },
    { status: 'R100', oldPath: '.agents/old.md', newPath: '.agents/new.md', additions: 0, deletions: 0, oldBytes: 300, newBytes: 300, netBytes: 0 },
    { status: 'M', oldPath: 'README.md', newPath: 'README.md', additions: null, deletions: null, oldBytes: 600, newBytes: 300, netBytes: -300 },
    { status: 'D', oldPath: 'tests/removed.test.ts', newPath: null, additions: 0, deletions: 10, oldBytes: 300, newBytes: 0, netBytes: -300 }
  ]);
  return bundle(base, head, files, {
      files: 6, textFiles: 5, binaryFiles: 1, additions: 21, deletions: 20,
      oldBytes: 1320, newBytes: 820, netBytes: -500
    });
}

function identity(): PullRequestIdentity {
  return {
    repository: 'acme/widgets', resource: { kind: 'number', value: 42 },
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
    assert.deepEqual(result.value.diff.full.totals, mechanical().full.totals);
  }
});

test('report validation accepts a negative aggregate byte delta', () => {
  const value = mechanical();
  const file = { ...value.full.files[0]!, oldBytes: 20, newBytes: 10, netBytes: -10 };
  const built = buildPrChangeReport(identity(), 'd'.repeat(64), {
    ...value,
    full: { ...value.full, files: [file], totals: { ...value.full.totals, oldBytes: 20, newBytes: 10, netBytes: -10 } }
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

test('report validation rejects inconsistent totals and verdict facts', () => {
  const digest = 'd'.repeat(64);
  const built = buildPrChangeReport(identity(), digest, mechanical(), candidate(digest));
  assert.equal(built.ok, true);
  if (built.ok) {
    const mismatchedTotals = {
      ...built.value,
      diff: { ...built.value.diff, full: { ...built.value.diff.full, totals: { ...built.value.diff.full.totals, additions: built.value.diff.full.totals.additions + 1 } } }
    };
    assert.equal(validatePrChangeReport(mismatchedTotals).ok, false);
    const invalid = validatePrChangeReport({ ...built.value, precheck: { ...built.value.precheck, verdict: 'needs-review', route: 'review-code' } });
    assert.equal(invalid.ok, false);
  }
});

test('mechanical and persisted reports share head-to-head endpoint rules', () => {
  const digest = 'd'.repeat(64);
  const diff = mechanical();
  diff.increment = {
    status: 'available', fromHead: sha('d'), toHead: sha('c'), sourceReportSha256: 'f'.repeat(64),
    diff: { kind: 'head-to-head', from: sha('d'), to: sha('c'), mergeBase: null, patchSha256: 'a'.repeat(64),
      files: diff.full.files, totals: diff.full.totals }
  };
  const built = buildPrChangeReport(identity(), digest, diff, candidate(digest, diff));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(validateMechanicalReport(diff).ok, true);
  assert.equal(validatePrChangeReport(built.value).ok, true);

  const sameEndpoint = structuredClone(diff);
  sameEndpoint.increment.diff!.from = sha('c');
  sameEndpoint.increment.fromHead = sha('c');
  const sameEndpointReport = structuredClone(built.value);
  sameEndpointReport.diff.increment.diff!.from = sha('c');
  sameEndpointReport.diff.increment.fromHead = sha('c');
  assert.equal(validateMechanicalReport(sameEndpoint).ok, false);
  assert.equal(validatePrChangeReport(sameEndpointReport).ok, false);
});

test('mechanical and persisted scopes share file totals and increment status rules', () => {
  const digest = 'd'.repeat(64);
  const diff = mechanical();
  const badTotals = structuredClone(diff);
  badTotals.full.totals.additions += 1;
  assert.equal(validateMechanicalReport(badTotals).ok, false);

  const built = buildPrChangeReport(identity(), digest, diff, candidate(digest));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const badReportTotals = structuredClone(built.value);
  badReportTotals.diff.full.totals.additions += 1;
  assert.equal(validatePrChangeReport(badReportTotals).ok, false);

  const badIncrement = structuredClone(diff);
  badIncrement.increment = {
    status: 'unchanged', fromHead: sha('b'), toHead: sha('c'), sourceReportSha256: 'f'.repeat(64), diff: null
  };
  assert.equal(validateMechanicalReport(badIncrement).ok, false);
  const badReportIncrement = structuredClone(built.value);
  badReportIncrement.diff.increment = badIncrement.increment;
  assert.equal(validatePrChangeReport(badReportIncrement).ok, false);
});

test('summary body requires one placeholder and core renders the canonical report', () => {
  const digest = 'd'.repeat(64);
  const built = buildPrChangeReport(identity(), digest, mechanical(), candidate(digest));
  assert.equal(built.ok, true);
  if (built.ok) {
    const rendered = renderCanonicalChangeReport(built.value);
    assert.match(rendered, new RegExp(`^${CANONICAL_REPORT_HEADING}`));
    assert.match(rendered, /\| \*\*合计\*\* \|[^\n]*\n\n#### 功能模块代码增减（行）/u);
    assert.ok(rendered.indexOf('#### 功能模块代码增减（行）') < rendered.indexOf('#### 功能模块与验证变化'));
    assert.ok(rendered.indexOf('#### 功能模块与验证变化') < rendered.indexOf('功能组 summary-content'));
    assert.ok(rendered.indexOf('功能组 summary-content') < rendered.indexOf('#### 代表性变更文件'));
    assert.ok(rendered.indexOf('功能组 summary-content') < rendered.indexOf('#### 适宜性预检'));
    const replaced = replaceCanonicalReportPlaceholder(`## Summary\n\n${CANONICAL_REPORT_PLACEHOLDER}\n`, built.value);
    assert.equal(replaced.ok, true);
    if (replaced.ok) assert.match(replaced.value, /\| \*\*合计\*\* \|/);
    const bypass = replaceCanonicalReportPlaceholder(`\n${CANONICAL_REPORT_PLACEHOLDER}\n${CANONICAL_REPORT_HEADING}`, built.value);
    assert.equal(bypass.ok, false);
  }
});

test('canonical module summary keeps full and report-to-report counts separate and escapes table pipes', () => {
  const fullFiles = withLocations([
    { status: 'M', oldPath: 'lib/report.ts', newPath: 'lib/report.ts', additions: 4, deletions: 2, oldBytes: 20, newBytes: 30, netBytes: 10 },
    { status: 'M', oldPath: 'assets/chart.bin', newPath: 'assets/chart.bin', additions: null, deletions: null, oldBytes: 4, newBytes: 8, netBytes: 4 }
  ]);
  const incrementFiles = withLocations([
    { status: 'M', oldPath: 'lib/report.ts', newPath: 'lib/report.ts', additions: 1, deletions: 3, oldBytes: 30, newBytes: 25, netBytes: -5 },
    { status: 'M', oldPath: 'assets/chart.bin', newPath: 'assets/chart.bin', additions: null, deletions: null, oldBytes: 8, newBytes: 8, netBytes: 0 }
  ]);
  const diff = bundle(sha('b'), sha('c'), fullFiles, {
    files: 2, textFiles: 1, binaryFiles: 1, additions: 4, deletions: 2, oldBytes: 24, newBytes: 38, netBytes: 14
  });
  diff.increment = {
    status: 'available', fromHead: sha('d'), toHead: sha('c'), sourceReportSha256: 'f'.repeat(64),
    diff: { kind: 'head-to-head', from: sha('d'), to: sha('c'), mergeBase: null, patchSha256: 'a'.repeat(64), files: incrementFiles,
      totals: { files: 2, textFiles: 1, binaryFiles: 1, additions: 1, deletions: 3, oldBytes: 38, newBytes: 33, netBytes: -5 } }
  };
  const precheck = candidate('d'.repeat(64), diff);
  const group = precheck.checks.find((check) => check.id === 'change-composition')!.groups![0]!;
  group.id = 'feature|core';
  group.target = 'Target | details';
  const built = buildPrChangeReport(identity(), 'd'.repeat(64), diff, precheck);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /完整 PR：目标分支 merge-base `aaaaaaa` → 当前 HEAD `ccccccc`/u);
  assert.match(rendered, /增量：上一份有效报告 HEAD `ddddddd` → 当前 HEAD `ccccccc` 的直接 head-to-head 差异/u);
  assert.match(rendered, /\| feature&#124;core — Target &#124; details \| 4 \| 2 \| \+2 \| 1 \| 3 \| -2 \| — \|/u);
  assert.match(rendered, /\| \*\*合计（机械统计）\*\* \| 4 \| 2 \| \+2 \| 1 \| 3 \| -2 \| 1 个文件 \/ 1 个文件 \|/u);
  const summaryEnd = rendered.indexOf('| feature&#124;core — Target &#124; details |');
  const detailStart = rendered.indexOf('#### 功能模块与验证变化');
  assert.ok(summaryEnd < detailStart);
  assert.match(rendered.slice(detailStart), /行为变化：Validate and render typed content\./u);
});

test('canonical module summary labels unknown and unchanged increments without inventing counts', () => {
  const unknown = buildPrChangeReport(identity(), 'd'.repeat(64), mechanical(), candidate('d'.repeat(64)));
  assert.equal(unknown.ok, true);
  if (!unknown.ok) return;
  const unknownRendered = renderCanonicalChangeReport(unknown.value);
  assert.match(unknownRendered, /缺少可确认的上一份有效报告 HEAD/u);
  assert.match(unknownRendered, /\| summary-content — Structure managed comment content \| 2 \| 1 \| \+1 \| 未确认 \| 未确认 \| 未确认 \| — \|/u);
  assert.match(unknownRendered, /\| \*\*合计（机械统计）\*\* \| 2 \| 1 \| \+1 \| 未确认 \| 未确认 \| 未确认 \| 0 个文件 \/ 未确认 \|/u);

  const diff = mechanical();
  diff.increment = { status: 'unchanged', fromHead: sha('c'), toHead: sha('c'), sourceReportSha256: null, diff: null };
  const unchanged = buildPrChangeReport(identity(), 'd'.repeat(64), diff, candidate('d'.repeat(64), diff));
  assert.equal(unchanged.ok, true);
  if (!unchanged.ok) return;
  assert.match(renderCanonicalChangeReport(unchanged.value), /\| summary-content — Structure managed comment content \| 2 \| 1 \| \+1 \| 0 \| 0 \| 0 \| — \|/u);
});

test('canonical report renders high-level change categories and all six precheck details', () => {
  const digest = 'd'.repeat(64);
  const value = categorizedMechanical();
  const precheck = detailedCandidate(digest, value);
  precheck.checks[0]!.evidence.push({
    path: 'tests/report-rendering.test.ts', startLine: 22, endLine: 25,
    detail: 'A second source confirms the rendered behavior.'
  });
  const built = buildPrChangeReport(identity(), digest, value, precheck);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /\| 运行时代码 \| 1 \| 4 \| 1 \| \+3 \| 10 \| 13 \| \+3 \| 1 \/ 0 \|/);
  assert.match(rendered, /\| 技能与协作配置 \| 1 \| 0 \| 2 \| -2 \| 10 \| 0 \| -10 \| 1 \/ 0 \|/);
  assert.match(rendered, /\| 文档 \| 1 \| — \| — \| — \| 0 \| 4 \| \+4 \| 0 \/ 1 \|/);
  assert.match(rendered, /\| 其他 \| 1 \| 1 \| 0 \| \+1 \| 0 \| 1 \| \+1 \| 1 \/ 0 \|/);
  assert.match(rendered, /\| \*\*合计\*\* \| 6 \| 10 \| 3 \| \+7 \| 25 \| 45 \| \+20 \| 5 \/ 1 \|/);
  const precheckSection = rendered.split('#### 适宜性预检\n')[1]!;
  assert.match(precheckSection, /^- 结论：\*\*通过\*\*（6\/6 项通过）；继续监控 PR；正式审查：否。/);
  for (const id of PRECHECK_IDS) {
    assert.match(precheckSection, new RegExp(`Rationale-${id}-responsibility-`));
    assert.match(precheckSection, new RegExp(`checks/${id}\\.ts`));
    assert.match(precheckSection, new RegExp(`Evidence-${id}-&lt;detail&gt;`));
  }
  assert.match(precheckSection, /<code>tests\/report-rendering\.test\.ts<\/code>:22-25：A second source confirms the rendered behavior\./);
  assert.ok(
    precheckSection.indexOf('Evidence-target-alignment-&lt;detail&gt;') <
      precheckSection.indexOf('A second source confirms the rendered behavior.')
  );
  assert.equal(rendered, renderCanonicalChangeReport(built.value));
});

test('canonical report escapes precheck paths, rationales, and evidence details', () => {
  const digest = 'd'.repeat(64);
  const precheck = candidate(digest);
  precheck.checks[0] = {
    ...precheck.checks[0]!,
    rationale: 'Rationale <script> & "quote"',
    evidence: [{ path: 'checks/<unsafe>.ts', startLine: 10, endLine: 11, detail: 'Detail <img alt="x"> & \'quote\'' }]
  };
  const built = buildPrChangeReport(identity(), digest, mechanical(), precheck);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /Rationale &lt;script&gt; &amp; &quot;quote&quot;/);
  assert.match(rendered, /<code>checks\/&lt;unsafe&gt;\.ts<\/code>:10-11：Detail &lt;img alt=&quot;x&quot;&gt; &amp; &#39;quote&#39;/);
});

test('canonical report renders nullable evidence line endpoints without null text', () => {
  const digest = 'd'.repeat(64);
  const precheck = candidate(digest);
  precheck.checks[0] = {
    ...precheck.checks[0]!,
    evidence: [{ path: 'checks/no-lines.ts', startLine: null, endLine: null, detail: 'No line location.' }]
  };
  precheck.checks[1] = {
    ...precheck.checks[1]!,
    evidence: [{ path: 'checks/start-only.ts', startLine: 10, endLine: null, detail: 'Start line only.' }]
  };
  precheck.checks[2] = {
    ...precheck.checks[2]!,
    evidence: [{ path: 'checks/end-only.ts', startLine: null, endLine: 12, detail: 'End line only.' }]
  };
  const built = buildPrChangeReport(identity(), digest, mechanical(), precheck);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /<code>checks\/no-lines\.ts<\/code>：No line location\./);
  assert.match(rendered, /<code>checks\/start-only\.ts<\/code>:10：Start line only\./);
  assert.match(rendered, /<code>checks\/end-only\.ts<\/code>:12：End line only\./);
});

test('canonical report lists bounded text representatives with stable tie ordering and classifications', () => {
  const digest = 'd'.repeat(64);
  const diff = representativeMechanical();
  const built = buildPrChangeReport(identity(), digest, diff, candidate(digest, diff));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /#### 代表性变更文件/);
  assert.match(rendered, /- 行数变化最大（仅文本文件，按新增行\+删除行，最多展示 3 个）：\n  - <code>lib\/large\.ts<\/code>（运行时代码）：新增 8 行、删除 4 行，共变更 12 行。\n  - <code>tests\/large\.test\.ts<\/code>（测试与校验）：新增 6 行、删除 6 行，共变更 12 行。\n  - <code>tests\/removed\.test\.ts<\/code>（测试与校验）：新增 0 行、删除 10 行，共变更 10 行。/);
  assert.match(rendered, /- 绝对净字节变化最大（仅文本文件，最多展示 3 个）：\n  - <code>tests\/removed\.test\.ts<\/code>（测试与校验）：净字节 -300，绝对变化 300。\n  - <code>templates\/large\.md<\/code>（模板与生成内容）：净字节 \+90，绝对变化 90。\n  - <code>lib\/large\.ts<\/code>（运行时代码）：净字节 \+10，绝对变化 10。/);
});

test('canonical report renders a text rename as a path change without content labels', () => {
  const digest = 'd'.repeat(64);
  const value = representativeMechanical();
  value.full.files = withLocations([{ status: 'R100', oldPath: 'lib/old.ts', newPath: 'tests/new.test.ts', additions: 0, deletions: 0, oldBytes: 10, newBytes: 10, netBytes: 0 }]);
  value.full.totals = { files: 1, textFiles: 1, binaryFiles: 0, additions: 0, deletions: 0, oldBytes: 10, newBytes: 10, netBytes: 0 };
  const built = buildPrChangeReport(identity(), digest, value, candidate(digest, value));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /- 行数变化最大（仅文本文件，按新增行\+删除行，最多展示 3 个）：\n  - <code>lib\/old\.ts<\/code> → <code>tests\/new\.test\.ts<\/code>（测试与校验）：新增 0 行、删除 0 行，共变更 0 行。/);
  assert.match(rendered, /- 绝对净字节变化最大（仅文本文件，最多展示 3 个）：\n  - <code>lib\/old\.ts<\/code> → <code>tests\/new\.test\.ts<\/code>（测试与校验）：净字节 \+0，绝对变化 0。/);
});

test('canonical report omits binary-only changes from representative summaries', () => {
  const digest = 'd'.repeat(64);
  const value = representativeMechanical();
  value.full.files = withLocations([{ status: 'M', oldPath: 'README.md', newPath: 'README.md', additions: null, deletions: null, oldBytes: 600, newBytes: 300, netBytes: -300 }]);
  value.full.totals = { files: 1, textFiles: 0, binaryFiles: 1, additions: 0, deletions: 0, oldBytes: 600, newBytes: 300, netBytes: -300 };
  const built = buildPrChangeReport(identity(), digest, value, candidate(digest, value));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /- 行数变化最大（仅文本文件，按新增行\+删除行，最多展示 3 个）：\n  - 无可比较的文本文件。/);
  assert.match(rendered, /- 绝对净字节变化最大（仅文本文件，最多展示 3 个）：\n  - 无可比较的文本文件。/);
});

test('typed functional groups derive counts from exact locations and reject overlapping or missing lines', () => {
  const digest = 'd'.repeat(64);
  const diff = representativeMechanical();
  const built = buildPrChangeReport(identity(), digest, diff, candidate(digest, diff));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /功能组 summary-content/u);
  assert.match(rendered, /\| summary-content — Structure managed comment content \| 21 \| 20 \| \+1 \| 未确认 \| 未确认 \| 未确认 \| — \|/u);
  assert.match(rendered, /\| \*\*合计（机械统计）\*\* \| 21 \| 20 \| \+1 \| 未确认 \| 未确认 \| 未确认 \| 1 个文件 \/ 未确认 \|/u);
  assert.match(rendered, /<code>\.agents\/old\.md<\/code> → <code>\.agents\/new\.md<\/code>/u);

  const malformed = candidate(digest, diff);
  const composition = malformed.checks.find((check) => check.id === 'change-composition')!;
  composition.groups![0]!.locations.full.push({ ...composition.groups![0]!.locations.full[0]! });
  const rejected = buildPrChangeReport(identity(), digest, diff, malformed);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error.message, /overlaps or duplicates/u);

  const omitted = candidate(digest, diff);
  omitted.checks.find((check) => check.id === 'change-composition')!.groups![0]!.locations.full.pop();
  const omittedFile = buildPrChangeReport(identity(), digest, diff, omitted);
  assert.equal(omittedFile.ok, false);
  if (!omittedFile.ok) assert.match(omittedFile.error.message, /exactly cover changed lines/u);

  const unknown = candidate(digest, diff);
  unknown.checks.find((check) => check.id === 'change-composition')!.groups![0]!.locations.full[0]!.path = 'src/not-in-diff.ts';
  const unknownFile = buildPrChangeReport(identity(), digest, diff, unknown);
  assert.equal(unknownFile.ok, false);
  if (!unknownFile.ok) assert.match(unknownFile.error.message, /wrong path or direction/u);
});

test('changed positions can split one file across functions and retain shared attribution', () => {
  const digest = 'd'.repeat(64);
  const diff = mechanical();
  const value = candidate(digest, diff);
  const composition = value.checks.find((check) => check.id === 'change-composition')!;
  const first = composition.groups![0]!;
  first.locations.full = [{ path: 'lib/example.ts', side: 'new', startLine: 1, endLine: 1 }];
  first.files = ['lib/example.ts'];
  composition.groups!.push({
    ...first,
    id: 'second-feature', target: 'Another task behavior',
    locations: { full: [{ path: 'lib/example.ts', side: 'old', startLine: 1, endLine: 1 }], increment: [] }
  });
  composition.unassigned!.full = [{ path: 'lib/example.ts', side: 'new', startLine: 2, endLine: 2, reason: 'shared', explanation: 'This added line serves both behaviors.' }];
  const built = buildPrChangeReport(identity(), digest, diff, value);
  assert.equal(built.ok, true);
  if (built.ok) {
    const rendered = renderCanonicalChangeReport(built.value);
    assert.match(rendered, /功能组 summary-content/u);
    assert.match(rendered, /功能组 second-feature/u);
    assert.match(rendered, /\| 未归属（共享） \| 1 \| 0 \| \+1 \| 未确认 \| 未确认 \| 未确认 \| — \|/u);
    assert.match(rendered, /完整 PR 未归属位置说明\*\*：shared：This added line serves both behaviors/u);
  }
});

test('canonical report renders increment-only text, binary, and renamed files', () => {
  const digest = 'd'.repeat(64);
  const diff = mechanical();
  const incrementFiles = withLocations([
    { status: 'D', oldPath: 'src/increment-only.ts', newPath: null, additions: 0, deletions: 2, oldBytes: 12, newBytes: 0, netBytes: -12 },
    { status: 'M', oldPath: 'assets/increment-only.bin', newPath: 'assets/increment-only.bin', additions: null, deletions: null, oldBytes: 4, newBytes: 8, netBytes: 4 },
    { status: 'R100', oldPath: 'docs/old-name.md', newPath: 'docs/new-name.md', additions: 0, deletions: 0, oldBytes: 9, newBytes: 9, netBytes: 0 }
  ]);
  diff.increment = {
    status: 'available', fromHead: sha('d'), toHead: sha('c'), sourceReportSha256: 'f'.repeat(64),
    diff: { kind: 'head-to-head', from: sha('d'), to: sha('c'), mergeBase: null, patchSha256: 'a'.repeat(64), files: incrementFiles,
      totals: { files: 3, textFiles: 2, binaryFiles: 1, additions: 0, deletions: 2, oldBytes: 25, newBytes: 17, netBytes: -8 } }
  };
  const built = buildPrChangeReport(identity(), digest, diff, candidate(digest, diff));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /<code>src\/increment-only\.ts<\/code>/u);
  assert.match(rendered, /<code>assets\/increment-only\.bin<\/code>/u);
  assert.match(rendered, /<code>docs\/old-name\.md<\/code> → <code>docs\/new-name\.md<\/code>/u);
});

test('functional groups reject files that disagree with their allocated locations', () => {
  const digest = 'd'.repeat(64);
  const files = withLocations([
    { status: 'A', oldPath: null, newPath: 'src/added.ts', additions: 1, deletions: 0, oldBytes: 0, newBytes: 4, netBytes: 4 },
    { status: 'D', oldPath: 'src/deleted.ts', newPath: null, additions: 0, deletions: 1, oldBytes: 4, newBytes: 0, netBytes: -4 }
  ]);
  const diff = bundle(sha('b'), sha('c'), files, {
    files: 2, textFiles: 2, binaryFiles: 0, additions: 1, deletions: 1, oldBytes: 4, newBytes: 4, netBytes: 0
  });
  const value = candidate(digest, diff);
  const composition = value.checks.find((check) => check.id === 'change-composition')!;
  const original = composition.groups![0]!;
  composition.groups = [
    { ...original, id: 'added-feature', files: ['src/added.ts'], locations: { full: [{ path: 'src/deleted.ts', side: 'old', startLine: 1, endLine: 1 }], increment: [] } },
    { ...original, id: 'deleted-feature', files: ['src/deleted.ts'], locations: { full: [{ path: 'src/added.ts', side: 'new', startLine: 1, endLine: 1 }], increment: [] } }
  ];
  const built = buildPrChangeReport(identity(), digest, diff, value);
  assert.equal(built.ok, false);
});

test('a text file with every changed line explicitly unassigned need not belong to a functional group', () => {
  const digest = 'd'.repeat(64);
  const files = withLocations([
    { status: 'A', oldPath: null, newPath: 'src/assigned.ts', additions: 1, deletions: 0, oldBytes: 0, newBytes: 4, netBytes: 4 },
    { status: 'D', oldPath: 'src/unassigned.ts', newPath: null, additions: 0, deletions: 1, oldBytes: 4, newBytes: 0, netBytes: -4 }
  ]);
  const diff = bundle(sha('b'), sha('c'), files, {
    files: 2, textFiles: 2, binaryFiles: 0, additions: 1, deletions: 1, oldBytes: 4, newBytes: 4, netBytes: 0
  });
  const value = candidate(digest, diff);
  const composition = value.checks.find((check) => check.id === 'change-composition')!;
  composition.groups![0]!.files = ['src/assigned.ts'];
  composition.groups![0]!.locations = {
    full: [{ path: 'src/assigned.ts', side: 'new', startLine: 1, endLine: 1 }], increment: []
  };
  composition.unassigned!.full = [{
    path: 'src/unassigned.ts', side: 'old', startLine: 1, endLine: 1,
    reason: 'unconfirmed', explanation: 'This file cannot be reliably attributed.'
  }];

  const built = buildPrChangeReport(identity(), digest, diff, value);
  assert.equal(built.ok, true, built.ok ? undefined : JSON.stringify(built.error));
  if (built.ok) {
    const rendered = renderCanonicalChangeReport(built.value);
    assert.match(rendered, /\| 未归属（待确认） \| 0 \| 1 \| -1 \| 未确认 \| 未确认 \| 未确认 \| — \|/u);
    assert.match(rendered, /完整 PR 未归属位置说明\*\*：unconfirmed：This file cannot be reliably attributed/u);
  }
});

test('full and head-to-head allocations remain independently identified and validated', () => {
  const digest = 'd'.repeat(64);
  const diff = mechanical();
  const incrementFiles = withLocations([{ status: 'M', oldPath: 'lib/example.ts', newPath: 'lib/example.ts', additions: 1, deletions: 0, oldBytes: 20, newBytes: 22, netBytes: 2 }]);
  diff.increment = {
    status: 'available', fromHead: sha('d'), toHead: sha('c'), sourceReportSha256: 'f'.repeat(64),
    diff: { kind: 'head-to-head', from: sha('d'), to: sha('c'), mergeBase: null, patchSha256: 'a'.repeat(64), files: incrementFiles,
      totals: { files: 1, textFiles: 1, binaryFiles: 0, additions: 1, deletions: 0, oldBytes: 20, newBytes: 22, netBytes: 2 } }
  };
  const built = buildPrChangeReport(identity(), digest, diff, candidate(digest, diff));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.value.diff.increment.status, 'available');
  assert.equal(built.value.diff.increment.diff?.from, sha('d'));
  assert.equal(built.value.diff.full.totals.additions, 2);
  assert.equal(built.value.diff.increment.diff?.totals.additions, 1);
  assert.equal(validatePrChangeReport(built.value).ok, true);
  const tampered = JSON.parse(JSON.stringify(built.value)) as Record<string, any>;
  tampered.diff.increment.diff.from = sha('e');
  assert.equal(validatePrChangeReport(tampered).ok, false);
});

test('typed group structure requires nested test coverage and rejects hand-entered counts', () => {
  const digest = 'd'.repeat(64);
  const incomplete = JSON.parse(JSON.stringify(candidate(digest))) as Record<string, unknown>;
  const incompleteChecks = incomplete.checks as Array<Record<string, unknown>>;
  const composition = incompleteChecks.find((check) => check.id === 'change-composition')!;
  const groups = composition.groups as Array<Record<string, unknown>>;
  groups[0]!.tests = { coverage: 'Covered.' };
  assert.equal(validatePrecheckCandidate(incomplete).ok, false);

  const withManualCounts = JSON.parse(JSON.stringify(candidate(digest))) as Record<string, unknown>;
  const checks = withManualCounts.checks as Array<Record<string, unknown>>;
  const compositionWithCounts = checks.find((check) => check.id === 'change-composition')!;
  const typedGroups = compositionWithCounts.groups as Array<Record<string, unknown>>;
  typedGroups[0]!.additions = 2;
  assert.equal(validatePrecheckCandidate(withManualCounts).ok, false);
});

test('canonical report summarizes a precheck review route in Chinese', () => {
  const digest = 'd'.repeat(64);
  const precheck = candidate(digest);
  precheck.checks[0] = { ...precheck.checks[0]!, verdict: 'needs-review' };
  const built = buildPrChangeReport(identity(), digest, mechanical(), precheck);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.value.precheck.route, 'review-code');

  const rendered = renderCanonicalChangeReport(built.value);
  const precheckSection = rendered.split('#### 适宜性预检\n')[1]!;
  assert.match(precheckSection, /^- 结论：\*\*需复核\*\*（5 项通过，1 项需复核）；转入代码审查；正式审查：否。/);
  assert.match(precheckSection, /\*\*目标对应（target-alignment）\*\*：需复核。/);
  assert.match(precheckSection, /Matches the approved task scope\./);
});

test('atomic report writes are readable and reject symlink consumption', (t) => {
  const root = createTempDir('pr-change-report-');
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
