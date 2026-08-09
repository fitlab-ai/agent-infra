import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { SandboxConfig } from '../config.ts';
import { loadConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel,
  worktreeDirCandidates
} from '../constants.ts';
import { fetchSandboxRows, selectSandboxContainer } from './list-running.ts';
import { resolveTools, toolConfigDirCandidates } from '../tools.ts';
import { detectEngine } from '../engine.ts';
import { resolveSandboxTarget } from '../workspace-identity.ts';

const USAGE = `Usage: ai sandbox show <branch | TASK-id | N>

Shows one sandbox's worktree path and per-tool state paths (Claude Code,
Codex, Antigravity CLI, OpenCode). The argument follows the same contract as
'ai sandbox exec' and 'ai sandbox start': N (bare) is the recommended form
for task short ids (e.g. 'ai sandbox show 11'); a TASK-id or a plain
branch name are also accepted. Use 'ai sandbox ls' for the container list.`;

export type SandboxDetail = {
  worktrees: string[];
  toolStates: { name: string; entries: string[] }[];
};

function existingDirs(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate) && fs.existsSync(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export function collectSandboxDetail(config: SandboxConfig, branch: string): SandboxDetail {
  const worktrees = existingDirs(worktreeDirCandidates(config, branch));
  const toolStates = resolveTools(config).map((tool) => ({
    name: tool.name,
    entries: existingDirs(toolConfigDirCandidates(tool, config.project, branch))
  }));
  return { worktrees, toolStates };
}

export function show(args: string[] = []): void {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    if (args.length === 0) {
      process.exitCode = 1;
    }
    return;
  }

  const config = loadConfig();
  const target = resolveSandboxTarget(args[0]!, config.repoRoot);
  const branch = target.branch;
  assertValidBranchName(branch);

  const detail = collectSandboxDetail(config, branch);
  const engine = detectEngine(config);
  const rows = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config),
    { mode: sandboxWorkspaceModeLabel(config), taskId: sandboxTaskIdLabel(config) }
  );
  const container = selectSandboxContainer(
    [...rows.running, ...rows.nonRunning],
    containerNameCandidates(config, branch)
  );

  p.intro(pc.cyan(`Sandbox detail for ${config.project} · ${branch}`));

  p.log.step('Worktree');
  if (detail.worktrees.length === 0) {
    p.log.warn('  No worktree for this branch');
  } else {
    for (const worktree of detail.worktrees) {
      process.stdout.write(`  ${worktree}\n`);
    }
  }

  p.log.step('Workspace identity');
  process.stdout.write(`  Mode: ${container?.workspaceMode ?? 'legacy-invalid'}\n`);
  process.stdout.write(`  Task: ${container?.taskId ?? '-'}\n`);

  for (const tool of detail.toolStates) {
    p.log.step(`${tool.name} state`);
    if (tool.entries.length === 0) {
      p.log.warn(`  No ${tool.name} sandbox state`);
      continue;
    }
    for (const entry of tool.entries) {
      process.stdout.write(`  ${entry}\n`);
    }
  }
}
