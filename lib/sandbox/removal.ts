import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { SandboxConfig } from './config.ts';
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
} from './constants.ts';
import { ENGINES, detectEngine, engineDisplayName, isManagedEngine, stopManagedVm } from './engine.ts';
import { pruneSandboxDanglingImages } from './image-prune.ts';
import { assertManagedPath, removeManagedDir, removeWorktreeDir } from './managed-fs.ts';
import { run, runEngine, runOk, runOkEngine, runSafe, runSafeEngine } from './shell.ts';
import {
  parseSandboxWorkspaceIdentity,
  resolveSandboxCleanupTarget,
  sameSandboxWorkspaceIdentity,
  type SandboxCleanupTarget,
  type SandboxWorkspaceKey
} from './workspace-identity.ts';
import { sandboxControlPaths, sandboxWorkspaceViewPaths } from './workspace-view.ts';
import {
  advanceSandboxRemovalJournalToPhase,
  advanceSandboxRemovalJournalPhase,
  claimSandboxRemovalJournal,
  clearSandboxRemovalJournalRecord,
  isDefaultSandboxRemovalJournal,
  listSandboxRemovalJournals,
  removeSandboxControlRoot,
  readSandboxControlManifest,
  sandboxRemovalPhaseIndex,
  type SandboxRemovalJournal,
  type SandboxRemovalTargetCommit
} from './control/lifecycle.ts';
import { inspectSandboxControlContainer } from './control/container-identity.ts';
import { commandForSandboxAuthority } from './engines/authority.ts';
import { acquireSandboxResourceLock, type SandboxResourceLock } from './control/native-file-lock.ts';
import { toolConfigDirCandidates, toolProjectDirCandidates } from './tools.ts';
import type { SandboxTool } from './tools.ts';
import { getProcessStartTime } from '../server/process-state.ts';
import { releaseStaleShortIdRegistry } from '../task/short-id.ts';
import { fetchSandboxRows, type SandboxRow } from './commands/list-running.ts';
import {
  formatIntermediateCleanupReport,
  cleanupIntermediateUnderRemovalCoordinator,
  protectIntermediateCleanupReport,
  mergeIntermediateCleanupReports,
  type IntermediateCleanupReport,
  scanIntermediateCleanup
} from '../task/intermediate-cleanup.ts';
import { createSandboxControlBindingEvidence } from './task-cleanup.ts';
import {
  createCleanPermit,
  createDiscardPermit,
  formatWorktreeSnapshot,
  inspectRecoveredWorktree,
  inspectWorktrees,
  verifyWorktreePermit
} from './worktree-safety.ts';
import type {
  WorktreeInspection,
  WorktreeRecoveryContext,
  WorktreeRemovalPermit
} from './worktree-safety.ts';

function projectToolDirs(config: SandboxConfig, tools: SandboxTool[]): string[] {
  return tools.flatMap((tool) => toolProjectDirCandidates(tool, config.project));
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT');
}

function canonicalPath(input: string): string {
  try { return fs.realpathSync.native(input); }
  catch { return path.resolve(input); }
}

