import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import type { SandboxConfig } from '../config.ts';
import {
  assertValidBranchName,
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel,
  shareBranchDir,
  shellConfigDirCandidates,
  worktreeDirCandidates
} from '../constants.ts';
import { ENGINES, detectEngine, engineDisplayName, isManagedEngine, stopManagedVm } from '../engine.ts';
import { pruneSandboxDanglingImages } from '../image-prune.ts';
import { assertManagedPath, removeManagedDir, removeWorktreeDir } from '../managed-fs.ts';
import { run, runEngine, runOk, runOkEngine, runSafe, runSafeEngine } from '../shell.ts';
import {
  parseSandboxWorkspaceIdentity,
  resolveSandboxCleanupTarget,
  sameSandboxWorkspaceIdentity,
  type SandboxCleanupTarget,
  type SandboxWorkspaceKey
} from '../workspace-identity.ts';
import { sandboxControlPaths, sandboxWorkspaceViewPaths } from '../workspace-view.ts';
import {
  SANDBOX_REMOVAL_JOURNAL_PHASES,
  advanceSandboxRemovalJournalPhase,
  claimSandboxRemovalJournal,
  clearSandboxRemovalJournalRecord,
  listSandboxRemovalJournals,
  removeSandboxControlRoot,
  readSandboxControlManifest,
  sandboxRemovalPhaseIndex,
  type SandboxRemovalJournal,
  type SandboxRemovalTargetCommit
} from '../control/lifecycle.ts';
import { inspectSandboxControlContainer } from '../control/container-identity.ts';
import { commandForSandboxAuthority } from '../engines/authority.ts';
import { acquireSandboxResourceLock, type SandboxResourceLock } from '../control/native-file-lock.ts';
import { toolConfigDirCandidates, toolProjectDirCandidates } from '../tools.ts';
import { createSandboxCapabilityPlan } from '../agent-client-reconciler.ts';
import type { SandboxTool } from '../tools.ts';
import { fetchSandboxRows, type SandboxRow } from './list-running.ts';
import {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectRecoveredWorktree,
  inspectWorktrees,
  verifyWorktreePermit
} from '../worktree-safety.ts';
import type {
  WorktreeInspection,
  WorktreeRecoveryContext,
  WorktreeRemovalPermit
} from '../worktree-safety.ts';

const USAGE = `Usage:
  ai sandbox rm <branch | TASK-id | short id> Remove one sandbox; use a full TASK-id for a task-bound sandbox and a branch for branch-only sandboxes
  ai sandbox rm --unbound [--dry-run] [--yes] Remove completed task-bound and branch-only sandboxes; active, blocked, and archive tasks are protected
  ai sandbox rm --purge                     Tear down ALL sandboxes for the project (containers, worktrees, image, VM)`;
export { assertManagedPath } from '../managed-fs.ts';

function projectToolDirs(config: SandboxConfig, tools: SandboxTool[]): string[] {
  return tools.flatMap((tool) => toolProjectDirCandidates(tool, config.project));
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT');
}

function digestCleanupValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function removalTargetDigest(config: SandboxConfig, target: RmTarget): string {
  return digestCleanupValue({
    project: config.project,
    branch: target.effectiveBranch,
    workspace: target.workspace,
    controlRoots: target.controlRoots.map((candidate) => path.resolve(candidate)),
    workspaceViewRoots: target.workspaceViewRoots.map((candidate) => path.resolve(candidate)),
    managedPathCandidates: (target.managedPathCandidates ?? []).map((candidate) => path.resolve(candidate)).sort()
  });
}

