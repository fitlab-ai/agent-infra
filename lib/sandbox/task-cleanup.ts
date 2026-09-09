import fs from 'node:fs';
import path from 'node:path';
import { inspectOwnedPath } from '../owned-path.ts';
import { parseTaskFrontmatter } from '../task/frontmatter.ts';
import { readTaskFinalizationReceipt, type TaskFinalizationReceipt } from '../task/finalization.ts';
import { taskFinalizationReceiptState, type TaskControlBindingEvidence, type TaskControlBinding as SandboxControlBinding } from '../task/finalization-state.ts';
import { enumerateAllTaskDirs } from '../task/resolve-ref.ts';
import { resolveSandboxCleanupTarget } from './workspace-identity.ts';
import { readSandboxControlManifest } from './control/lifecycle.ts';
import { readJsonFile, readSandboxControlStatus } from './control/state.ts';
import { finalizationTerminalResponse } from './control/finalization-response.ts';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;

function matchingControlManifest(repoRoot: string, controlRoot: string, taskId: string, binding: SandboxControlBinding) {
  if (!controlRootIdentity(controlRoot)) return null;
  const manifestPath = path.join(controlRoot, 'manifest.json');
  let manifest;
  try { manifest = readSandboxControlManifest(manifestPath); }
  catch { return null; }
  if (manifest.mode !== 'task-bound' || manifest.taskId !== taskId
    || canonicalPath(manifest.repoRoot) !== repoRoot || manifest.generation !== binding.generation
    || path.resolve(manifest.channelDir) !== path.join(controlRoot, 'channel')
    || path.resolve(manifest.publicStatusDir) !== path.join(controlRoot, 'public')
    || path.resolve(manifest.processingDir) !== path.join(controlRoot, 'processing')
    || path.resolve(manifest.runtimeDir) !== path.join(controlRoot, 'runtime')) return null;
  return manifest;
}

type DirectoryIdentity = Readonly<{ dev: string; ino: string }>;
type SandboxRemovalJournalEvidence = Readonly<{
  phase: string;
  generation: string;
  target: Readonly<{
    branch: string;
    controlRoot: string;
  }>;
}>;

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : null;
}

function controlBindingKey(taskId: string, binding: SandboxControlBinding): string {
  return `${taskId}\0${binding.generation}\0${binding.requestId}`;
}

function controlRootIdentity(root: string): DirectoryIdentity | null {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return null;
  }
}

function controlRootState(
  root: string,
  expected: DirectoryIdentity
): 'missing' | 'same' | 'replaced' {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); }
  catch (error) { return errorCode(error) === 'ENOENT' ? 'missing' : 'replaced'; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'replaced';
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino ? 'same' : 'replaced';
}

