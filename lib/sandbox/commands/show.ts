import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { SandboxConfig } from '../config.ts';
import { loadConfig } from '../config.ts';
import { assertValidBranchName, worktreeDirCandidates } from '../constants.ts';
import { resolveBranchArg } from './list-running.ts';
import { resolveTools, toolConfigDirCandidates } from '../tools.ts';

const USAGE = `Usage: ai sandbox show <branch | TASK-id | N | '#N'>

Shows one sandbox's worktree path and per-tool state paths (Claude Code,
Codex, Gemini CLI, OpenCode). The argument follows the same contract as
'ai sandbox exec' and 'ai sandbox start': N (bare) is the recommended form
for task short ids (e.g. 'ai sandbox show 11'); '#N', a TASK-id, or a plain
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
  const branch = resolveBranchArg(args[0]!, { repoRoot: config.repoRoot });
  assertValidBranchName(branch);

  const detail = collectSandboxDetail(config, branch);

  p.intro(pc.cyan(`Sandbox detail for ${config.project} · ${branch}`));

  p.log.step('Worktree');
  if (detail.worktrees.length === 0) {
    p.log.warn('  No worktree for this branch');
  } else {
    for (const worktree of detail.worktrees) {
      process.stdout.write(`  ${worktree}\n`);
    }
  }

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