function removalPermitDigest(permits: ReadonlyMap<string, WorktreeRemovalPermit>): string {
  return digestCleanupValue([...permits.entries()]
    .map(([worktree, permit]) => [path.resolve(worktree), permit.mode, permit.snapshot.identity])
    .sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function removalPermitCommits(permits: ReadonlyMap<string, WorktreeRemovalPermit>): SandboxRemovalTargetCommit['permits'] {
  return [...permits.entries()]
    .map(([worktree, permit]) => ({
      path: path.resolve(worktree),
      mode: permit.mode,
      snapshot: permit.snapshot
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function removalTargetCommit(
  config: SandboxConfig,
  target: RmTarget,
  permits: ReadonlyMap<string, WorktreeRemovalPermit>,
  removeWorktree: boolean,
  removeBranch: boolean,
  removeShare: boolean
): SandboxRemovalTargetCommit {
  return {
    branch: target.effectiveBranch,
    project: config.project,
    controlRoot: path.resolve(target.controlRoots[0] ?? path.join(config.controlBase, config.project)),
    targetDigest: removalTargetDigest(config, target),
    permitDigest: removalPermitDigest(permits),
    removeWorktree,
    removeBranch,
    removeShare,
    worktreePaths: target.existingWorktrees.map((candidate) => path.resolve(candidate)).sort(),
    workspaceViewPaths: target.workspaceViewRoots.map((candidate) => path.resolve(candidate)).sort(),
    toolPaths: target.toolCandidates.flatMap(({ candidates }) => candidates.map((candidate) => path.resolve(candidate))).sort(),
    shellPaths: shellConfigDirCandidates(config, target.effectiveBranch).map((candidate) => path.resolve(candidate)).sort(),
    sharePath: path.resolve(shareBranchDir(config, target.effectiveBranch)),
    permits: removalPermitCommits(permits)
  };
}

function assertRemovalSelectionMatches(
  expected: SandboxRemovalTargetCommit,
  actual: SandboxRemovalTargetCommit
): void {
  const normalize = (value: SandboxRemovalTargetCommit): unknown => ({
    ...value,
    controlRoot: '',
    permits: value.permits
  });
  if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))) {
    throw new Error('SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH');
  }
}

function advanceRemovalJournals(
  project: string,
  target: RmTarget,
  targetDigest: string,
  phase: SandboxRemovalJournal['phase'],
  resourceLocks: ReadonlyMap<string, SandboxResourceLock>
): SandboxRemovalJournal[] {
  const targetIndex = sandboxRemovalPhaseIndex(phase);
  return listSandboxRemovalJournals({
    branch: target.effectiveBranch,
    project,
    targetDigest
  }).map((journal) => {
    let current = journal;
    while (sandboxRemovalPhaseIndex(current.phase) < targetIndex) {
      if (current.phase === 'target-committed' && phase === 'container-absent') {
        const lock = resourceLocks.get(current.target.controlRoot);
        if (!lock) throw new Error('SANDBOX_CONTROL_REMOVAL_LOCK_MISMATCH');
        current = advanceSandboxRemovalJournalPhase(current, phase, { resourceLock: lock });
        continue;
      }
      const next = SANDBOX_REMOVAL_JOURNAL_PHASES[sandboxRemovalPhaseIndex(current.phase) + 1];
      if (!next) throw new Error('SANDBOX_CONTROL_REMOVAL_PHASE_TRANSITION_INVALID');
      const lock = resourceLocks.get(current.target.controlRoot);
      if (!lock) throw new Error('SANDBOX_CONTROL_REMOVAL_LOCK_MISMATCH');
      current = advanceSandboxRemovalJournalPhase(current, next, { resourceLock: lock });
    }
    return current;
  });
}

function prepareRemovalAction(
  project: string,
  target: RmTarget,
  targetDigest: string,
  startPhase: SandboxRemovalJournal['phase'],
  completedPhase: SandboxRemovalJournal['phase'],
  resourceLocks: ReadonlyMap<string, SandboxResourceLock>
): RemovalActionPreparation {
  const journals = listSandboxRemovalJournals({
    branch: target.effectiveBranch,
    project,
    targetDigest
  });
  const startIndex = sandboxRemovalPhaseIndex(startPhase);
  const completedIndex = sandboxRemovalPhaseIndex(completedPhase);
  const shouldRun = journals.length === 0
    || journals.some((journal) => sandboxRemovalPhaseIndex(journal.phase) < completedIndex);
  const recovering = journals.some((journal) => {
    const index = sandboxRemovalPhaseIndex(journal.phase);
    return index >= startIndex && index < completedIndex;
  });
  advanceRemovalJournals(project, target, targetDigest, startPhase, resourceLocks);
  return { run: shouldRun, recovering };
}

function assertRemovalPathsAbsent(paths: readonly string[]): void {
  const remaining = paths.filter((candidate) => fs.existsSync(candidate));
  if (remaining.length > 0) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${remaining[0]}`);
  }
}

function assertBranchRemovalIdentity(
  config: SandboxConfig,
  branch: string,
  permits: ReadonlyMap<string, WorktreeRemovalPermit>
): void {
  if (!runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', `refs/heads/${branch}`])) return;
  const expectedHeads = new Set(
    [...permits.values()]
      .filter((permit) => permit.snapshot.branch === branch)
      .map((permit) => permit.snapshot.head)
  );
  if (expectedHeads.size === 0) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
  const actualHead = runSafe('git', ['-C', config.repoRoot, 'rev-parse', `refs/heads/${branch}`]);
  if (!expectedHeads.has(actualHead)) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
}

function removalTombstonePath(targetDigest: string, kind: RemovalActionKind, source: string): string {
  const sourceDigest = createHash('sha256')
    .update(`${kind}\0${path.resolve(source)}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(
    path.dirname(path.resolve(source)),
    `.agent-infra-removal-${targetDigest.slice(0, 16)}-${kind}-${sourceDigest}`
  );
}

type RemovalTombstoneOwnership = Readonly<{
  version: 1;
  targetDigest: string;
  permitDigest: string;
  kind: RemovalActionKind;
  source: string;
}>;

const REMOVAL_TOMBSTONE_MARKER = '.agent-infra-removal-ownership.json';
const REMOVAL_TOMBSTONE_PAYLOAD = 'payload';

function removalTombstonePayload(tombstone: string): string {
  return path.join(tombstone, REMOVAL_TOMBSTONE_PAYLOAD);
}

function removalTombstoneMarker(tombstone: string): string {
  return path.join(tombstone, REMOVAL_TOMBSTONE_MARKER);
}

function isOwnedRemovalTombstone(
  root: string,
  tombstone: string,
  ownership: RemovalTombstoneOwnership
): boolean {
  assertManagedPath(root, tombstone);
  try {
    const tombstoneStat = fs.lstatSync(tombstone);
    const markerStat = fs.lstatSync(removalTombstoneMarker(tombstone));
    if (!tombstoneStat.isDirectory() || tombstoneStat.isSymbolicLink()
      || !markerStat.isFile() || markerStat.isSymbolicLink()) return false;
    const record = JSON.parse(fs.readFileSync(removalTombstoneMarker(tombstone), 'utf8')) as Partial<RemovalTombstoneOwnership>;
    return record.version === 1
      && record.targetDigest === ownership.targetDigest
      && record.permitDigest === ownership.permitDigest
      && record.kind === ownership.kind
      && typeof record.source === 'string'
      && path.resolve(record.source) === path.resolve(ownership.source);
  } catch {
    return false;
  }
}

function assertOwnedRemovalTombstone(
  root: string,
  tombstone: string,
  ownership: RemovalTombstoneOwnership
): void {
  if (!isOwnedRemovalTombstone(root, tombstone, ownership)) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${ownership.source}`);
  }
}

function stageManagedRemoval(
  root: string,
  source: string,
  tombstone: string,
  recovering: boolean,
  ownership: RemovalTombstoneOwnership
): void {
  assertManagedPath(root, source);
  assertManagedPath(root, tombstone);
  const sourceExists = fs.existsSync(source);
  const tombstoneExists = fs.existsSync(tombstone);
  if (tombstoneExists) {
    assertOwnedRemovalTombstone(root, tombstone, ownership);
    if (sourceExists) {
      throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
    }
    if (recovering) return;
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
  }
  if (recovering) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_ACTION_OUTCOME_UNKNOWN: ${source}`);
  }
  if (!sourceExists) return;
  fs.mkdirSync(tombstone, { mode: 0o700 });
  fs.writeFileSync(removalTombstoneMarker(tombstone), `${JSON.stringify(ownership)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  fs.renameSync(source, removalTombstonePayload(tombstone));
}

function cleanupManagedTombstones(
  root: string,
  targetDigest: string,
  permitDigest: string,
  kind: RemovalActionKind,
  sources: readonly string[]
): void {
  for (const source of sources) {
    const tombstone = removalTombstonePath(targetDigest, kind, source);
    if (fs.existsSync(tombstone) && isOwnedRemovalTombstone(root, tombstone, {
      version: 1,
      targetDigest,
      permitDigest,
      kind,
      source
    })) removeManagedDir(root, tombstone);
  }
}

function branchRemovalTombstoneRef(targetDigest: string): string {
  return `refs/agent-infra/sandbox-removal/${targetDigest}/branch`;
}

function branchPermitHead(
  branch: string,
  permits: ReadonlyMap<string, WorktreeRemovalPermit>
): string | null {
  const heads = new Set(
    [...permits.values()]
      .filter((permit) => permit.snapshot.branch === branch)
      .map((permit) => permit.snapshot.head)
  );
  return heads.size === 1 ? [...heads][0]! : null;
}

function stageBranchRemoval(
  config: SandboxConfig,
  branch: string,
  targetDigest: string,
  permits: ReadonlyMap<string, WorktreeRemovalPermit>,
  recovering: boolean
): void {
  const expectedHead = branchPermitHead(branch, permits);
  if (!expectedHead) throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  const branchName = `refs/heads/${branch}`;
  const tombstone = branchRemovalTombstoneRef(targetDigest);
  const branchExists = runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', branchName]);
  const tombstoneExists = runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', tombstone]);
  if (branchExists && tombstoneExists) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
  if (recovering) {
    if (branchExists && !tombstoneExists) {
      throw new Error(`SANDBOX_CONTROL_REMOVAL_ACTION_OUTCOME_UNKNOWN: ${branch}`);
    }
    if (tombstoneExists && runSafe('git', ['-C', config.repoRoot, 'rev-parse', tombstone]) !== expectedHead) {
      throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
    }
    return;
  }
  if (!branchExists) return;
  assertBranchRemovalIdentity(config, branch, permits);
  const actualHead = runSafe('git', ['-C', config.repoRoot, 'rev-parse', branchName]);
  if (!runOk('git', ['-C', config.repoRoot, 'update-ref', tombstone, actualHead, '0'.repeat(40)])) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
  if (!runOk('git', ['-C', config.repoRoot, 'update-ref', '-d', branchName, actualHead])) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
}

function cleanupBranchTombstone(
  config: SandboxConfig,
  branch: string,
  targetDigest: string,
  permits: ReadonlyMap<string, WorktreeRemovalPermit>
): void {
  const tombstone = branchRemovalTombstoneRef(targetDigest);
  if (!runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', tombstone])) return;
  const expectedHead = branchPermitHead(branch, permits);
  if (!expectedHead || runSafe('git', ['-C', config.repoRoot, 'rev-parse', tombstone]) !== expectedHead) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
  if (!runOk('git', ['-C', config.repoRoot, 'update-ref', '-d', tombstone, expectedHead])) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${branch}`);
  }
}

function worktreeRegistration(
  config: SandboxConfig,
  worktree: string
): { head: string; branch: string | null } | null {
  const lines = runSafe('git', ['-C', config.repoRoot, 'worktree', 'list', '--porcelain']).split('\n');
  let current: { path: string; head: string; branch: string | null } | null = null;
  const flush = (): { head: string; branch: string | null } | null => {
    if (!current || path.resolve(current.path) !== path.resolve(worktree)) return null;
    return { head: current.head, branch: current.branch };
  };
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      const previous = flush();
      if (previous) return previous;
      current = { path: line.slice('worktree '.length), head: '', branch: null };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  return flush();
}

function assertWorktreeRegistrationIdentity(
  config: SandboxConfig,
  worktree: string,
  permit: WorktreeRemovalPermit
): void {
  const registration = worktreeRegistration(config, worktree);
  if (!registration) return;
  if (registration.head !== permit.snapshot.head
    || registration.branch !== `refs/heads/${permit.snapshot.branch}`) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${worktree}`);
  }
}

function pruneWorktreeRegistration(config: SandboxConfig, worktree: string): void {
  runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
  if (worktreeRegistration(config, worktree)) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_ACTION_OUTCOME_UNKNOWN: ${worktree}`);
  }
}

