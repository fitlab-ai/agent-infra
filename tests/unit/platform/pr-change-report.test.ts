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

function detailedCandidate(taskIntentSha256: string): PrecheckCandidate {
  return {
    taskIntentSha256,
    checks: PRECHECK_IDS.map((id, index) => ({
      id,
      verdict: 'pass' as const,
      evidence: [{
        path: `checks/${id}.ts`, startLine: index + 10, endLine: index + 11,
        detail: `Evidence-${id}-<detail>`
      }],
      rationale: `Rationale-${id}-responsibility-${index}`
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

function categorizedMechanical(base = sha('b'), head = sha('c')): MechanicalChangeReport {
  const files = [
    { status: 'M', oldPath: 'lib/example.ts', newPath: 'lib/example.ts', additions: 4, deletions: 1, oldBytes: 10, newBytes: 13, netBytes: 3 },
    { status: 'M', oldPath: 'tests/example.test.ts', newPath: 'tests/example.test.ts', additions: 2, deletions: 0, oldBytes: 5, newBytes: 7, netBytes: 2 },
    { status: 'A', oldPath: null, newPath: 'templates/example.md', additions: 3, deletions: 0, oldBytes: 0, newBytes: 20, netBytes: 20 },
    { status: 'D', oldPath: '.agents/example.md', newPath: null, additions: 0, deletions: 2, oldBytes: 10, newBytes: 0, netBytes: -10 },
    { status: 'M', oldPath: 'README.md', newPath: 'README.md', additions: null, deletions: null, oldBytes: 0, newBytes: 4, netBytes: 4 }
  ];
  return {
    version: 1,
    base,
    head,
    mergeBase: sha('a'),
    patchSha256: 'e'.repeat(64),
    files,
    totals: {
      files: 5, textFiles: 4, binaryFiles: 1, additions: 9, deletions: 3,
      oldBytes: 25, newBytes: 44, netBytes: 19
    }
  };
}

function representativeMechanical(base = sha('b'), head = sha('c')): MechanicalChangeReport {
  const files = [
    { status: 'M', oldPath: 'lib/large.ts', newPath: 'lib/large.ts', additions: 8, deletions: 4, oldBytes: 100, newBytes: 110, netBytes: 10 },
    { status: 'M', oldPath: 'tests/large.test.ts', newPath: 'tests/large.test.ts', additions: 6, deletions: 6, oldBytes: 20, newBytes: 20, netBytes: 0 },
    { status: 'A', oldPath: null, newPath: 'templates/large.md', additions: 7, deletions: 0, oldBytes: 0, newBytes: 90, netBytes: 90 },
    { status: 'R100', oldPath: '.agents/old.md', newPath: '.agents/new.md', additions: 0, deletions: 0, oldBytes: 300, newBytes: 300, netBytes: 0 },
    { status: 'M', oldPath: 'README.md', newPath: 'README.md', additions: null, deletions: null, oldBytes: 600, newBytes: 300, netBytes: -300 },
    { status: 'D', oldPath: 'tests/removed.test.ts', newPath: null, additions: 0, deletions: 10, oldBytes: 300, newBytes: 0, netBytes: -300 }
  ];
  return {
    version: 1,
    base,
    head,
    mergeBase: sha('a'),
    patchSha256: 'e'.repeat(64),
    files,
    totals: {
      files: 6, textFiles: 5, binaryFiles: 1, additions: 21, deletions: 20,
      oldBytes: 1320, newBytes: 820, netBytes: -500
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

test('canonical report renders high-level change categories and all six precheck details', () => {
  const digest = 'd'.repeat(64);
  const value = categorizedMechanical();
  const built = buildPrChangeReport(identity(), digest, value, detailedCandidate(digest));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /\| 运行时代码 \| 1 \| 4 \| 1 \| \+3 \| 10 \| 13 \| \+3 \| 1 \/ 0 \|/);
  assert.match(rendered, /\| 技能与协作配置 \| 1 \| 0 \| 2 \| -2 \| 10 \| 0 \| -10 \| 1 \/ 0 \|/);
  assert.match(rendered, /\| 文档与其他 \| 1 \| — \| — \| — \| 0 \| 4 \| \+4 \| 0 \/ 1 \|/);
  assert.match(rendered, /\| \*\*合计\*\* \| 5 \| 9 \| 3 \| \+6 \| 25 \| 44 \| \+19 \| 4 \/ 1 \|/);
  const precheckSection = rendered.split('#### 适宜性预检\n')[1]!;
  assert.match(precheckSection, /^- 结论：\*\*通过\*\*（6\/6 项通过）；继续监控 PR；正式审查：否。/);
  for (const id of PRECHECK_IDS) {
    assert.match(precheckSection, new RegExp(`Rationale-${id}-responsibility-`));
    assert.match(precheckSection, new RegExp(`checks/${id}\\.ts`));
    assert.match(precheckSection, new RegExp(`Evidence-${id}-&lt;detail&gt;`));
  }
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
  assert.doesNotMatch(rendered, /<script>|<img/);
});

test('canonical report lists bounded text representatives with stable tie ordering and classifications', () => {
  const digest = 'd'.repeat(64);
  const built = buildPrChangeReport(identity(), digest, representativeMechanical(), candidate(digest));
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
  value.files = [{ status: 'R100', oldPath: 'lib/old.ts', newPath: 'tests/new.test.ts', additions: 0, deletions: 0, oldBytes: 10, newBytes: 10, netBytes: 0 }];
  value.totals = { files: 1, textFiles: 1, binaryFiles: 0, additions: 0, deletions: 0, oldBytes: 10, newBytes: 10, netBytes: 0 };
  const built = buildPrChangeReport(identity(), digest, value, candidate(digest));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /- 行数变化最大（仅文本文件，按新增行\+删除行，最多展示 3 个）：\n  - <code>lib\/old\.ts<\/code> → <code>tests\/new\.test\.ts<\/code>（测试与校验）：新增 0 行、删除 0 行，共变更 0 行。/);
  assert.match(rendered, /- 绝对净字节变化最大（仅文本文件，最多展示 3 个）：\n  - <code>lib\/old\.ts<\/code> → <code>tests\/new\.test\.ts<\/code>（测试与校验）：净字节 \+0，绝对变化 0。/);
});

test('canonical report omits binary-only changes from representative summaries', () => {
  const digest = 'd'.repeat(64);
  const value = representativeMechanical();
  value.files = [{ status: 'M', oldPath: 'README.md', newPath: 'README.md', additions: null, deletions: null, oldBytes: 600, newBytes: 300, netBytes: -300 }];
  value.totals = { files: 1, textFiles: 0, binaryFiles: 1, additions: 0, deletions: 0, oldBytes: 600, newBytes: 300, netBytes: -300 };
  const built = buildPrChangeReport(identity(), digest, value, candidate(digest));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  assert.match(rendered, /- 行数变化最大（仅文本文件，按新增行\+删除行，最多展示 3 个）：\n  - 无可比较的文本文件。/);
  assert.match(rendered, /- 绝对净字节变化最大（仅文本文件，最多展示 3 个）：\n  - 无可比较的文本文件。/);
});

test('canonical report summarizes a precheck review route in Chinese', () => {
  const digest = 'd'.repeat(64);
  const precheck = candidate(digest);
  precheck.checks[0] = { ...precheck.checks[0]!, verdict: 'needs-review' };
  const built = buildPrChangeReport(identity(), digest, mechanical(), precheck);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const rendered = renderCanonicalChangeReport(built.value);
  const precheckSection = rendered.split('#### 适宜性预检\n')[1]!;
  assert.match(precheckSection, /^- 结论：\*\*需复核\*\*（5 项通过，1 项需复核）；转入代码审查；正式审查：否。/);
  assert.match(precheckSection, /\*\*目标对应（target-alignment）\*\*：需复核。/);
  assert.match(precheckSection, /Matches the approved task scope\./);
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
