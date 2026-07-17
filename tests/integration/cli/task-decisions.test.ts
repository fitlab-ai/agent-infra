import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../../helpers.ts';

const SCRIPT = path.resolve(process.cwd(), '.agents/scripts/task-short-id.js');

const HEADER = '| id | stage | round | severity | status | evidence |';
const SEP = '|----|-------|-------|----------|--------|----------|';

function mkFixture(): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-decisions-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(agentsDir, 'scripts', 'task-short-id.js'));
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  const activeDir = path.join(agentsDir, 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir };
}

// Write task.md with a ledger + a 人工裁决 record, and optional artifact files
// holding `### <ledger-id>` detail blocks.
function writeTask(
  activeDir: string,
  taskId: string,
  ledgerRows: string[],
  opts: { artifacts?: Record<string, string>; decisionHeading?: string; decisionRecords?: string[] } = {}
): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const ledger = `## 审查分歧账本\n\n${HEADER}\n${SEP}\n${ledgerRows.join('\n')}\n`;
  const records = (opts.decisionRecords ?? []).join('\n');
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    `---\nid: ${taskId}\nbranch: feat\n---\n# 任务：${taskId}\n\n${ledger}\n## ${opts.decisionHeading ?? '人工裁决'}\n\n${records}\n\n## 完成检查清单\n\n- [ ] done\n`
  );
  for (const [name, body] of Object.entries(opts.artifacts ?? {})) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

const AN1_BLOCK = '### AN-1：分析边界待裁定 [needs-human-decision]\n\n- **说明**：分析 finding 已升级。\n';
const HD1_BLOCK = '### HD-1：引用入口是否扩展 [needs-human-decision]\n\n- **背景**：是否支持更多入口。\n- **推荐**：(A) 仅三种标准形式。\n';
const PL1_BLOCK = '### PL-1：方案回退范围 [needs-human-decision]\n\n- **说明**：方案 finding 已升级。\n';
const CD1_BLOCK = '### CD-1：实现兼容边界 [needs-human-decision]\n\n- **说明**：代码 finding 已升级。\n';
const HD3_BLOCK = '### HD-3：命令输出格式 [needs-human-decision]\n\n- **背景**：markdown 细节。\n- **推荐**：附锚点文本。\n';

// A canonical fixture spanning pending review findings, executor-raised
// decisions, a decided row, terminal rows, and a post-review exemption.
function writeCanonical(activeDir: string, taskId: string): void {
  writeTask(
    activeDir,
    taskId,
    [
      '| AN-1 | analysis | 2 | minor | needs-human-decision | review-analysis-r2.md#AN-1 |',
      '| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |',
      '| PL-1 | plan | 3 | blocker | needs-human-decision | review-plan-r3.md#PL-1 |',
      '| HD-2 | plan | - | decision | human-decided | task.md#人工裁决 |',
      '| CD-1 | code | 3 | blocker | needs-human-decision | code-r3.md#CD-1 |',
      '| HD-3 | plan | - | decision | needs-human-decision | plan.md#HD-3 |',
      '| AN-2 | analysis | 2 | minor | closed | review-analysis-r2.md#AN-2 |',
      '| PRC-1 | post-review-commit | - | - | human-decided | task.md#PRC-1 |'
    ],
    {
      artifacts: {
        'review-analysis-r2.md': `# 分析审查\n\n${AN1_BLOCK}`,
        'analysis.md': `# 分析\n\n## 人工裁决待办\n\n${HD1_BLOCK}`,
        'review-plan-r3.md': `# 方案审查\n\n${PL1_BLOCK}`,
        'code-r3.md': `# 实现\n\n${CD1_BLOCK}`,
        'plan.md': `# 方案\n\n## 人工裁决待办\n\n${HD3_BLOCK}`
      },
      decisionRecords: ['- 2026-06-29 09:36:59+08:00 — **HD-2**：选择 A，采用独立段。']
    }
  );
}

test('A1: `decisions` and `d` are equivalent', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000001';
  writeCanonical(activeDir, taskId);
  const a = runCli(['task', 'decisions', taskId], repoRoot);
  const b = runCli(['task', 'd', taskId], repoRoot);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(a.stdout, b.stdout);
});

test('A2: resolves bare short id, #N, and full TASK-id; rejects unknown ref', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000002';
  writeCanonical(activeDir, taskId);
  spawnSync('node', [SCRIPT, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });

  const full = runCli(['task', 'd', taskId], repoRoot);
  const bare = runCli(['task', 'd', '1'], repoRoot);
  const hash = runCli(['task', 'd', '#1'], repoRoot);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(bare.stdout, full.stdout);
  assert.equal(hash.stdout, full.stdout);

  const bad = runCli(['task', 'd', 'not-a-task'], repoRoot);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /ai task decisions:/);
});

test('A3: --help exits 0 with usage; no args exits 1 with usage', () => {
  const { repoRoot } = mkFixture();
  const help = runCli(['task', 'd', '--help'], repoRoot);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: ai task decisions/);
  const none = runCli(['task', 'd'], repoRoot);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /Usage: ai task decisions/);
});