function stageWorktreeRemoval(
  config: SandboxConfig,
  worktree: string,
  permit: WorktreeRemovalPermit,
  tombstone: string,
  recovering: boolean,
  ownership: RemovalTombstoneOwnership
): void {
  assertManagedPath(config.worktreeBase, worktree);
  assertManagedPath(config.worktreeBase, tombstone);
  const worktreeExists = fs.existsSync(worktree);
  const tombstoneExists = fs.existsSync(tombstone);
  if (worktreeExists || !recovering) verifyWorktreePermit(permit);
  if (recovering) {
    if (worktreeExists || !tombstoneExists) {
      if (worktreeExists && tombstoneExists) {
        throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${worktree}`);
      }
      throw new Error(`SANDBOX_CONTROL_REMOVAL_ACTION_OUTCOME_UNKNOWN: ${worktree}`);
    }
    assertOwnedRemovalTombstone(config.worktreeBase, tombstone, ownership);
    assertWorktreeRegistrationIdentity(config, worktree, permit);
    pruneWorktreeRegistration(config, worktree);
    return;
  }
  if (!worktreeExists) return;
  stageManagedRemoval(config.worktreeBase, worktree, tombstone, false, ownership);
  pruneWorktreeRegistration(config, worktree);
}

function cleanupCompletedRemovalArtifacts(
  config: SandboxConfig,
  target: RmTarget,
  committedTarget: SandboxRemovalTargetCommit,
  targetDigest: string
): void {
  const journals = listSandboxRemovalJournals({
    branch: target.effectiveBranch,
    project: config.project,
    targetDigest
  });
  if (journals.length === 0) return;
  const completed = (phase: SandboxRemovalJournal['phase']): boolean => journals.every((journal) => (
    sandboxRemovalPhaseIndex(journal.phase) >= sandboxRemovalPhaseIndex(phase)
  ));
  if (completed('workspace-removed')) {
    cleanupManagedTombstones(
      config.workspaceViewBase, targetDigest, committedTarget.permitDigest, 'workspace', target.workspaceViewRoots
    );
    cleanupManagedTombstones(
      path.join(config.controlBase, config.project), targetDigest, committedTarget.permitDigest, 'workspace', target.controlRoots
    );
    cleanupManagedTombstones(
      config.worktreeBase, targetDigest, committedTarget.permitDigest, 'worktree', committedTarget.worktreePaths
    );
  }
  if (completed('branch-removed')) {
    cleanupBranchTombstone(config, target.effectiveBranch, targetDigest, new Map(
      committedTarget.permits.map((permit) => [path.resolve(permit.path), {
        mode: permit.mode,
        snapshot: permit.snapshot
      }])
    ));
  }
  if (completed('tool-removed')) {
    cleanupManagedTombstones(config.home, targetDigest, committedTarget.permitDigest, 'tool', committedTarget.toolPaths);
  }
  if (completed('shell-removed')) {
    cleanupManagedTombstones(config.shellConfigBase, targetDigest, committedTarget.permitDigest, 'shell', committedTarget.shellPaths);
  }
  if (completed('share-removed')) {
    cleanupManagedTombstones(config.shareBase, targetDigest, committedTarget.permitDigest, 'share', [committedTarget.sharePath]);
  }
}

function removalActionPaths(target: RmTarget, config: SandboxConfig, phase: SandboxRemovalJournal['phase']): string[] {
  if (phase === 'workspace-removed') {
    return [...target.workspaceViewRoots, ...target.controlRoots];
  }
  if (phase === 'tool-removed') {
    return target.toolCandidates.flatMap(({ candidates }) => candidates);
  }
  if (phase === 'shell-removed') {
    return shellConfigDirCandidates(config, target.effectiveBranch);
  }
  if (phase === 'share-removed') {
    return [shareBranchDir(config, target.effectiveBranch)];
  }
  return [];
}

function permitsFromJournal(
  journals: readonly SandboxRemovalJournal[],
  target: RmTarget,
  expectedTargetDigest: string
): Map<string, WorktreeRemovalPermit> {
  const permits = new Map<string, WorktreeRemovalPermit>();
  for (const journal of journals) {
    if (journal.target.targetDigest !== expectedTargetDigest) continue;
    if (journal.target.branch !== target.effectiveBranch) {
      throw new Error('SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH');
    }
    for (const entry of journal.target.permits) {
      if (path.resolve(entry.path) !== path.resolve(entry.snapshot.worktree)) {
        throw new Error('SANDBOX_CONTROL_REMOVAL_PERMIT_MISMATCH');
      }
      permits.set(path.resolve(entry.path), {
        mode: entry.mode,
        snapshot: entry.snapshot
      });
    }
  }
  return permits;
}

export function sandboxManagedPathKey(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
  resolveExistingPath: (resolved: string) => string = (resolved) => fs.realpathSync.native(resolved)
): string {
  const resolved = path.resolve(candidate);
  let identity = resolved;
  try {
    identity = resolveExistingPath(resolved);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw new Error(
        `SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: unable to determine managed path identity for '${resolved}'`
      );
    }
  }
  return platform === 'win32' ? identity.toLowerCase() : identity;
}

type RmTarget = {
  branch: string;
  effectiveBranch: string;
  engine: string;
  matchedContainers: string[];
  existingWorktrees: string[];
  toolCandidates: Array<{ tool: SandboxTool; candidates: string[] }>;
  managedPathCandidates?: string[];
  workspace: SandboxWorkspaceKey;
  controlRoots: string[];
  workspaceViewRoots: string[];
};

type RemovalActionKind = 'workspace' | 'worktree' | 'tool' | 'shell' | 'share';

type RemovalActionPreparation = Readonly<{
  run: boolean;
  recovering: boolean;
}>;

type CleanupCandidate = Readonly<{
  row: SandboxRow;
  cleanupTarget: SandboxCleanupTarget;
}>;

type CleanupGroup = Readonly<{
  candidates: readonly CleanupCandidate[];
  cleanupTarget: SandboxCleanupTarget;
  target: RmTarget;
}>;

type RmOneOptions = {
  assumeYes?: boolean;
  interactive?: boolean;
  quiet?: boolean;
  target?: RmTarget;
  cleanupTarget?: SandboxCleanupTarget;
  permits?: ReadonlyMap<string, WorktreeRemovalPermit>;
  allowDirtyDiscard?: boolean;
  prompt?: PromptDependencies;
};

type PromptDependencies = {
  confirm?: typeof p.confirm;
  isCancel?: typeof p.isCancel;
};

function recoveryContexts(
  config: SandboxConfig,
  target: RmTarget,
  worktrees: readonly string[]
): Map<string, WorktreeRecoveryContext> {
  const candidates = worktreeDirCandidates(config, target.effectiveBranch).map((candidate) => path.resolve(candidate));
  const existingCandidates = candidates.filter((candidate) => fs.existsSync(candidate));
  if (existingCandidates.length !== 1) return new Map();

  const contexts = new Map<string, WorktreeRecoveryContext>();
  for (const worktree of worktrees) {
    const resolvedWorktree = path.resolve(worktree);
    if (resolvedWorktree !== existingCandidates[0]) continue;
    for (const root of target.controlRoots.filter((candidate) => fs.existsSync(candidate))) {
      assertLegacyCandidateEvidence(root, config.controlBase, config, target.effectiveBranch, target.matchedContainers);
      assertControlRootMatchesTarget(root, target.effectiveBranch, target.workspace);
    }
    contexts.set(resolvedWorktree, {
      repoRoot: config.repoRoot,
      worktreeBase: config.worktreeBase,
      branch: target.effectiveBranch,
      identitySource: target.workspace.mode,
      taskId: target.workspace.mode === 'task-bound' ? target.workspace.taskId : null
    });
  }
  return contexts;
}

function resolveRmTarget(
  config: SandboxConfig,
  tools: SandboxTool[],
  cleanupTarget: SandboxCleanupTarget,
  options: Readonly<{ discoveredContainers?: readonly string[] }> = {}
): RmTarget {
  assertValidBranchName(cleanupTarget.branch);
  const engine = detectEngine(config);
  const branch = cleanupTarget.branch;
  const effectiveBranch = branch;
  const worktreeCandidates = worktreeDirCandidates(config, branch);
  const toolCandidates = tools.map((tool) => ({
    tool,
    candidates: toolConfigDirCandidates(tool, config.project, branch)
  }));
  const shellCandidates = shellConfigDirCandidates(config, branch);
  const existing = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
  const matchedContainers = options.discoveredContainers
    ? options.discoveredContainers.map((container) => {
      if (!existing.includes(container)) {
        throw new Error(
          `SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: discovered container '${container}' is no longer present`
        );
      }
      return container;
    })
    : containerNameCandidates(config, branch).filter((name) => existing.includes(name));

  const workspace = cleanupTarget.workspace;
  const identities: SandboxWorkspaceKey[] = [workspace];
  const containers = options.discoveredContainers
    ? matchedContainers
    : [...new Set([...containerNameCandidates(config, effectiveBranch), ...matchedContainers])];
  const controlRoots = containers.flatMap((container) => identities.map((identity) => sandboxControlPaths({
    base: config.controlBase, project: config.project, container, identity
  }).root));
  const workspaceViewRoots = containers.flatMap((container) => identities.map((identity) => sandboxWorkspaceViewPaths({
    base: config.workspaceViewBase, project: config.project, container, identity
  }).root));
  const managedPathCandidates = [...new Set([
    ...worktreeCandidates,
    ...toolCandidates.flatMap(({ candidates }) => candidates),
    ...shellCandidates,
    shareBranchDir(config, branch),
    ...controlRoots,
    ...workspaceViewRoots
  ].map((candidate) => path.resolve(candidate)))];

  return {
    branch,
    effectiveBranch,
    engine,
    matchedContainers,
    existingWorktrees: worktreeCandidates.filter((candidate) => fs.existsSync(candidate)),
    toolCandidates,
    managedPathCandidates,
    workspace,
    controlRoots: [...new Set(controlRoots)],
    workspaceViewRoots: [...new Set(workspaceViewRoots)]
  };
}

type CurrentContainerIdentity = Readonly<{ id: string; labels: Record<string, string> }>;

function inspectNamedContainerIdentity(target: RmTarget, container: string): CurrentContainerIdentity {
  const raw = runSafeEngine(target.engine, 'docker', [
    'inspect', '--format', '{{json .}}', container
  ]).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SANDBOX_WORKSPACE_IDENTITY_UNKNOWN: container '${container}' inspection is invalid`);
  }
  const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SANDBOX_WORKSPACE_IDENTITY_UNKNOWN: container '${container}' inspection is incomplete`);
  }
  const candidate = value as {
    Id?: unknown;
    Config?: { Labels?: unknown };
  };
  if (typeof candidate.Id !== 'string' || !candidate.Id
    || !candidate.Config?.Labels || typeof candidate.Config.Labels !== 'object'
    || Array.isArray(candidate.Config.Labels)
    || Object.values(candidate.Config.Labels).some((value) => typeof value !== 'string')) {
    throw new Error(`SANDBOX_WORKSPACE_IDENTITY_UNKNOWN: container '${container}' inspection is incomplete`);
  }
  return { id: candidate.Id, labels: candidate.Config.Labels as Record<string, string> };
}

function assertMatchedContainerIdentities(config: SandboxConfig, target: RmTarget): Map<string, CurrentContainerIdentity> {
  const current = new Map<string, CurrentContainerIdentity>();
  for (const container of target.matchedContainers) {
    const observation = inspectNamedContainerIdentity(target, container);
    const stringLabels = observation.labels;
    const branch = stringLabels[sandboxBranchLabel(config)];
    if (branch !== target.branch) {
      throw new Error(
        `SANDBOX_WORKSPACE_IDENTITY_CONFLICT: container '${container}' branch is ${JSON.stringify(branch ?? null)}, `
        + `but this request is ${JSON.stringify(target.branch)}`
      );
    }
    const identity = parseSandboxWorkspaceIdentity(stringLabels, {
      mode: sandboxWorkspaceModeLabel(config),
      taskId: sandboxTaskIdLabel(config)
    });
    if (identity.mode === 'legacy-invalid' || !sameSandboxWorkspaceIdentity(identity, target.workspace)) {
      const existingDescription = identity.mode === 'task-bound'
        ? `task-bound:${identity.taskId}`
        : identity.mode;
      const requestedDescription = target.workspace.mode === 'task-bound'
        ? `task-bound:${target.workspace.taskId}`
        : target.workspace.mode;
      throw new Error(
        `SANDBOX_WORKSPACE_IDENTITY_CONFLICT: container '${container}' is ${existingDescription}, `
        + `but this request is ${requestedDescription}`
      );
    }
    current.set(container, observation);
  }
  return current;
}

function controlRootContainer(config: SandboxConfig, root: string): string {
  const relative = path.relative(path.join(config.controlBase, config.project), root);
  const [container, identity, ...extra] = relative.split(path.sep);
  if (!container || !identity || extra.length > 0) {
    throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_INVALID: ${root}`);
  }
  return container;
}