function controlRootIsAbsent(root: string): boolean {
  try {
    fs.lstatSync(root);
    return false;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

function canonicalPath(input: string): string {
  try { return fs.realpathSync.native(input); }
  catch { return path.resolve(input); }
}

function taskFinalizationReceiptComplete(
  receipt: TaskFinalizationReceipt,
  taskId: string,
  binding: SandboxControlBinding
): boolean {
  return receipt.taskId === taskId
    && taskFinalizationReceiptState(receipt) === 'complete'
    && receipt.controlBinding?.generation === binding.generation
    && receipt.controlBinding.requestId === binding.requestId;
}

function terminalControlBindingEvidence(
  repoRootInput: string,
  controlRootInput: string,
  taskId: string,
  binding: SandboxControlBinding
): boolean {
  const repoRoot = canonicalPath(repoRootInput);
  const controlRoot = path.resolve(controlRootInput);
  if (!TASK_ID_RE.test(taskId) || !controlRootIdentity(controlRoot)) return false;
  const manifestPath = path.join(controlRoot, 'manifest.json');
  if (!inspectOwnedPath(controlRoot, manifestPath, 'file')) return false;
  const manifest = matchingControlManifest(repoRoot, controlRoot, taskId, binding);
  if (!manifest) return false;
  try {
    const leasePath = path.join(controlRoot, 'lease.json');
    try {
      fs.lstatSync(leasePath);
      return false;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return false;
    }
    const receipt = readTaskFinalizationReceipt(repoRoot, taskId);
    if (!receipt || !taskFinalizationReceiptComplete(receipt, taskId, binding)) {
      return false;
    }
    const status = readSandboxControlStatus(manifest.publicStatusDir);
    const viewReceipt = status.taskView.receipt;
    const terminalTaskView = (status.taskView.state === 'current' && status.taskView.observedSource === 'completed')
      || (status.taskView.state === 'finalized-stale' && status.taskView.observedSource === 'active');
    if (status.generation !== binding.generation || status.state !== 'healthy'
      || status.activeRequestId !== null || !terminalTaskView || status.taskView.taskId !== taskId
      || !viewReceipt || viewReceipt.generation !== binding.generation
      || viewReceipt.requestId !== binding.requestId
      || viewReceipt.receiptId !== receipt.receiptId
      || viewReceipt.revision !== receipt.revision) return false;
    const responsePath = path.join(manifest.channelDir, 'responses', `${binding.requestId}.json`);
    if (!inspectOwnedPath(path.join(controlRoot, 'channel'), responsePath, 'file')) return false;
    const actual = readJsonFile(responsePath);
    const expected = finalizationTerminalResponse(taskId, binding.requestId, receipt);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function removedControlBindingEvidence(
  repoRootInput: string,
  journal: SandboxRemovalJournalEvidence,
  taskId: string,
  binding: SandboxControlBinding
): boolean {
  const repoRoot = canonicalPath(repoRootInput);
  if (journal.phase !== 'completed'
    || journal.generation !== binding.generation
    || !path.isAbsolute(journal.target.controlRoot)) return false;
  const controlRoot = path.resolve(journal.target.controlRoot);
  if (!controlRootIsAbsent(controlRoot)) return false;
  const task = enumerateAllTaskDirs(repoRoot).find((entry) => entry.taskId === taskId);
  if (!task || (task.state !== 'completed' && task.state !== 'archive')) return false;
  let frontmatter: Record<string, string>;
  try { frontmatter = parseTaskFrontmatter(fs.readFileSync(path.join(task.taskDir, 'task.md'), 'utf8')); }
  catch { return false; }
  if (frontmatter.id !== taskId || frontmatter.branch !== journal.target.branch) return false;
  try {
    const receipt = readTaskFinalizationReceipt(repoRoot, taskId);
    return receipt !== null && taskFinalizationReceiptComplete(receipt, taskId, binding);
  } catch {
    return false;
  }
}

export function createSandboxControlBindingEvidence(
  repoRoot: string,
  controlRoots: readonly string[],
  removalJournals: readonly SandboxRemovalJournalEvidence[] = []
): TaskControlBindingEvidence {
  const canonicalRepoRoot = canonicalPath(repoRoot);
  const roots = [...new Set(controlRoots.map((candidate) => path.resolve(candidate)))];
  const captured = roots.flatMap((controlRoot) => {
    let manifest;
    try { manifest = readSandboxControlManifest(path.join(controlRoot, 'manifest.json')); }
    catch { return []; }
    const rootIdentity = controlRootIdentity(controlRoot);
    if (!rootIdentity) return [];
    const receipt = (() => {
      try { return readSandboxControlStatus(manifest.publicStatusDir).taskView.receipt; }
      catch { return null; }
    })();
    if (!receipt || !terminalControlBindingEvidence(canonicalRepoRoot, controlRoot, manifest.taskId ?? '', receipt)) return [];
    return [{
      controlRoot,
      taskId: manifest.taskId!,
      key: controlBindingKey(manifest.taskId!, receipt),
      rootIdentity
    }];
  });
  return (taskId, binding) => {
    const terminal = captured.some((candidate) => {
      if (candidate.taskId !== taskId || candidate.key !== controlBindingKey(taskId, binding)) return false;
      const state = controlRootState(candidate.controlRoot, candidate.rootIdentity);
      return state === 'missing'
        || state === 'same' && terminalControlBindingEvidence(canonicalRepoRoot, candidate.controlRoot, taskId, binding);
    }) || removalJournals.some((journal) => removedControlBindingEvidence(canonicalRepoRoot, journal, taskId, binding));
    if (terminal) return 'terminal';
    if (roots.some((root) => matchingControlManifest(canonicalRepoRoot, root, taskId, binding))) return 'pending';
    try {
      const branch = resolveSandboxCleanupTarget(taskId, canonicalRepoRoot, { allowProtected: true }).branch;
      if (removalJournals.some((journal) => journal.phase !== 'completed'
        && journal.generation === binding.generation && journal.target.branch === branch)) return 'pending';
    } catch {
      // Missing or conflicting task identity cannot authorize removal.
    }
    return 'mismatch';
  };
}
