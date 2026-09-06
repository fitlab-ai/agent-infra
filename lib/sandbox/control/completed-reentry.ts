import fs from 'node:fs';
import path from 'node:path';
import { resolveTaskWorkspace } from '../task-resolver.ts';
import { assertGitWorktreeBinding } from '../../git/worktree-identity.ts';
import { parseTypedTaskFrontmatter } from '../../task/frontmatter.ts';
import { readTaskFinalizationReceipt } from '../../task/finalization.ts';
import { inspectSandboxControlContainer } from './container-identity.ts';
import type { SandboxControlManifest } from './protocol.ts';
import { atomicWriteJson, readSandboxControlStatus } from './state.ts';
import { taskViewForManifest, type SandboxTaskView } from './task-view.ts';

type ReentryEvidence = Readonly<{
  taskId: string;
  generation: string;
  containerId: string;
  branch: string;
  worktreeRoot: string;
  source: string;
  sourceDevice: string;
  sourceInode: string;
  receipt: NonNullable<SandboxTaskView['receipt']>;
}>;

function evidencePath(manifest: SandboxControlManifest): string {
  return path.join(path.dirname(manifest.processingDir), 'completed-reentry.json');
}

function invalid(): Error {
  return new Error('SANDBOX_COMPLETED_REENTRY_EVIDENCE_INVALID');
}

export async function prepareCompletedReentry(
  manifest: SandboxControlManifest,
  inspect: typeof inspectSandboxControlContainer = inspectSandboxControlContainer
): Promise<ReentryEvidence> {
  if (manifest.mode !== 'task-bound' || !manifest.taskId) throw invalid();
  assertGitWorktreeBinding(manifest.repoRoot, manifest.worktreeRoot, manifest.branch);
  const container = await inspect(manifest);
  if (container.state !== 'found' || container.id !== manifest.containerIdentity.id) throw invalid();
  const task = resolveTaskWorkspace(manifest.taskId, manifest.repoRoot);
  const metadata = parseTypedTaskFrontmatter(fs.readFileSync(task.taskMd, 'utf8'));
  if (task.state !== 'completed' || task.branch !== manifest.branch
    || metadata.id !== manifest.taskId || metadata.status !== 'completed') throw invalid();
  const receipt = readTaskFinalizationReceipt(manifest.repoRoot, manifest.taskId);
  if (!receipt || receipt.taskId !== manifest.taskId) throw invalid();
  const view = taskViewForManifest({ ...manifest, receipt });
  if (view.state !== 'current' || view.observedSource !== 'completed' || !view.receipt) throw invalid();
  const status = readSandboxControlStatus(manifest.publicStatusDir);
  const previous = status.taskView;
  if (status.generation !== manifest.generation || status.activeRequestId !== null
    || previous.taskId !== manifest.taskId || !previous.receipt
    || previous.receipt.receiptId !== view.receipt.receiptId
    || previous.receipt.generation !== view.receipt.generation
    || previous.receipt.requestId !== view.receipt.requestId
    || previous.receipt.revision > view.receipt.revision) throw invalid();
  const completedRoot = fs.realpathSync.native(path.join(manifest.repoRoot, '.agents', 'workspace', 'completed'));
  const source = fs.realpathSync.native(path.join(completedRoot, manifest.taskId));
  if (source !== path.join(completedRoot, manifest.taskId)) throw invalid();
  const stat = fs.statSync(source, { bigint: true });
  return {
    taskId: manifest.taskId, generation: manifest.generation,
    containerId: container.id, branch: manifest.branch,
    worktreeRoot: fs.realpathSync.native(manifest.worktreeRoot),
    source, sourceDevice: String(stat.dev), sourceInode: String(stat.ino), receipt: view.receipt
  };
}

export function publishCompletedReentry(manifest: SandboxControlManifest, evidence: ReentryEvidence): void {
  atomicWriteJson(evidencePath(manifest), evidence);
}

export async function completedReentryView(
  manifest: SandboxControlManifest,
  inspect: typeof inspectSandboxControlContainer = inspectSandboxControlContainer
): Promise<SandboxTaskView | null> {
  const file = evidencePath(manifest);
  if (!fs.existsSync(file)) return null;
  const evidence: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const current = await prepareCompletedReentry(manifest, inspect);
  if (JSON.stringify(evidence) !== JSON.stringify(current)) throw invalid();
  return {
    state: 'current', taskId: current.taskId, observedSource: 'completed',
    receipt: current.receipt, reasonCode: null
  };
}

export async function waitForCompletedReentry(manifest: SandboxControlManifest, evidence: ReentryEvidence): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = readSandboxControlStatus(manifest.publicStatusDir);
    if (status.generation !== evidence.generation) throw invalid();
    if (status.taskView.state === 'current' && status.taskView.observedSource === 'completed'
      && status.taskView.taskId === evidence.taskId
      && JSON.stringify(status.taskView.receipt) === JSON.stringify(evidence.receipt)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SANDBOX_COMPLETED_REENTRY_STATUS_TIMEOUT');
}