function assertControlRootMatchesTarget(root: string, effectiveBranch: string, workspace: SandboxWorkspaceKey): void {
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    if (workspace.mode === 'task-bound') {
      throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: ${root}`);
    }
    return;
  }
  const manifest = readSandboxControlManifest(manifestPath);
  const identityMatches = workspace.mode === 'task-bound'
    ? manifest.mode === 'task-bound' && manifest.taskId === workspace.taskId
    : manifest.mode === 'branch-only';
  if (manifest.branch !== effectiveBranch || !identityMatches) {
    throw new Error(`SANDBOX_CONTROL_TARGET_MISMATCH: ${root}`);
  }
}

function preflightRmTarget(
  config: SandboxConfig,
  target: RmTarget
): void {
  const current = assertMatchedContainerIdentities(config, target);
  const manifests: ReturnType<typeof readSandboxControlManifest>[] = [];
  for (const root of target.controlRoots.filter((candidate) => fs.existsSync(candidate))) {
    assertLegacyCandidateEvidence(root, config.controlBase, config, target.effectiveBranch, target.matchedContainers);
    assertControlRootMatchesTarget(root, target.effectiveBranch, target.workspace);
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readSandboxControlManifest(manifestPath);
    const rootContainer = controlRootContainer(config, root);
    if (manifest.container !== rootContainer) {
      throw new Error(`SANDBOX_CONTROL_TARGET_MISMATCH: ${root}`);
    }
    const observed = current.get(manifest.container);
    if (observed && (observed.id !== manifest.containerIdentity.id
      || Object.entries(manifest.containerIdentity.labels).some(([key, value]) => observed.labels[key] !== value))) {
      throw new Error(`SANDBOX_CONTROL_TARGET_MISMATCH: ${root}`);
    }
    manifests.push(manifest);
  }

  if (target.workspace.mode !== 'task-bound') return;
  const matched = new Set(target.matchedContainers);
  const manifestContainers = manifests.map((manifest) => manifest.container);
  if (matched.size > 0 && manifestContainers.some((container) => !matched.has(container))) {
    throw new Error('SANDBOX_CONTROL_TARGET_MISMATCH: manifest container is outside the cleanup target');
  }
  for (const container of matched) {
    const matches = manifests.filter((manifest) => manifest.container === container);
    if (matches.length !== 1) {
      throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: container '${container}'`);
    }
  }
  if (matched.size === 0 && manifests.length > 0) {
    const supported = new Set(containerNameCandidates(config, target.effectiveBranch));
    if (manifests.some((manifest) => !supported.has(manifest.container))) {
      throw new Error('SANDBOX_CONTROL_TARGET_MISMATCH: manifest container is outside the cleanup target');
    }
  }
}

function assertCleanupGroupPathsDoNotOverlap(groups: readonly CleanupGroup[]): void {
  const owners = new Map<string, string>();
  for (const group of groups) {
    for (const candidate of group.target.managedPathCandidates ?? []) {
      const key = sandboxManagedPathKey(candidate);
      const existingBranch = owners.get(key);
      if (existingBranch && existingBranch !== group.cleanupTarget.branch) {
        throw new Error(
          `SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: managed path '${candidate}' is shared by branches `
          + `${JSON.stringify(existingBranch)} and ${JSON.stringify(group.cleanupTarget.branch)}`
        );
      }
      owners.set(key, group.cleanupTarget.branch);
    }
  }
}

function assertWorktreeBranchesMatchGroups(
  groups: readonly CleanupGroup[],
  inspections: readonly WorktreeInspection[]
): void {
  const byPath = new Map(
    inspections.flatMap((inspection) => inspection.status === 'failed'
      ? []
      : [[sandboxManagedPathKey(inspection.snapshot.worktree), inspection.snapshot.branch] as const])
  );
  for (const group of groups) {
    for (const worktree of group.target.existingWorktrees) {
      const registeredBranch = byPath.get(sandboxManagedPathKey(worktree));
      if (registeredBranch && registeredBranch !== group.cleanupTarget.branch) {
        throw new Error(
          `SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: worktree '${worktree}' is registered to branch `
          + `${JSON.stringify(registeredBranch)}, but cleanup targets ${JSON.stringify(group.cleanupTarget.branch)}`
        );
      }
    }
  }
}