function isMissingTaskRecordError(error: unknown): boolean {
  return error instanceof Error && /^Task not found: TASK-\d{8}-\d{6}$/.test(error.message);
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
  return listSandboxRemovalJournals({ branch: target.effectiveBranch, project, targetDigest }).map((journal) => {
    if (sandboxRemovalPhaseIndex(journal.phase) >= sandboxRemovalPhaseIndex(phase)) return journal;
    const lock = resourceLocks.get(journal.target.controlRoot);
    if (!lock) throw new Error('SANDBOX_CONTROL_REMOVAL_LOCK_MISMATCH');
    return advanceSandboxRemovalJournalToPhase(journal, phase, lock);
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

type RemovalSourceIdentity = Readonly<{
  dev: string;
  ino: string;
}>;

type RemovalTombstoneRecord = RemovalTombstoneOwnership & Readonly<{
  sourceIdentity: RemovalSourceIdentity;
}>;

const REMOVAL_TOMBSTONE_MARKER = '.agent-infra-removal-ownership.json';
const REMOVAL_TOMBSTONE_PAYLOAD = 'payload';

function removalSourceClaimPath(source: string, ownership: RemovalTombstoneOwnership): string {
  const claimDigest = createHash('sha256')
    .update(JSON.stringify(ownership))
    .digest('hex')
    .slice(0, 24);
  return path.join(source, `.agent-infra-removal-source-${claimDigest}.json`);
}

function removalSourceIdentity(source: string): RemovalSourceIdentity {
  const stat = fs.lstatSync(source, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev === 0n || stat.ino === 0n) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameRemovalSourceIdentity(left: RemovalSourceIdentity, right: RemovalSourceIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removalSourceClaimMatches(
  source: string,
  ownership: RemovalTombstoneOwnership,
  identity: RemovalSourceIdentity
): boolean {
  try {
    const claimPath = removalSourceClaimPath(source, ownership);
    const claimStat = fs.lstatSync(claimPath);
    if (!claimStat.isFile() || claimStat.isSymbolicLink()) return false;
    const record = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as Partial<RemovalTombstoneRecord>;
    return record.version === ownership.version
      && record.targetDigest === ownership.targetDigest
      && record.permitDigest === ownership.permitDigest
      && record.kind === ownership.kind
      && typeof record.source === 'string'
      && path.resolve(record.source) === path.resolve(ownership.source)
      && record.sourceIdentity?.dev === identity.dev
      && record.sourceIdentity?.ino === identity.ino;
  } catch {
    return false;
  }
}

function isOwnedRemovalSourceClaim(source: string, ownership: RemovalTombstoneOwnership): boolean {
  try {
    const claimPath = removalSourceClaimPath(source, ownership);
    const claimStat = fs.lstatSync(claimPath);
    if (!claimStat.isFile() || claimStat.isSymbolicLink()) return false;
    const record = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as Partial<RemovalTombstoneRecord>;
    return record.version === ownership.version
      && record.targetDigest === ownership.targetDigest
      && record.permitDigest === ownership.permitDigest
      && record.kind === ownership.kind
      && typeof record.source === 'string'
      && path.resolve(record.source) === path.resolve(ownership.source);
  } catch {
    return false;
  }
}

function removeOwnedSourceClaim(source: string, ownership: RemovalTombstoneOwnership): void {
  try {
    const claimPath = removalSourceClaimPath(source, ownership);
    if (isOwnedRemovalSourceClaim(source, ownership)) fs.unlinkSync(claimPath);
  } catch {
    // Preserve the source when the claim cannot be revalidated.
  }
}

function readRemovalTombstoneRecord(root: string, tombstone: string): RemovalTombstoneRecord | null {
  assertManagedPath(root, tombstone);
  try {
    const tombstoneStat = fs.lstatSync(tombstone);
    const markerStat = fs.lstatSync(removalTombstoneMarker(tombstone));
    if (!tombstoneStat.isDirectory() || tombstoneStat.isSymbolicLink()
      || !markerStat.isFile() || markerStat.isSymbolicLink()) return null;
    const record = JSON.parse(fs.readFileSync(removalTombstoneMarker(tombstone), 'utf8')) as Partial<RemovalTombstoneRecord>;
    if (record.version !== 1
      || typeof record.targetDigest !== 'string'
      || typeof record.permitDigest !== 'string'
      || typeof record.kind !== 'string'
      || typeof record.source !== 'string'
      || record.sourceIdentity?.dev === undefined
      || record.sourceIdentity.ino === undefined) return null;
    return record as RemovalTombstoneRecord;
  } catch {
    return null;
  }
}

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
  const record = readRemovalTombstoneRecord(root, tombstone);
  return record !== null
    && record.version === 1
      && record.targetDigest === ownership.targetDigest
      && record.permitDigest === ownership.permitDigest
      && record.kind === ownership.kind
      && typeof record.source === 'string'
      && path.resolve(record.source) === path.resolve(ownership.source);
}

function isOwnedRemovalPayload(
  root: string,
  tombstone: string,
  ownership: RemovalTombstoneOwnership
): boolean {
  const record = readRemovalTombstoneRecord(root, tombstone);
  if (!record || record.targetDigest !== ownership.targetDigest
    || record.permitDigest !== ownership.permitDigest
    || record.kind !== ownership.kind
    || path.resolve(record.source) !== path.resolve(ownership.source)) return false;
  try {
    const payload = removalTombstonePayload(tombstone);
    const payloadIdentity = removalSourceIdentity(payload);
    return sameRemovalSourceIdentity(payloadIdentity, record.sourceIdentity)
      && removalSourceClaimMatches(payload, ownership, record.sourceIdentity);
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

function shouldStageManagedRemoval(source: string, tombstone: string, recovering: boolean): boolean {
  return fs.existsSync(source) || (recovering && fs.existsSync(tombstone));
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
    if (recovering) {
      if (!isOwnedRemovalPayload(root, tombstone, ownership)) {
        throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
      }
      return;
    }
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
  }
  if (recovering) {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_ACTION_OUTCOME_UNKNOWN: ${source}`);
  }
  if (!sourceExists) return;
  // The operator authorizes cleanup of this managed target after execution stops.
  // Path checks detect conflicts; they do not provide an atomic source-instance move.
  const expectedIdentity = removalSourceIdentity(source);
  const claimPath = removalSourceClaimPath(source, ownership);
  try {
    fs.writeFileSync(claimPath, `${JSON.stringify({ ...ownership, sourceIdentity: expectedIdentity })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
  } catch {
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
  }
  if (!sameRemovalSourceIdentity(expectedIdentity, removalSourceIdentity(source))) {
    removeOwnedSourceClaim(source, ownership);
    throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
  }
  let moved = false;
  try {
    fs.mkdirSync(tombstone, { mode: 0o700 });
    fs.writeFileSync(removalTombstoneMarker(tombstone), `${JSON.stringify({ ...ownership, sourceIdentity: expectedIdentity })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    fs.renameSync(source, removalTombstonePayload(tombstone));
    moved = true;
    if (!isOwnedRemovalPayload(root, tombstone, ownership)) {
      throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
    }
  } catch (error) {
    if (!moved) removeOwnedSourceClaim(source, ownership);
    throw error;
  }
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
    if (!fs.existsSync(tombstone)) continue;
    const ownership = { version: 1, targetDigest, permitDigest, kind, source } as const;
    if (!isOwnedRemovalTombstone(root, tombstone, ownership)) continue;
    if (!isOwnedRemovalPayload(root, tombstone, ownership)) {
      throw new Error(`SANDBOX_CONTROL_REMOVAL_TARGET_MISMATCH: ${source}`);
    }
    removeManagedDir(root, tombstone);
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

type RemovalResourceKind = 'control-root' | 'workspace-view' | 'worktree' | 'branch' | 'tool' | 'shell' | 'share' | 'artifact' | 'intent';

export type SandboxRemovalResource = Readonly<{
  kind: RemovalResourceKind;
  path: string;
}>;

export type SandboxRemovalResourceDisclosure = Readonly<{
  remove: readonly SandboxRemovalResource[];
  preserve: readonly SandboxRemovalResource[];
}>;

type RemovalDisclosureTarget = Readonly<Pick<
  RmTarget,
  'branch' | 'effectiveBranch' | 'existingWorktrees' | 'toolCandidates' | 'controlRoots' | 'workspaceViewRoots'
>>;

type RemovalSelection = Pick<SandboxRemovalTargetCommit, 'removeWorktree' | 'removeBranch' | 'removeShare'>;

type RemovalActionKind = 'workspace' | 'worktree' | 'tool' | 'shell' | 'share';

type RemovalActionPreparation = Readonly<{
  run: boolean;
  recovering: boolean;
}>;

type CleanupCandidate = Readonly<{
  row: SandboxRow;
  cleanupTarget: SandboxCleanupTarget;
}>;

type ProtectedCleanupCandidate = Readonly<{
  row: SandboxRow;
  branch: string;
  identity: string;
  reason: string;
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
    ? [...options.discoveredContainers]
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

function assertRemoved(target: string, label: string): void {
  if (fs.existsSync(target)) throw new Error(`${label} still exists after removal: ${target}`);
}

function sandboxContainersRemoved(engine: string, containers: readonly string[]): boolean {
  if (containers.length === 0) return true;
  const remaining = new Set(runEngine(engine, 'docker', ['ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .filter(Boolean));
  return containers.every((container) => !remaining.has(container));
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
      message: 'Discard this worktree and all its uncommitted changes, including later changes?',
      initialValue: false
    });
    if (isCancel(confirmed) || !confirmed) throw new Error('Dirty worktree removal cancelled; nothing was deleted');
    permits.set(inspection.snapshot.worktree, createDiscardPermit(inspection.snapshot));
  }
  return permits;
}

async function runRmOneUnderRepositoryLock(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<IntermediateCleanupReport | null> {
  const target = options.target ?? resolveRmTarget(
    config,
    tools,
    options.cleanupTarget ?? resolveSandboxCleanupTarget(branch, config.repoRoot)
  );
  return rmOneCore(config, tools, branch, { ...options, target });
}

async function rmOne(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<void> {
  await runRmOneUnderRepositoryLock(config, tools, branch, options);
}

async function removeUncheckedSandbox(
  config: SandboxConfig,
  target: RmTarget,
  options: RmOneOptions
): Promise<null> {
  const confirm = options.prompt?.confirm ?? p.confirm;
  const isCancel = options.prompt?.isCancel ?? p.isCancel;
  const { effectiveBranch, engine, matchedContainers, existingWorktrees, toolCandidates, controlRoots, workspaceViewRoots } = target;

  if (!options.quiet) p.intro(pc.cyan(`Removing sandbox for ${target.branch}`));

  const shouldRemoveWorktree = existingWorktrees.length > 0 && !options.assumeYes
    ? await confirm({ message: `Remove worktree(s): ${existingWorktrees.join(', ')}?`, initialValue: true })
    : existingWorktrees.length > 0;
  if (isCancel(shouldRemoveWorktree)) {
    if (!options.quiet) p.outro('Cancelled');
    return null;
  }

  const shouldDeleteBranch = Boolean(shouldRemoveWorktree) && existingWorktrees.length > 0 && !options.assumeYes
    ? await confirm({ message: `Also delete local branch '${effectiveBranch}'?`, initialValue: true })
    : Boolean(shouldRemoveWorktree) && existingWorktrees.length > 0;
  if (isCancel(shouldDeleteBranch)) {
    if (!options.quiet) p.outro('Cancelled');
    return null;
  }

  const sharePath = path.resolve(shareBranchDir(config, effectiveBranch));
  const shouldRemoveShare = fs.existsSync(sharePath) && !options.assumeYes
    ? await confirm({ message: `Remove share dir for branch '${effectiveBranch}' (${sharePath})?`, initialValue: true })
    : fs.existsSync(sharePath);
  if (isCancel(shouldRemoveShare)) {
    if (!options.quiet) p.outro('Cancelled');
    return null;
  }

  for (const container of matchedContainers) runSafeEngine(engine, 'docker', ['rm', '-f', container]);
  for (const root of controlRoots) {
    fs.rmSync(root, { recursive: true, force: true });
    removeEmptyManagedParent(path.join(config.controlBase, config.project), root);
  }
  for (const root of workspaceViewRoots) {
    fs.rmSync(root, { recursive: true, force: true });
    removeEmptyManagedParent(path.join(config.workspaceViewBase, config.project), root);
  }
  for (const candidate of toolCandidates.flatMap(({ candidates }) => candidates)) fs.rmSync(candidate, { recursive: true, force: true });
  for (const shell of shellConfigDirCandidates(config, effectiveBranch)) fs.rmSync(shell, { recursive: true, force: true });
  if (shouldRemoveShare) fs.rmSync(sharePath, { recursive: true, force: true });
  if (shouldRemoveWorktree) {
    for (const worktree of existingWorktrees) fs.rmSync(worktree, { recursive: true, force: true });
    runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
  }
  if (shouldDeleteBranch) runSafe('git', ['-C', config.repoRoot, 'branch', '-D', effectiveBranch]);
  if (!sandboxContainersRemoved(engine, matchedContainers)) {
    throw new Error(`SANDBOX_REMOVAL_CONTAINER_STILL_PRESENT: ${matchedContainers.join(', ')}`);
  }
  if (target.workspace.mode === 'task-bound') {
    releaseStaleShortIdRegistry(config.repoRoot, target.workspace.taskId);
  }

  if (!options.quiet) p.outro('Sandbox removed');
  return null;
}

async function rmOneCore(
  config: SandboxConfig,
  tools: SandboxTool[],
  branch: string,
  options: RmOneOptions = {}
): Promise<IntermediateCleanupReport | null> {
  const target = options.target ?? resolveRmTarget(
    config,
    tools,
    options.cleanupTarget ?? resolveSandboxCleanupTarget(branch, config.repoRoot)
  );
  return removeUncheckedSandbox(config, target, options);
}

async function rmPurge(
  config: SandboxConfig,
  tools: SandboxTool[],
  prompt: PromptDependencies = {}
): Promise<void> {
  return rmPurgeCore(config, tools, prompt);
}

async function rmPurgeCore(
  config: SandboxConfig,
  tools: SandboxTool[],
  prompt: PromptDependencies = {}
): Promise<void> {
  const engine = detectEngine(config);
  const confirm = prompt.confirm ?? p.confirm;
  const isCancel = prompt.isCancel ?? p.isCancel;
  p.intro(pc.cyan(`Removing all sandboxes for ${config.project}`));

  const containers = runEngine(engine, 'docker', [
    'ps', '-a', '--filter', `label=${sandboxLabel(config)}`, '--format', '{{.Names}}'
  ]).split('\n').filter(Boolean);
  for (const name of containers) runSafeEngine(engine, 'docker', ['rm', '-f', name]);

  const worktrees = fs.existsSync(config.worktreeBase)
    ? fs.readdirSync(config.worktreeBase).map((entry) => path.join(config.worktreeBase, entry))
    : [];
  if (worktrees.length > 0) {
    const selected = await confirm({ message: `Remove all worktrees in ${config.worktreeBase}?`, initialValue: true });
    if (!isCancel(selected) && selected) {
      for (const worktree of worktrees) fs.rmSync(worktree, { recursive: true, force: true });
      runSafe('git', ['-C', config.repoRoot, 'worktree', 'prune']);
    }
  }

  for (const dir of projectToolDirs(config, tools)) fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(config.shellConfigBase)) {
    const selected = await confirm({ message: `Remove all shell config dirs in ${config.shellConfigBase}?`, initialValue: true });
    if (!isCancel(selected) && selected) fs.rmSync(config.shellConfigBase, { recursive: true, force: true });
  }
  if (fs.existsSync(config.shareBase)) {
    const selected = await confirm({ message: `Remove all share dirs for project (${config.shareBase})?`, initialValue: true });
    if (!isCancel(selected) && selected) fs.rmSync(config.shareBase, { recursive: true, force: true });
  }
  for (const base of [config.workspaceViewBase, config.controlBase]) {
    fs.rmSync(path.join(base, config.project), { recursive: true, force: true });
  }
  const removeImage = await confirm({ message: `Remove image ${config.imageName}?`, initialValue: false });
  if (!isCancel(removeImage) && removeImage) runSafeEngine(engine, 'docker', ['rmi', config.imageName]);
  p.outro(pc.green('All project sandboxes removed'));
}

async function rmUnbound(
  config: SandboxConfig,
  tools: SandboxTool[],
  options: { dryRun: boolean; assumeYes: boolean }
): Promise<void> {
  return rmUnboundCore(config, tools, options);
}

async function rmUnboundCore(
  config: SandboxConfig,
  tools: SandboxTool[],
  options: { dryRun: boolean; assumeYes: boolean }
): Promise<void> {
  const engine = detectEngine(config);
  const listed = fetchSandboxRows(
    engine,
    sandboxLabel(config),
    sandboxBranchLabel(config),
    { mode: sandboxWorkspaceModeLabel(config), taskId: sandboxTaskIdLabel(config) }
  );
  const rows = [...listed.running, ...listed.nonRunning];
  p.intro(pc.cyan(`Removing sandboxes for ${config.project}`));
  if (options.dryRun) {
    p.outro(`Dry run: ${rows.length} sandbox(es) found, nothing deleted`);
    return;
  }
  for (const row of rows) {
    if (!row.branch) {
      runSafeEngine(engine, 'docker', ['rm', '-f', row.name]);
      continue;
    }
    const cleanupTarget: SandboxCleanupTarget = {
      requestedRef: row.branch,
      branch: row.branch,
      workspace: row.workspaceMode === 'task-bound' && row.taskId
        ? { mode: 'task-bound', taskId: row.taskId }
        : { mode: 'branch-only' },
      taskState: 'branch-only'
    };
    const target = resolveRmTarget(config, tools, cleanupTarget, { discoveredContainers: [row.name] });
    await rmOne(config, tools, cleanupTarget.branch, {
      assumeYes: options.assumeYes,
      target,
      cleanupTarget
    });
  }
  p.outro(pc.green(`Removed ${rows.length} sandbox(es)`));
}
export { authorizeWorktrees, rmOne, rmPurge, rmUnbound };
