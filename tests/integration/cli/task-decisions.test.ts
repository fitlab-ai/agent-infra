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
// holding `### HD-N` detail blocks.
function writeTask(
  activeDir: string,
  taskId: string,
  ledgerRows: string[],
  opts: { artifacts?: Record<string, string>; decisionRecords?: string[] } = {}
): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const ledger = `## 审查分歧账本\n\n${HEADER}\n${SEP}\n${ledgerRows.join('\n')}\n`;
  const records = (opts.decisionRecords ?? []).join('\n');
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    `---\nid: ${taskId}\nbranch: feat\n---\n# 任务：${taskId}\n\n${ledger}\n## 人工裁决\n\n${records}\n\n## 完成检查清单\n\n- [ ] done\n`
  );
  for (const [name, body] of Object.entries(opts.artifacts ?? {})) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

function runCli(args: string[], cwd: string) {
  return spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8' });
}

const HD1_BLOCK = '### HD-1：引用入口是否扩展 [needs-human-decision]\n\n- **背景**：是否支持更多入口。\n- **推荐**：(A) 仅三种标准形式。\n';
const HD3_BLOCK = '### HD-3：命令输出格式 [needs-human-decision]\n\n- **背景**：markdown 细节。\n- **推荐**：附锚点文本。\n';

// A canonical fixture: HD-1 pending (analysis, has detail block in analysis.md),
// HD-2 decided (plan), HD-3 pending (plan, detail block in plan.md), plus a
// closed non-HD finding that must never appear in decisions output.
function writeCanonical(activeDir: string, taskId: string): void {
  writeTask(
    activeDir,
    taskId,
    [
      '| AN-1 | analysis | 2 | blocker | closed | review-analysis-r2.md#AN-1 |',
      '| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |',
      '| HD-2 | plan | - | decision | human-decided | task.md#人工裁决 |',
      '| HD-3 | plan | - | decision | needs-human-decision | plan.md#HD-3 |'
    ],
    {
      artifacts: {
        'analysis.md': `# 分析\n\n## 人工裁决待办\n\n${HD1_BLOCK}`,
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

test('A4: default list shows pending HD rows with id/stage/severity/status/evidence/title', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000003';
  writeCanonical(activeDir, taskId);
  const out = runCli(['task', 'd', taskId], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  // Pending rows only (HD-1, HD-3); decided HD-2 and non-HD AN-1 excluded.
  assert.match(out.stdout, /HD-1\s+analysis\s+decision\s+needs-human-decision\s+analysis\.md#HD-1/);
  assert.match(out.stdout, /HD-3\s+plan\s+decision\s+needs-human-decision\s+plan\.md#HD-3/);
  assert.doesNotMatch(out.stdout, /HD-2/);
  assert.doesNotMatch(out.stdout, /AN-1/);
  // Title comes from the `### HD-N` heading.
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

test('A6: select a single item by ordinal and by HD id', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000005';
  writeCanonical(activeDir, taskId);
  const byId = runCli(['task', 'd', taskId, 'HD-1'], repoRoot);
  assert.equal(byId.status, 0, byId.stderr);
  assert.match(byId.stdout, /### HD-1：引用入口是否扩展/);
  assert.match(byId.stdout, /推荐.*仅三种标准形式/);
  // Ordinal 1 selects the first pending row (HD-1) -> same detail block.
  const byOrdinal = runCli(['task', 'd', taskId, '1'], repoRoot);
  assert.equal(byOrdinal.status, 0, byOrdinal.stderr);
  assert.match(byOrdinal.stdout, /### HD-1：引用入口是否扩展/);
});

test('A7: --all includes decided rows; --stage filters; --format markdown', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000006';
  writeCanonical(activeDir, taskId);

  const all = runCli(['task', 'd', taskId, '--all'], repoRoot);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /HD-2\s+plan\s+decision\s+human-decided/);

  const stage = runCli(['task', 'd', taskId, '--all', '--stage', 'analysis'], repoRoot);
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /HD-1/);
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
  runCli(['task', 'd', taskId, 'HD-1'], repoRoot);
  runCli(['task', 'd', taskId, '--all', '--format', 'markdown'], repoRoot);
  const after = fs.readFileSync(taskMd);
  assert.ok(before.equals(after), 'task.md must not be modified by decisions');
});

test('B3: missing detail block degrades gracefully and exits 0', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000008';
  // HD-1 references analysis.md#HD-1 but no artifact holds the block.
  writeTask(activeDir, taskId, ['| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |']);
  const out = runCli(['task', 'd', taskId, 'HD-1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /详情块未找到/);
});

test('PL-2: duplicate HD id errors on id select but works by ordinal', () => {
  const { repoRoot, activeDir } = mkFixture();
  const taskId = 'TASK-20260101-000009';
  // Two rows sharing id HD-1 (a legacy collision the global allocator prevents).
  writeTask(activeDir, taskId, [
    '| HD-1 | analysis | - | decision | needs-human-decision | analysis.md#HD-1 |',
    '| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |'
  ]);
  const byId = runCli(['task', 'd', taskId, 'HD-1'], repoRoot);
  assert.equal(byId.status, 1);
  assert.match(byId.stderr, /duplicate id/);
  const byOrdinal = runCli(['task', 'd', taskId, '2'], repoRoot);
  assert.equal(byOrdinal.status, 0, byOrdinal.stderr);
  assert.match(byOrdinal.stdout, /HD-1 \(plan\/decision\)/);
});