function assertLegacyCandidateEvidence(
  candidate: string,
  base: string,
  config: SandboxConfig,
  effectiveBranch: string,
  matchedContainers: readonly string[]
): void {
  const relative = path.relative(path.join(base, config.project), candidate);
  const [container, identity] = relative.split(path.sep);
  const [canonical, legacy] = containerNameCandidates(config, effectiveBranch);
  if (!container || !identity || legacy === canonical || container !== legacy || matchedContainers.includes(container)) return;
  const manifestPath = path.join(config.controlBase, config.project, container, identity, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: ${candidate}`);
  }
}

function assertRemoved(target: string, label: string): void {
  if (fs.existsSync(target)) throw new Error(`${label} still exists after removal: ${target}`);
}

function removeEmptyManagedParent(base: string, directory: string): void {
  const parent = path.dirname(directory);
  if (path.resolve(parent) === path.resolve(base)) return;
  assertManagedPath(base, parent);
  try {
    fs.rmdirSync(parent);
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  assertRemoved(parent, 'Empty sandbox container directory');
}

async function removeExactSandboxContainer(
  engine: string,
  manifest: ReturnType<typeof readSandboxControlManifest>,
  timeoutMs: number
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadlineAt - Date.now());
  const inspect = () => inspectSandboxControlContainer(manifest, { timeoutMs: remaining() });
  const runAuthorityCommand = (args: string[]): boolean => {
    const command = manifest.authorityEvidence
      ? commandForSandboxAuthority(manifest.authorityEvidence, 'docker', args)
      : null;
    return command ? runOk(command.cmd, command.args, { timeout: remaining() })
      : runOkEngine(engine, 'docker', args, { timeout: remaining() });
  };
  const before = await inspect();
  if (before.state === 'unknown') throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${before.reason}`);
  if (before.state === 'absent') return;
  if (before.running && !runAuthorityCommand(['stop', '--timeout', '1', manifest.containerIdentity.id])) {
    const afterStop = await inspect();
    if (afterStop.state !== 'absent' && afterStop.state !== 'found') {
      throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${afterStop.reason}`);
    }
    if (afterStop.state === 'found' && afterStop.running) {
      throw new Error(`Failed to stop sandbox container: ${manifest.containerIdentity.id}`);
    }
  }
  const afterStop = await inspect();
  if (afterStop.state === 'unknown') throw new Error(`SANDBOX_CONTROL_CONTAINER_UNKNOWN: ${afterStop.reason}`);
  if (afterStop.state === 'found' && !runAuthorityCommand(['rm', manifest.containerIdentity.id])) {
    const afterRemove = await inspect();
    if (afterRemove.state !== 'absent') {
      throw new Error(`Failed to remove sandbox container: ${manifest.containerIdentity.id}`);
    }
  }
}

async function removeProjectControlRoots(config: SandboxConfig, engine: string): Promise<Set<string>> {
  const containers = new Set<string>();
  const projectRoot = path.join(config.controlBase, config.project);
  if (!fs.existsSync(projectRoot)) return containers;
  assertManagedPath(config.controlBase, projectRoot);
  const projectStat = fs.lstatSync(projectRoot);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  for (const container of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!container.isDirectory() || container.isSymbolicLink()) continue;
    const containerRoot = path.join(projectRoot, container.name);
    for (const identity of fs.readdirSync(containerRoot, { withFileTypes: true })) {
      if (!identity.isDirectory() || identity.isSymbolicLink()) continue;
      const root = path.join(containerRoot, identity.name);
      const manifestPath = path.join(root, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: ${root}`);
      const manifest = readSandboxControlManifest(manifestPath);
      containers.add(manifest.container);
      await removeSandboxControlRoot(root, {
        inspectContainer: (timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }),
        removeContainer: (timeoutMs) => removeExactSandboxContainer(engine, manifest, timeoutMs)
      });
    }
  }
  return containers;
}

function inspectionBlockers(inspections: readonly WorktreeInspection[]): WorktreeInspection[] {
  return inspections.filter((inspection) => inspection.status !== 'clean');
}

function blockerMessage(blockers: readonly WorktreeInspection[]): string {
  return blockers.map((blocker) => {
    if (blocker.status === 'failed') return `${JSON.stringify(blocker.worktree)}: ${blocker.message}`;
    return `${formatWorktreeSnapshot(blocker.snapshot)}\n  Action: commit, stash, clean, or remove this sandbox interactively.`;
  }).join('\n');
}

function cleanPermits(inspections: readonly WorktreeInspection[]): Map<string, WorktreeRemovalPermit> {
  const permits = new Map<string, WorktreeRemovalPermit>();
  for (const inspection of inspections) {
    if (inspection.status === 'clean') permits.set(inspection.snapshot.worktree, createCleanPermit(inspection.snapshot));
  }
  return permits;
}

async function authorizeWorktrees(
  worktrees: readonly string[],
  { allowDirtyDiscard, assumeYes }: { allowDirtyDiscard: boolean; assumeYes: boolean },
  {
    interactive = Boolean(process.stdin.isTTY),
    confirm = p.confirm,
    isCancel = p.isCancel,
    recovery = new Map<string, WorktreeRecoveryContext>()
  }: PromptDependencies & { interactive?: boolean; recovery?: ReadonlyMap<string, WorktreeRecoveryContext> } = {}
): Promise<Map<string, WorktreeRemovalPermit>> {
  const inspections = worktrees.map((worktree) => {
    const inspection = inspectWorktrees([worktree])[0]!;
    const context = recovery.get(path.resolve(worktree));
    return inspection.status === 'failed' && context
      ? inspectRecoveredWorktree(worktree, context)
      : inspection;
  });
  const failures = inspections.filter((inspection) => inspection.status === 'failed');
  if (failures.length > 0) throw new Error(`Unable to inspect worktree(s):\n${blockerMessage(failures)}`);
  const permits = cleanPermits(inspections);
  for (const inspection of inspections) {
    if (inspection.status !== 'dirty') continue;
    if (!allowDirtyDiscard || assumeYes || !interactive) {
      throw new Error(`Refusing to remove dirty worktree(s):\n${blockerMessage([inspection])}`);
    }
    p.log.warn(formatWorktreeSnapshot(inspection.snapshot));
    const confirmed = await confirm({
      message: 'Discard these exact uncommitted changes?',
      initialValue: false
    });
    if (isCancel(confirmed) || !confirmed) throw new Error('Dirty worktree removal cancelled; nothing was deleted');
    permits.set(inspection.snapshot.worktree, createDiscardPermit(inspection.snapshot));
  }
  return permits;
}

