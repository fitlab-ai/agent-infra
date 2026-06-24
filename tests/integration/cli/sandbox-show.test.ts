import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH, cliArgs, gitSafeEnv, loadFreshEsm } from '../../helpers.ts';
import { worktreeDirCandidates } from '../../../lib/sandbox/constants.ts';
import { resolveTools, toolConfigDirCandidates } from '../../../lib/sandbox/tools.ts';
import type { SandboxConfig } from '../../../lib/sandbox/config.ts';

type ShowModule = typeof import('../../../lib/sandbox/commands/show.ts');

const BUILTIN_TOOL_IDS = ['claude-code', 'codex', 'gemini-cli', 'opencode'];

function makeConfig(home: string): SandboxConfig {
  return {
    home,
    project: 'demo',
    tools: BUILTIN_TOOL_IDS,
    worktreeBase: path.join(home, '.agent-infra', 'worktrees', 'demo')
  } as unknown as SandboxConfig;
}

test('collectSandboxDetail collects existing worktree and per-tool state dirs', async () => {
  const { collectSandboxDetail } = await loadFreshEsm<ShowModule>('lib/sandbox/commands/show.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-show-detail-'));
  const config = makeConfig(home);
  const branch = 'feature/show';

  const worktreePath = worktreeDirCandidates(config, branch)[0]!;
  fs.mkdirSync(worktreePath, { recursive: true });
  const claude = resolveTools(config).find((tool) => tool.name === 'Claude Code')!;
  const claudeStatePath = toolConfigDirCandidates(claude, config.project, branch)[0]!;
  fs.mkdirSync(claudeStatePath, { recursive: true });

  const detail = collectSandboxDetail(config, branch);

  assert.deepEqual(detail.worktrees, [worktreePath]);
  assert.equal(detail.toolStates.length, BUILTIN_TOOL_IDS.length);
  const claudeState = detail.toolStates.find((tool) => tool.name === 'Claude Code')!;
  assert.deepEqual(claudeState.entries, [claudeStatePath]);
  const codexState = detail.toolStates.find((tool) => tool.name === 'Codex')!;
  assert.deepEqual(codexState.entries, [], 'a tool with no state dir reports no entries');
});

test('collectSandboxDetail returns empty results when nothing exists for the branch', async () => {
  const { collectSandboxDetail } = await loadFreshEsm<ShowModule>('lib/sandbox/commands/show.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-show-empty-'));
  const config = makeConfig(home);

  const detail = collectSandboxDetail(config, 'feature/empty');

  assert.deepEqual(detail.worktrees, []);
  assert.equal(detail.toolStates.length, BUILTIN_TOOL_IDS.length);
  for (const tool of detail.toolStates) {
    assert.deepEqual(tool.entries, [], `${tool.name} should have no entries`);
  }
});

test('collectSandboxDetail covers the legacy (dash) sanitize candidate', async () => {
  const { collectSandboxDetail } = await loadFreshEsm<ShowModule>('lib/sandbox/commands/show.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-show-legacy-'));
  const config = makeConfig(home);
  const branch = 'feature/legacy';

  // candidates[0] is the current 'feature..legacy' form; candidates[1] is the
  // legacy 'feature-legacy' form. Create only the legacy dir to prove the
  // *Candidates helper still surfaces historical directories.
  const candidates = worktreeDirCandidates(config, branch);
  assert.ok(candidates.length >= 2, 'a slashed branch yields both sanitize candidates');
  const legacyPath = candidates[1]!;
  fs.mkdirSync(legacyPath, { recursive: true });

  const detail = collectSandboxDetail(config, branch);

  assert.deepEqual(detail.worktrees, [legacyPath]);
});

function mkCliFixture(): { repoRoot: string; activeDir: string; scriptPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-show-cli-'));
  spawnSync('git', ['init', '--quiet'], { cwd: repoRoot });
  const agentsDir = path.join(repoRoot, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'scripts'), { recursive: true });
  const scriptPath = path.join(agentsDir, 'scripts', 'task-short-id.js');
  fs.copyFileSync(path.resolve(process.cwd(), '.agents/scripts/task-short-id.js'), scriptPath);
  fs.writeFileSync(
    path.join(agentsDir, '.airc.json'),
    JSON.stringify({ project: 'demo', task: { shortIdLength: 2 } })
  );
  const activeDir = path.join(agentsDir, 'workspace', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir, scriptPath };
}

function runShow(args: string[], repoRoot: string) {
  return spawnSync('node', cliArgs('sandbox', 'show', ...args), {
    cwd: repoRoot,
    env: gitSafeEnv({ HOME: repoRoot, USERPROFILE: repoRoot }),
    encoding: 'utf8'
  });
}

test('ai sandbox show requires an argument', () => {
  const { repoRoot } = mkCliFixture();
  const out = runShow([], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /Usage: ai sandbox show/);
});

test('ai sandbox show --help prints usage and exits 0', () => {
  const { repoRoot } = mkCliFixture();
  const out = runShow(['--help'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Usage: ai sandbox show/);
});

test('ai sandbox show <branch> resolves a plain branch name and renders detail', () => {
  const { repoRoot } = mkCliFixture();
  const out = runShow(['feature-plain'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  const combined = `${out.stdout}\n${out.stderr}`;
  assert.match(combined, /Sandbox detail for demo .* feature-plain/);
  assert.match(combined, /No worktree for this branch/);
});

test('ai sandbox show <bare-numeric> resolves the branch via the short-id registry', () => {
  const { repoRoot, activeDir, scriptPath } = mkCliFixture();
  const taskId = 'TASK-20260101-000007';
  fs.mkdirSync(path.join(activeDir, taskId), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, taskId, 'task.md'),
    `---\nid: ${taskId}\nbranch: feature-bound\n---\n# body\n`
  );
  const alloc = spawnSync('node', [scriptPath, 'alloc', taskId], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(alloc.status, 0, alloc.stderr);
  assert.equal(alloc.stdout.trim(), '#01');

  const out = runShow(['1'], repoRoot);
  assert.equal(out.status, 0, out.stderr);
  assert.match(`${out.stdout}\n${out.stderr}`, /Sandbox detail for demo .* feature-bound/);
});

test('ai sandbox show <unknown short id> fails with an actionable registry error', () => {
  const { repoRoot } = mkCliFixture();
  const out = runShow(['99'], repoRoot);
  assert.notEqual(out.status, 0);
  assert.match(`${out.stdout}\n${out.stderr}`, /registry/);
});