test('A4: default list shows pending decision rows from every review stage', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000003';
  writeCanonical(activeDir, taskId);
  const out = runCli(['task', 'd', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /AN-1\s+analysis\s+minor\s+needs-human-decision\s+review-analysis-r2\.md#AN-1/);
  assert.match(out.stdout, /HD-1\s+analysis\s+decision\s+needs-human-decision\s+analysis\.md#HD-1/);
  assert.match(out.stdout, /PL-1\s+plan\s+blocker\s+needs-human-decision\s+review-plan-r3\.md#PL-1/);
  assert.match(out.stdout, /CD-1\s+code\s+blocker\s+needs-human-decision\s+code-r3\.md#CD-1/);
  assert.match(out.stdout, /HD-3\s+plan\s+decision\s+needs-human-decision\s+plan\.md#HD-3/);
  assert.doesNotMatch(out.stdout, /HD-2/);
  assert.doesNotMatch(out.stdout, /AN-2/);
  assert.doesNotMatch(out.stdout, /PRC-1/);
  assert.match(out.stdout, /引用入口是否扩展/);
});

test('A5: empty candidate set prints a notice and exits 0', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000004';
  // Only a decided row -> default (pending) list is empty.
  writeTask(activeDir, taskId, ['| HD-1 | analysis | - | decision | human-decided | task.md#人工裁决 |']);
  const out = runCli(['task', 'd', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /无待裁决项/);
});

test('A6: select a review finding by ordinal and ledger id', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000005';
  writeCanonical(activeDir, taskId);
  const byId = runCli(['task', 'd', taskId, 'PL-1'], repoRoot);
  assert.equal(byId.status, 0, byId.stderr);
  assert.match(byId.stdout, /### PL-1：方案回退范围/);
  const byOrdinal = runCli(['task', 'd', taskId, '3'], repoRoot);
  assert.equal(byOrdinal.status, 0, byOrdinal.stderr);
  assert.match(byOrdinal.stdout, /### PL-1：方案回退范围/);
});

test('A7: --all includes decided rows; --stage filters; --format markdown', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000006';
  writeCanonical(activeDir, taskId);

  const all = runCli(['task', 'd', taskId, '--all'], repoRoot);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /HD-2\s+plan\s+decision\s+human-decided/);
  assert.doesNotMatch(all.stdout, /PRC-1/);

  const stage = runCli(['task', 'd', taskId, '--all', '--stage', 'analysis'], repoRoot);
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /AN-1/);
  assert.match(stage.stdout, /HD-1/);
  assert.doesNotMatch(stage.stdout, /PL-1/);
  assert.doesNotMatch(stage.stdout, /CD-1/);
  assert.doesNotMatch(stage.stdout, /HD-3/);

  const md = runCli(['task', 'd', taskId, '--format', 'markdown'], repoRoot);
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^\| # \| ID \| STAGE \|/m);

  const badStage = runCli(['task', 'd', taskId, '--stage', 'bogus'], repoRoot);
  assert.equal(badStage.status, 1);
  const badFmt = runCli(['task', 'd', taskId, '--format', 'xml'], repoRoot);
  assert.equal(badFmt.status, 1);
});

test('A8: command is read-only (task.md unchanged)', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000007';
  writeCanonical(activeDir, taskId);
  const taskMd = path.join(activeDir, taskId, 'task.md');
  const before = fs.readFileSync(taskMd);
  runCli(['task', 'd', taskId], repoRoot);
  runCli(['task', 'd', taskId, 'PL-1'], repoRoot);
  runCli(['task', 'd', taskId, '3'], repoRoot);
  runCli(['task', 'd', taskId, '--all', '--format', 'markdown'], repoRoot);
  const after = fs.readFileSync(taskMd);
  assert.ok(before.equals(after), 'task.md must not be modified by decisions');
});

test('CD-1: decided detail finds records under the Human Rulings heading', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000010';
  writeTask(activeDir, taskId, ['| HD-2 | plan | - | decision | human-decided | task.md#HDR-1 |'], {
    decisionHeading: 'Human Rulings',
    decisionRecords: ['- **Original Ledger ID**: HD-2']
  });

  const out = runCli(['task', 'd', taskId, '--all', 'HD-2'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /人工裁定：\n- \*\*Original Ledger ID\*\*: HD-2/);
});

test('B3: missing detail block degrades gracefully and exits 0', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000008';
  writeTask(activeDir, taskId, ['| CD-9 | code | 3 | blocker | needs-human-decision | review-code-r3.md#CD-9 |']);
  const out = runCli(['task', 'd', taskId, 'CD-9'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /详情块未找到/);
});

test('PL-2: duplicate ledger id errors on id select but works by ordinal', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000009';
  writeTask(activeDir, taskId, [
    '| PL-1 | plan | 2 | major | needs-human-decision | plan-r2.md#PL-1 |',
    '| PL-1 | plan | 3 | blocker | needs-human-decision | plan-r3.md#PL-1 |'
  ]);
  const byId = runCli(['task', 'd', taskId, 'PL-1'], repoRoot);
  assert.equal(byId.status, 1);
  assert.match(byId.stderr, /duplicate id/);
  const byOrdinal = runCli(['task', 'd', taskId, '2'], repoRoot);
  assert.equal(byOrdinal.status, 0, byOrdinal.stderr);
  assert.match(byOrdinal.stdout, /PL-1 \(plan\/blocker\)/);
});