async function rmOne(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<void> {
  const target = options.target ?? resolveRmTarget(
    config,
    tools,
    options.cleanupTarget ?? resolveSandboxCleanupTarget(branch, config.repoRoot)
  );
  const { effectiveBranch, engine, matchedContainers, existingWorktrees, toolCandidates } = target;
  const { workspace, controlRoots, workspaceViewRoots } = target;
  preflightRmTarget(config, target);
  const confirm = options.prompt?.confirm ?? p.confirm;
  const isCancel = options.prompt?.isCancel ?? p.isCancel;

  if (!options.quiet) {
    p.intro(pc.cyan(`Removing sandbox for ${branch}`));
  }

  const targetDigest = removalTargetDigest(config, target);
  const existingJournals = listSandboxRemovalJournals({
    branch: effectiveBranch,
    project: config.project,
    targetDigest
  });
  const persistedTarget = existingJournals[0]?.target;
  for (const journal of existingJournals) {
    if (!persistedTarget) break;
    assertRemovalSelectionMatches(persistedTarget, journal.target);
  }
  const recovery = options.permits
    ? new Map<string, WorktreeRecoveryContext>()
    : recoveryContexts(config, target, existingWorktrees);
  const journalPermits = options.permits ? new Map<string, WorktreeRemovalPermit>()
    : permitsFromJournal(existingJournals, target, targetDigest);
  const permits = options.permits
    ? new Map(options.permits)
    : journalPermits.size > 0
      ? journalPermits
      : await authorizeWorktrees(existingWorktrees, {
          allowDirtyDiscard: options.allowDirtyDiscard ?? true,
          assumeYes: Boolean(options.assumeYes)
        }, {
          ...options.prompt,
          interactive: options.interactive ?? Boolean(process.stdin.isTTY),
          recovery
        });
  for (const worktree of existingWorktrees) {
    const permit = permits.get(path.resolve(worktree));
    if (!permit) throw new Error(`Missing worktree removal permit: ${worktree}`);
    const worktreeTombstone = removalTombstonePath(targetDigest, 'worktree', worktree);
    const workspacePhasePending = existingJournals.some((journal) => (
      sandboxRemovalPhaseIndex(journal.phase) < sandboxRemovalPhaseIndex('workspace-removed')
    ));
    if (fs.existsSync(worktree)
      || (workspacePhasePending
      && !isOwnedRemovalTombstone(config.worktreeBase, worktreeTombstone, {
        version: 1,
        targetDigest,
        permitDigest: removalPermitDigest(permits),
        kind: 'worktree',
        source: worktree
      }))) {
      verifyWorktreePermit(permit);
    }
  }

  const recoveredRemovalChoice = persistedTarget;
  const shouldRemoveWorktree = recoveredRemovalChoice
    ? recoveredRemovalChoice.removeWorktree
    : existingWorktrees.length === 0
      ? false
      : options.assumeYes
        ? true
        : await confirm({
            message: `Remove worktree(s): ${existingWorktrees.join(', ')}?`,
            initialValue: true
          });
  if (isCancel(shouldRemoveWorktree)) {
    p.outro('Cancelled');
    return;
  }

  const shouldDeleteBranch = recoveredRemovalChoice
    ? recoveredRemovalChoice.removeBranch
    : shouldRemoveWorktree && existingWorktrees.length > 0
      ? options.assumeYes
        ? true
        : await confirm({
            message: `Also delete local branch '${effectiveBranch}'?`,
            initialValue: true
          })
      : false;
  if (isCancel(shouldDeleteBranch)) {
    p.outro('Cancelled');
    return;
  }

  const sharePath = path.resolve(shareBranchDir(config, effectiveBranch));
  const shouldRemoveShare = recoveredRemovalChoice
    ? recoveredRemovalChoice.removeShare
    : fs.existsSync(sharePath)
      ? options.assumeYes
        ? true
        : await confirm({
            message: `Remove share dir for branch '${effectiveBranch}' (${sharePath})?`,
            initialValue: true
          })
      : false;
  if (isCancel(shouldRemoveShare)) {
    p.outro('Cancelled');
    return;
  }

  const committedTarget = persistedTarget
    ? {
        ...persistedTarget,
        permitDigest: removalPermitDigest(permits),
        permits: removalPermitCommits(permits)
      }
    : removalTargetCommit(
        config,
        target,
        permits,
        Boolean(shouldRemoveWorktree),
        Boolean(shouldDeleteBranch),
        Boolean(shouldRemoveShare)
      );
  if (persistedTarget) assertRemovalSelectionMatches(persistedTarget, committedTarget);

  const coordinatedManifests = controlRoots
    .filter((candidate) => fs.existsSync(candidate))
    .flatMap((root) => {
      const manifestPath = path.join(root, 'manifest.json');
      return fs.existsSync(manifestPath)
        ? [[root, readSandboxControlManifest(manifestPath), fs.readFileSync(manifestPath, 'utf8')] as const]
        : [];
    });
  const resourceLocks = new Map<string, SandboxResourceLock>();
  const recoveredContainerNames = new Set<string>();
  try {
    for (const [root, manifest] of [...coordinatedManifests].sort(([left], [right]) => left.localeCompare(right))) {
      resourceLocks.set(root, acquireSandboxResourceLock(
        `${manifest.engine}:${manifest.containerIdentity.id}`,
        { lockDomain: manifest.authorityEvidence.lockDomain }
      ));
    }
    for (const journal of existingJournals.filter((candidate) => !fs.existsSync(candidate.target.controlRoot))) {
      if (!target.controlRoots.some((root) => path.resolve(root) === path.resolve(journal.target.controlRoot))) {
        throw new Error('SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH');
      }
      assertRemovalSelectionMatches(committedTarget, journal.target);
      if (journal.target.permitDigest !== removalPermitDigest(permits)) {
        throw new Error('SANDBOX_CONTROL_REMOVAL_PERMIT_MISMATCH');
      }
      const lock = acquireSandboxResourceLock(`${journal.engine}:${journal.containerId}`, {
        lockDomain: journal.lockDomain
      });
      resourceLocks.set(journal.target.controlRoot, lock);
      const current = listSandboxRemovalJournals({
        branch: journal.target.branch,
        project: journal.target.project,
        targetDigest: journal.target.targetDigest
      }).find((candidate) => candidate.carrierIdentityDigest === journal.carrierIdentityDigest);
      if (!current || current.revision !== journal.revision || current.handoffId !== journal.handoffId) {
        throw new Error('SANDBOX_CONTROL_REMOVAL_JOURNAL_REVISION_MISMATCH');
      }
      const claimed = claimSandboxRemovalJournal(current, { resourceLock: lock });
      if (!['carrier-finalizing', 'carrier-removed', 'workspace-finalizing', 'workspace-removed',
        'branch-finalizing', 'branch-removed', 'tool-finalizing', 'tool-removed',
        'shell-finalizing', 'shell-removed', 'share-finalizing', 'share-removed', 'completed']
        .includes(claimed.phase)) {
        throw new Error('SANDBOX_CONTROL_REMOVE_RECOVERY_PENDING');
      }
      const recovered = claimed.phase === 'carrier-finalizing'
        ? advanceSandboxRemovalJournalPhase(claimed, 'carrier-removed', { resourceLock: lock })
        : claimed;
      recoveredContainerNames.add(controlRootContainer(config, journal.target.controlRoot));
    }
    cleanupCompletedRemovalArtifacts(config, target, committedTarget, targetDigest);
    preflightRmTarget(config, target);
  const coordinatedContainers = new Set(recoveredContainerNames);
  for (const root of controlRoots.filter((candidate) => fs.existsSync(candidate))) {
    assertLegacyCandidateEvidence(root, config.controlBase, config, effectiveBranch, matchedContainers);
    assertControlRootMatchesTarget(root, effectiveBranch, workspace);
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const currentRaw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = readSandboxControlManifest(manifestPath);
    const initial = coordinatedManifests.find(([candidate]) => candidate === root);
    if (!initial || currentRaw !== initial[2]) throw new Error('SANDBOX_CONTROL_MANIFEST_CHANGED');
    coordinatedContainers.add(manifest.container);
    await removeSandboxControlRoot(root, {
      inspectContainer: (timeoutMs) => inspectSandboxControlContainer(manifest, { timeoutMs }),
      removeContainer: (timeoutMs) => removeExactSandboxContainer(engine, manifest, timeoutMs),
      resourceLock: resourceLocks.get(root),
      retainRemovalJournal: true,
      removalTarget: { ...committedTarget, controlRoot: path.resolve(root) }
    });
    removeEmptyManagedParent(path.join(config.controlBase, config.project), root);
  }

  if ([...recoveredContainerNames].some((name) => matchedContainers.includes(name))) {
    throw new Error('SANDBOX_CONTROL_CONTAINER_REAPPEARED');
  }

  const uncoordinatedContainers = matchedContainers.filter((name) => !coordinatedContainers.has(name));
  if (uncoordinatedContainers.length > 0) {
    if (workspace.mode === 'task-bound') {
      throw new Error(`SANDBOX_CONTROL_TARGET_EVIDENCE_MISSING: container '${uncoordinatedContainers[0]}'`);
    }
    const spinner = p.spinner();
    spinner.start(`Stopping container(s): ${uncoordinatedContainers.join(', ')}`);
    for (const name of uncoordinatedContainers) {
      if (!runOkEngine(engine, 'docker', ['stop', name])) throw new Error(`Failed to stop sandbox container: ${name}`);
      if (!runOkEngine(engine, 'docker', ['rm', name])) throw new Error(`Failed to remove sandbox container: ${name}`);
    }
    const remaining = runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(Boolean);
    const leftovers = uncoordinatedContainers.filter((name) => remaining.includes(name));
    if (leftovers.length > 0) throw new Error(`Sandbox container(s) still exist after removal: ${leftovers.join(', ')}`);
    spinner.stop(pc.green(`Removed container(s): ${uncoordinatedContainers.join(', ')}`));
  } else {
    p.log.warn(`No sandbox container found for '${branch}'`);
  }

  const runWorkspaceCleanup = prepareRemovalAction(
    config.project, target, targetDigest, 'workspace-finalizing', 'workspace-removed', resourceLocks
  );
  if (runWorkspaceCleanup.run) {
    for (const [roots, base, label] of [
      [workspaceViewRoots, path.join(config.workspaceViewBase, config.project), 'Workspace view'],
      [controlRoots, path.join(config.controlBase, config.project), 'Control channel']
    ] as const) {
      for (const directory of roots.filter((candidate) => fs.existsSync(candidate))) {
        assertLegacyCandidateEvidence(directory, base === path.join(config.controlBase, config.project)
          ? config.controlBase : config.workspaceViewBase, config, effectiveBranch, matchedContainers);
        stageManagedRemoval(
          base,
          directory,
          removalTombstonePath(targetDigest, 'workspace', directory),
          runWorkspaceCleanup.recovering,
          {
            version: 1,
            targetDigest,
            permitDigest: committedTarget.permitDigest,
            kind: 'workspace',
            source: directory
          }
        );
        if (!options.quiet) p.log.success(`${label} removed: ${directory}`);
      }
    }

    if (shouldRemoveWorktree) {
      for (const worktree of existingWorktrees) {
        const permit = permits.get(path.resolve(worktree));
        if (!permit) throw new Error(`Missing worktree removal permit: ${worktree}`);
        stageWorktreeRemoval(
          config,
          worktree,
          permit,
          removalTombstonePath(targetDigest, 'worktree', worktree),
          runWorkspaceCleanup.recovering,
          {
            version: 1,
            targetDigest,
            permitDigest: committedTarget.permitDigest,
            kind: 'worktree',
            source: worktree
          }
        );
      }
    }
  } else {
    assertRemovalPathsAbsent([
      ...removalActionPaths(target, config, 'workspace-removed'),
      ...(shouldRemoveWorktree ? existingWorktrees : [])
    ]);
  }
  advanceRemovalJournals(config.project, target, targetDigest, 'workspace-removed', resourceLocks);
  cleanupCompletedRemovalArtifacts(config, target, committedTarget, targetDigest);
  for (const [roots, base] of [
    [workspaceViewRoots, path.join(config.workspaceViewBase, config.project)],
    [controlRoots, path.join(config.controlBase, config.project)]
  ] as const) {
    for (const directory of roots) {
      if (!fs.existsSync(directory)) removeEmptyManagedParent(base, directory);
    }
  }

  const runBranchCleanup = prepareRemovalAction(
    config.project, target, targetDigest, 'branch-finalizing', 'branch-removed', resourceLocks
  );
  if (runBranchCleanup.run) {
    if (shouldRemoveWorktree && shouldDeleteBranch) {
      stageBranchRemoval(config, effectiveBranch, targetDigest, permits, runBranchCleanup.recovering);
    }
  } else if (shouldRemoveWorktree && shouldDeleteBranch
    && runOk('git', ['-C', config.repoRoot, 'show-ref', '--verify', `refs/heads/${effectiveBranch}`])) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${effectiveBranch}`);
  }
  advanceRemovalJournals(config.project, target, targetDigest, 'branch-removed', resourceLocks);
  cleanupCompletedRemovalArtifacts(config, target, committedTarget, targetDigest);

  const runToolCleanup = prepareRemovalAction(
    config.project, target, targetDigest, 'tool-finalizing', 'tool-removed', resourceLocks
  );
  if (runToolCleanup.run) {
    for (const { tool, candidates } of toolCandidates) {
      for (const dir of candidates.filter((candidate) => fs.existsSync(candidate))) {
        stageManagedRemoval(
          tool.sandboxBase,
          dir,
          removalTombstonePath(targetDigest, 'tool', dir),
          runToolCleanup.recovering,
          {
            version: 1,
            targetDigest,
            permitDigest: committedTarget.permitDigest,
            kind: 'tool',
            source: dir
          }
        );
        p.log.success(`${tool.name} state removed: ${dir}`);
      }
    }
  } else {
    assertRemovalPathsAbsent(removalActionPaths(target, config, 'tool-removed'));
  }
  advanceRemovalJournals(config.project, target, targetDigest, 'tool-removed', resourceLocks);
  cleanupCompletedRemovalArtifacts(config, target, committedTarget, targetDigest);

  const runShellCleanup = prepareRemovalAction(
    config.project, target, targetDigest, 'shell-finalizing', 'shell-removed', resourceLocks
  );
  if (runShellCleanup.run) {
    for (const dir of shellConfigDirCandidates(config, effectiveBranch).filter((candidate) => fs.existsSync(candidate))) {
      stageManagedRemoval(
        config.shellConfigBase,
        dir,
        removalTombstonePath(targetDigest, 'shell', dir),
        runShellCleanup.recovering,
        {
          version: 1,
          targetDigest,
          permitDigest: committedTarget.permitDigest,
          kind: 'shell',
          source: dir
        }
      );
      p.log.success(`Shell config removed: ${dir}`);
    }
  } else {
    assertRemovalPathsAbsent(removalActionPaths(target, config, 'shell-removed'));
  }
  advanceRemovalJournals(config.project, target, targetDigest, 'shell-removed', resourceLocks);
  cleanupCompletedRemovalArtifacts(config, target, committedTarget, targetDigest);

  const runShareCleanup = prepareRemovalAction(
    config.project, target, targetDigest, 'share-finalizing', 'share-removed', resourceLocks
  );
  if (runShareCleanup.run) {
    if (shouldRemoveShare && fs.existsSync(sharePath)) {
      stageManagedRemoval(
        config.shareBase,
        sharePath,
        removalTombstonePath(targetDigest, 'share', sharePath),
        runShareCleanup.recovering,
        {
          version: 1,
          targetDigest,
          permitDigest: committedTarget.permitDigest,
          kind: 'share',
          source: sharePath
        }
      );
      p.log.success(`Share dir removed: ${sharePath}`);
    }
  } else if (shouldRemoveShare) {
    assertRemovalPathsAbsent(removalActionPaths(target, config, 'share-removed'));
  }
  advanceRemovalJournals(config.project, target, targetDigest, 'share-removed', resourceLocks);
  cleanupCompletedRemovalArtifacts(config, target, committedTarget, targetDigest);

  const completedJournals = advanceRemovalJournals(config.project, target, targetDigest, 'completed', resourceLocks);
  for (const journal of completedJournals) clearSandboxRemovalJournalRecord(journal);

  if (!options.quiet) {
    p.outro(pc.green('Sandbox removed'));
  }
  } finally {
    for (const lock of [...resourceLocks.values()].reverse()) lock.release();
  }
}

async function rmPurge(
  config: SandboxConfig,
  tools: SandboxTool[],
  prompt: PromptDependencies = {}
): Promise<void> {
  const engine = detectEngine(config);
  const confirm = prompt.confirm ?? p.confirm;
  const isCancel = prompt.isCancel ?? p.isCancel;
  p.intro(pc.cyan(`Removing all sandboxes for ${config.project}`));

  const worktrees = fs.existsSync(config.worktreeBase)
    ? fs.readdirSync(config.worktreeBase)
        .map((entry) => path.join(config.worktreeBase, entry))
        .filter((entry) => {
          try { return fs.statSync(entry).isDirectory(); } catch { return false; }
        })
    : [];
  const inspections = inspectWorktrees(worktrees);
  const blockers = inspectionBlockers(inspections);
  if (blockers.length > 0) {
    throw new Error(`Refusing to purge because worktree preflight found blocker(s):\n${blockerMessage(blockers)}`);
  }
  const permits = cleanPermits(inspections);

  const coordinatedContainers = await removeProjectControlRoots(config, engine);

  const containers = runEngine(engine, 'docker', [
    'ps',
    '-a',
    '--filter',
    `label=${sandboxLabel(config)}`,
    '--format',
    '{{.Names}}'
  ]);
  const uncoordinatedContainers = containers.split('\n').filter((name) => name && !coordinatedContainers.has(name));
  if (uncoordinatedContainers.length > 0) {
    const spinner = p.spinner();
    spinner.start('Stopping project sandbox containers...');
    for (const name of uncoordinatedContainers) {
      if (!runOkEngine(engine, 'docker', ['stop', name])) throw new Error(`Failed to stop sandbox container: ${name}`);
      if (!runOkEngine(engine, 'docker', ['rm', name])) throw new Error(`Failed to remove sandbox container: ${name}`);
    }
    const remaining = runEngine(engine, 'docker', [
      'ps', '-a', '--filter', `label=${sandboxLabel(config)}`, '--format', '{{.Names}}'
    ]);
    const leftovers = remaining.split('\n').filter((name) => name && !coordinatedContainers.has(name));
    if (leftovers.length > 0) throw new Error(`Project sandbox container(s) still exist after removal: ${leftovers.join(', ')}`);
    spinner.stop(pc.green('Project sandbox containers removed'));
  } else {
    p.log.warn('No project sandbox containers found');
  }

  if (worktrees.length > 0) {
    const shouldRemoveWorktrees = await confirm({
      message: `Remove all worktrees in ${config.worktreeBase}?`,
      initialValue: true
    });

    if (!isCancel(shouldRemoveWorktrees) && shouldRemoveWorktrees) {
      for (const dir of worktrees) {
        const permit = permits.get(path.resolve(dir));
        if (!permit) throw new Error(`Missing worktree removal permit: ${dir}`);
        removeWorktreeDir(config.repoRoot, config.worktreeBase, dir, permit, {
          allowRegisteredPathFallback: engine === ENGINES.WSL2
        });
        assertRemoved(dir, 'Worktree');
      }
      runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
      const registered = new Set(runSafe('git', ['-C', config.repoRoot, 'worktree', 'list', '--porcelain'])
        .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => path.resolve(line.slice(9))));
      const leftovers = worktrees.filter((dir) => registered.has(path.resolve(dir)));
      if (leftovers.length > 0) throw new Error(`Worktree(s) still registered after removal: ${leftovers.join(', ')}`);
    }
  }

  for (const dir of projectToolDirs(config, tools)) {
    if (fs.existsSync(dir)) {
      removeManagedDir(path.dirname(dir), dir);
      assertRemoved(dir, 'Tool state');
      p.log.success(`Removed tool state: ${dir}`);
    }
  }

  if (fs.existsSync(config.shellConfigBase) && fs.readdirSync(config.shellConfigBase).length > 0) {
    const shouldRemoveShellConfigs = await confirm({
      message: `Remove all shell config dirs in ${config.shellConfigBase}?`,
      initialValue: true
    });

    if (!isCancel(shouldRemoveShellConfigs) && shouldRemoveShellConfigs) {
      for (const entry of fs.readdirSync(config.shellConfigBase)) {
        const dir = path.join(config.shellConfigBase, entry);
        removeManagedDir(config.shellConfigBase, dir);
        assertRemoved(dir, 'Shell config');
      }
      p.log.success(`Project shell config dirs removed: ${config.shellConfigBase}`);
    }
  }

  if (fs.existsSync(config.shareBase) && fs.readdirSync(config.shareBase).length > 0) {
    const shouldRemoveAllShares = await confirm({
      message: `Remove all share dirs for project (${config.shareBase})?`,
      initialValue: true
    });
    if (!isCancel(shouldRemoveAllShares) && shouldRemoveAllShares) {
      removeManagedDir(path.dirname(config.shareBase), config.shareBase);
      assertRemoved(config.shareBase, 'Project share dir');
      p.log.success(`Project share dirs removed: ${config.shareBase}`);
    }
  }

  for (const [base, label] of [
    [config.workspaceViewBase, 'workspace views'],
    [config.controlBase, 'control channels']
  ] as const) {
    const projectDir = path.join(base, config.project);
    if (fs.existsSync(projectDir)) {
      removeManagedDir(base, projectDir);
      assertRemoved(projectDir, `Project ${label}`);
      p.log.success(`Removed project ${label}: ${projectDir}`);
    }
  }

  const shouldRemoveImage = await confirm({
    message: `Remove image ${config.imageName}?`,
    initialValue: false
  });
  if (!isCancel(shouldRemoveImage) && shouldRemoveImage) {
    runSafeEngine(engine, 'docker', ['rmi', config.imageName]);
  }

  pruneSandboxDanglingImages(config, engine);

  if (isManagedEngine(engine)) {
    if (engine === ENGINES.WSL2) {
      p.log.warn('Windows uses Docker Desktop with WSL2. Stop it from Docker Desktop or run "wsl --shutdown" manually.');
      p.outro(pc.green('All project sandboxes removed'));
      return;
    }

    const name = engineDisplayName(engine);
    const shouldStopVm = await confirm({
      message: `Stop ${name} VM?`,
      initialValue: false
    });
    if (!isCancel(shouldStopVm) && shouldStopVm) {
      stopManagedVm(config);
    }
  }

  p.outro(pc.green('All project sandboxes removed'));
}

async function rmUnbound(
  config: SandboxConfig,
  tools: SandboxTool[],
  options: { dryRun: boolean; assumeYes: boolean }
): Promise<void> {
  const engine = detectEngine(config);
  const { running, nonRunning } = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config),
    { mode: sandboxWorkspaceModeLabel(config), taskId: sandboxTaskIdLabel(config) }
  );
  const rows = [...running, ...nonRunning];

  p.intro(pc.cyan(`Removing sandboxes not bound to an active task for ${config.project}`));

  if (rows.length === 0) {
    p.outro('No removable sandboxes: every container is bound to an active task (or none exist)');
    return;
  }

  const candidates: CleanupCandidate[] = rows.map((row) => {
    if (!row.branch || !row.workspaceMode || row.workspaceMode === 'legacy-invalid') {
      throw new Error(`SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: container '${row.name}' has incomplete workspace identity`);
    }
    if (row.workspaceMode === 'task-bound') {
      if (!row.taskId) {
        throw new Error(`SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: container '${row.name}' has no task id`);
      }
      const cleanupTarget = resolveSandboxCleanupTarget(row.taskId, config.repoRoot, { allowProtected: true });
      if (cleanupTarget.branch !== row.branch
        || cleanupTarget.workspace.mode !== 'task-bound'
        || cleanupTarget.workspace.taskId !== row.taskId) {
        throw new Error(`SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: container '${row.name}' task identity conflicts with task.md`);
      }
      return { row, cleanupTarget };
    }
    return {
      row,
      cleanupTarget: {
        requestedRef: row.branch,
        branch: row.branch,
        workspace: { mode: 'branch-only' },
        taskState: 'branch-only'
      } satisfies SandboxCleanupTarget
    };
  });
  const branchIdentities = new Map<string, string>();
  const groupedCandidates = new Map<string, CleanupCandidate[]>();
  for (const candidate of candidates) {
    const identity = candidate.cleanupTarget.workspace.mode === 'task-bound'
      ? `task-bound:${candidate.cleanupTarget.workspace.taskId}`
      : 'branch-only';
    const existingIdentity = branchIdentities.get(candidate.cleanupTarget.branch);
    if (existingIdentity && existingIdentity !== identity) {
      throw new Error(
        `SANDBOX_CLEANUP_BATCH_PREFLIGHT_FAILED: branch '${candidate.cleanupTarget.branch}' has conflicting workspace identities`
      );
    }
    branchIdentities.set(candidate.cleanupTarget.branch, identity);
    const groupKey = `${candidate.cleanupTarget.branch}\0${identity}`;
    const group = groupedCandidates.get(groupKey) ?? [];
    group.push(candidate);
    groupedCandidates.set(groupKey, group);
  }
  const groups: CleanupGroup[] = [...groupedCandidates.values()].map((groupCandidates) => {
    const cleanupTarget = groupCandidates[0]!.cleanupTarget;
    const target = resolveRmTarget(config, tools, cleanupTarget, {
      discoveredContainers: groupCandidates.map(({ row }) => row.name)
    });
    preflightRmTarget(config, target);
    return { candidates: groupCandidates, cleanupTarget, target };
  });
  assertCleanupGroupPathsDoNotOverlap(groups);

  const removableGroups = groups.filter(({ cleanupTarget }) =>
    cleanupTarget.taskState === 'completed' || cleanupTarget.taskState === 'branch-only'
  );
  const removable = removableGroups.flatMap(({ candidates: groupCandidates }) => groupCandidates);
  for (const { candidates: groupCandidates, cleanupTarget } of groups.filter(({ cleanupTarget }) =>
    cleanupTarget.taskState !== 'completed' && cleanupTarget.taskState !== 'branch-only'
  )) {
    for (const { row } of groupCandidates) {
      p.log.message(`Skipped protected sandbox ${row.name} (${cleanupTarget.taskState})`);
    }
  }

  if (removableGroups.length === 0) {
    p.outro('No removable sandboxes: every container is bound to a protected task (or none exist)');
    return;
  }

  const inspections = inspectWorktrees(removableGroups.flatMap(({ target }) => target.existingWorktrees));
  assertWorktreeBranchesMatchGroups(removableGroups, inspections);
  const blockers = inspectionBlockers(inspections);
  const permits = cleanPermits(inspections);

  for (const { row } of removable) {
    p.log.message(`${row.name}  ${row.branch}`);
  }
  if (blockers.length > 0) p.log.error(blockerMessage(blockers));

  if (options.dryRun) {
    p.outro(`Dry run: ${removable.length} sandbox(es) inspected, nothing deleted`);
    return;
  }

  if (blockers.length > 0) {
    throw new Error(`Refusing batch removal because worktree preflight found blocker(s):\n${blockerMessage(blockers)}`);
  }

  if (!options.assumeYes && !process.stdin.isTTY) {
    throw new Error(
      'Refusing to remove sandboxes without confirmation in a non-interactive shell; pass --yes to proceed.'
    );
  }

  const failures: { branch: string; message: string }[] = [];
  let failedRows = 0;
  for (const group of removableGroups) {
    try {
      await rmOne(config, tools, group.cleanupTarget.branch, {
        assumeYes: options.assumeYes,
        quiet: true,
        target: group.target,
        cleanupTarget: group.cleanupTarget,
        permits,
        allowDirtyDiscard: false
      });
    } catch (error) {
      failedRows += group.candidates.length;
      failures.push({ branch: group.cleanupTarget.branch, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      p.log.error(`Failed to remove '${failure.branch}': ${failure.message}`);
    }
    throw new Error(
      `Removed ${removable.length - failedRows}/${removable.length} sandbox(es); ${failures.length} failed`
    );
  }

  p.outro(pc.green(`Removed ${removable.length} sandbox(es)`));
}

export async function rm(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      all: { type: 'boolean' },
      unbound: { type: 'boolean' },
      purge: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.all) {
    throw new Error('CLI_FLAG_REMOVED: --all was removed; use --unbound');
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (values.unbound && values.purge) {
    throw new Error('--unbound and --purge are mutually exclusive');
  }

  if ((values['dry-run'] || values.yes) && !values.unbound) {
    throw new Error('--dry-run and --yes only apply to --unbound');
  }

  if ((values.unbound || values.purge) && positionals.length > 0) {
    throw new Error(`${values.unbound ? '--unbound' : '--purge'} does not take a branch argument`);
  }

  if (!values.unbound && !values.purge && positionals.length !== 1) {
    throw new Error(USAGE);
  }

  const config = loadConfig();
  const tools = [...createSandboxCapabilityPlan(config).cleanupInventory];

  if (values.purge) {
    await rmPurge(config, tools);
    return;
  }

  if (values.unbound) {
    await rmUnbound(config, tools, {
      dryRun: Boolean(values['dry-run']),
      assumeYes: Boolean(values.yes)
    });
    return;
  }

  const cleanupTarget = resolveSandboxCleanupTarget(positionals[0] ?? '', config.repoRoot);
  await rmOne(config, tools, cleanupTarget.branch, { cleanupTarget });
}

export { authorizeWorktrees, rmOne, rmPurge };
