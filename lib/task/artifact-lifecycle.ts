import fs from 'node:fs';
import path from 'node:path';

import { ARTIFACT_FAMILY_CATALOG, artifactName, parseArtifactName } from './artifact-name.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import type { ResolveTaskRefErrorCode, TaskWorkspaceState } from './resolve-ref.ts';
import { lifecycleExecutions } from './lifecycle-execution.ts';
import { parseImplementationInputs, selectPendingImplementationInput } from './implementation-inputs.ts';
import { parseVerdict } from './review-artifacts.ts';
import { extractSection, findSectionHeading } from './sections.ts';
import { receiptForOutput, receiptsForOutput, sha256File } from './artifact-receipts.ts';
import { hasArtifactCompletionRecord, hasValidArtifactCompletion } from './completion-facts.ts';
import { inspectReviewIdentity } from './review-identity.ts';
import type { ArtifactFamily, ArtifactFamilySpec } from './artifact-name.ts';
import { parseLifecyclePathDecision } from './lifecycle-path.ts';
import type { LifecyclePathState } from './lifecycle-path.ts';
import { parseReworkIntentDocument } from './rework-intent.ts';
import { selectArtifactDisposition } from './artifact-selection.ts';
import type { ArtifactSelection } from './artifact-selection.ts';
import { executionInputsMatchLatest } from './execution-inputs.ts';

const artifactFamilyCatalog = ARTIFACT_FAMILY_CATALOG;
/** Init, repair and finalization share the same authoritative round identity. */
export function hasOpenArtifactRound(taskDir: string, content: string, family: ArtifactFamily, round: number): boolean {
  return openArtifactRounds(taskDir, content, family).includes(round);
}

function openArtifactRounds(taskDir: string, content: string, family: ArtifactFamily): number[] {
  const executionFamily = family === 'analysis' ? 'analyze' : family;
  const event = completionEvent(family);
  return [...new Set(lifecycleExecutions(content)
    .filter((item) => item.family === executionFamily && item.round !== undefined)
    .flatMap((item) => {
      const round = item.round!;
      const name = artifactName(family, round);
      if (!event || !hasArtifactCompletionRecord(content, name, event)) return [round];
      if (!hasValidArtifactCompletion(content, taskDir, name, event)) throw new Error(`completion evidence for started ${family} Round ${round} is invalid`);
      return [];
    }))].sort((left, right) => left - right);
}

function hasCompletedArtifactRound(taskDir: string, content: string, family: string, round: number, name: string): boolean {
  const event = completionEvent(family);
  return Boolean(event && parseArtifactName(name)?.round === round
    && hasValidArtifactCompletion(content, taskDir, name, event));
}

function completionEvent(family: string): string | null {
  if (family === 'analysis') return 'analyze.completed';
  if (family === 'review-analysis') return 'review-analysis.completed';
  if (family === 'plan') return 'plan.completed';
  if (family === 'review-plan') return 'review-plan.completed';
  if (family === 'code') return 'code.completed';
  if (family === 'review-code') return 'review-code.completed';
  return null;
}

type ArtifactIdentity = {
  family: ArtifactFamily;
  round: number;
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};
type ArtifactDiagnosticCode =
  | 'NONCANONICAL_NAME' | 'ROUND_OUT_OF_RANGE' | 'MISSING_BASE' | 'ROUND_GAP'
  | 'DUPLICATE_LOGICAL_ROUND' | 'NON_REGULAR_FILE' | 'SYMBOLIC_LINK'
  | 'FILESYSTEM_RACE' | 'CATALOG_CONFLICT' | 'BROKEN_REFERENCE' | 'MULTIPLE_OPEN_ROUNDS';
type ArtifactDiagnostic = {
  code: ArtifactDiagnosticCode;
  family: ArtifactFamily;
  name: string | null;
  message: string;
};
type ArtifactErrorCode =
  | ResolveTaskRefErrorCode | 'ARTIFACT_FAMILY_UNKNOWN' | 'ARTIFACT_DIRECTORY_READ_FAILED'
  | 'ARTIFACT_TOPOLOGY_CONFLICT' | 'ARTIFACT_INPUT_MISSING'
  | 'ARTIFACT_REFERENCE_INVALID' | 'ARTIFACT_PATH_INVALID'
  | 'LIFECYCLE_PATH_INVALID'
  | 'ARTIFACT_IDENTITY_INVALID' | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_NOT_REGULAR' | 'ARTIFACT_NOT_READABLE' | 'ARTIFACT_VERDICT_INVALID'
  | 'ARTIFACT_MODE_REFUSED'
  | 'ARTIFACT_SELECTION_INDETERMINATE';

type ArtifactError = { code: ArtifactErrorCode; message: string };
type ArtifactInventoryResult = {
  status: 'ready' | 'failed';
  changed: false;
  requestRef: string;
  taskId: string | null;
  taskDir: string | null;
  taskState: TaskWorkspaceState | null;
  family: ArtifactFamily | string;
  artifacts: readonly ArtifactIdentity[];
  completed: readonly ArtifactIdentity[];
  latest: ArtifactIdentity | null;
  next: { round: number; name: string } | null;
  openRounds: readonly number[];
  reviewedInput: ArtifactIdentity | null;
  diagnostics: readonly ArtifactDiagnostic[];
  error: ArtifactError | null;
};
type ArtifactContextStatus = 'ready' | 'refused' | 'failed';
type CodeArtifactMode = 'init' | 'fix' | 'decision' | 'refused' | 'error';
type ArtifactContextResult = Omit<ArtifactInventoryResult, 'status'> & {
  status: ArtifactContextStatus;
  inputs: readonly ArtifactIdentity[];
  selection?: ArtifactSelection | null;
  codeMode: {
    mode: CodeArtifactMode;
    codeMax: number;
    reviewMax: number;
    verdict: string | null;
    reviewArtifact: string | null;
    implementationInput: string | null;
    decisionId: string | null;
    decisionEvidence: string | null;
    message: string;
  } | null;
};
type InspectOptions = {
  repoRoot?: string;
  reasonCode?: string;
  sourceFinding?: string;
  sourceArtifact?: string;
  sourceSha256?: string;
};

type ResolvedTaskRef = Extract<ReturnType<typeof resolveTaskRef>, { ok: true }>;

const BLOCKING_DIAGNOSTICS = new Set<ArtifactDiagnosticCode>([
  'NONCANONICAL_NAME', 'ROUND_OUT_OF_RANGE', 'MISSING_BASE', 'ROUND_GAP',
  'DUPLICATE_LOGICAL_ROUND', 'NON_REGULAR_FILE', 'SYMBOLIC_LINK',
  'FILESYSTEM_RACE', 'CATALOG_CONFLICT', 'MULTIPLE_OPEN_ROUNDS'
]);

function familySpec(family: string): ArtifactFamilySpec | null {
  return artifactFamilyCatalog.find((item) => item.family === family) ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failure(requestRef: string, family: string, error: ArtifactError, extra: Partial<ArtifactInventoryResult> = {}): ArtifactInventoryResult {
  return {
    status: 'failed', changed: false, requestRef, taskId: null, taskDir: null,
    taskState: null, family, artifacts: [], completed: [], latest: null, next: null, openRounds: [],
    reviewedInput: null, diagnostics: [], error, ...extra
  };
}

function diagnostic(code: ArtifactDiagnosticCode, family: ArtifactFamily, name: string | null, message: string): ArtifactDiagnostic {
  return { code, family, name, message };
}

function inspectTaskArtifacts(
  taskRef: string,
  family: string,
  options: InspectOptions = {},
  resolvedTask?: ResolvedTaskRef
): ArtifactInventoryResult {
  const spec = familySpec(family);
  if (!spec) return failure(taskRef, family, { code: 'ARTIFACT_FAMILY_UNKNOWN', message: `unknown artifact family '${family}'` });
  const resolved = resolvedTask ?? resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(taskRef, family, { code: resolved.code, message: resolved.message }, { taskId: resolved.taskId });
  return inspectArtifactDirectory(resolved.taskDir, spec.family, {
    requestRef: taskRef, taskId: resolved.taskId, taskState: resolved.state
  });
}

function inspectArtifactDirectory(
  taskDir: string,
  family: ArtifactFamily,
  identity: { requestRef?: string; taskId?: string; taskState?: TaskWorkspaceState } = {}
): ArtifactInventoryResult {
  const requestRef = identity.requestRef ?? taskDir;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(taskDir, { withFileTypes: true }); }
  catch (error) {
    return failure(requestRef, family, { code: 'ARTIFACT_DIRECTORY_READ_FAILED', message: String(error) }, {
      taskId: identity.taskId ?? null, taskDir, taskState: identity.taskState ?? null
    });
  }
  let taskContent: string;
  try {
    taskContent = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
  } catch (error) {
    return failure(requestRef, family, { code: 'ARTIFACT_DIRECTORY_READ_FAILED', message: String(error) }, {
      taskId: identity.taskId ?? null, taskDir, taskState: identity.taskState ?? null
    });
  }
  const artifacts: ArtifactIdentity[] = [];
  const knownArtifacts: ArtifactIdentity[] = [];
  const diagnostics: ArtifactDiagnostic[] = [];
  for (const entry of entries) {
    const parsed = parseArtifactName(entry.name);
    const reserved = entry.name.toLowerCase().startsWith(`${family.toLowerCase()}-r`) || entry.name.toLowerCase() === `${family.toLowerCase()}.md`;
    if (!parsed || parsed.family !== family) {
      if (reserved) {
        const roundText = new RegExp(`^${escapeRegExp(family)}-r(.+)\\.md$`, 'i').exec(entry.name)?.[1];
        const code = roundText && /^\d+$/.test(roundText) && !Number.isSafeInteger(Number(roundText))
          ? 'ROUND_OUT_OF_RANGE' : 'NONCANONICAL_NAME';
        diagnostics.push(diagnostic(code, family, entry.name, `noncanonical ${family} artifact candidate '${entry.name}' (verify whether this is an unrelated file with a reserved prefix)`));
      }
      continue;
    }
    const abs = path.join(taskDir, entry.name);
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        diagnostics.push(diagnostic('SYMBOLIC_LINK', family, entry.name, `symbolic links are not workflow artifacts: ${entry.name}`));
        continue;
      }
      if (!stat.isFile()) {
        diagnostics.push(diagnostic('NON_REGULAR_FILE', family, entry.name, `artifact is not a regular file: ${entry.name}`));
        continue;
      }
      try { fs.accessSync(abs, fs.constants.R_OK); }
      catch {
        diagnostics.push(diagnostic('FILESYSTEM_RACE', family, entry.name, `artifact is not readable: ${entry.name}`));
        continue;
      }
      const identity = { ...parsed, path: abs, size: stat.size, mtimeMs: stat.mtimeMs };
      knownArtifacts.push(identity);
      artifacts.push(identity);
    } catch (error) {
      diagnostics.push(diagnostic('FILESYSTEM_RACE', family, entry.name, String(error)));
    }
  }
  artifacts.sort((left, right) => left.round - right.round);
  knownArtifacts.sort((left, right) => left.round - right.round);
  let openRounds: number[];
  try { openRounds = openArtifactRounds(taskDir, taskContent, family); }
  catch (error) {
    return failure(requestRef, family, {
      code: 'ARTIFACT_SELECTION_INDETERMINATE',
      message: error instanceof Error ? error.message : String(error)
    }, { taskId: identity.taskId ?? null, taskDir, taskState: identity.taskState ?? null });
  }
  const knownRounds = new Set(knownArtifacts.map((item) => item.round));
  for (const round of openRounds) knownRounds.add(round);
  const max = Math.max(...knownRounds, 0);
  if (max > 0 && !knownRounds.has(1)) diagnostics.push(diagnostic('MISSING_BASE', family, null, `${family}.md is missing`));
  for (let round = 1; round <= max; round += 1) {
    if (!knownRounds.has(round)) diagnostics.push(diagnostic('ROUND_GAP', family, null, `${artifactName(family, round)} is missing`));
  }
  const event = completionEvent(family);
  const completed = event
    ? artifacts.filter((artifact) => hasValidArtifactCompletion(taskContent, taskDir, artifact.name, event))
      .sort((left, right) => left.round - right.round)
    : [];
  if (openRounds.length > 1) diagnostics.push(diagnostic('MULTIPLE_OPEN_ROUNDS', family, null, `multiple incomplete ${family} rounds are open: ${openRounds.join(', ')}`));
  const latest = completed.at(-1) ?? null;
  let hasReviewCodeReceipt = false;
  if (family === 'review-code' && latest) {
    try { hasReviewCodeReceipt = Boolean(receiptForOutput(taskContent, latest.name)); }
    catch { hasReviewCodeReceipt = false; }
  }
  const reviewedInput = family.startsWith('review-') && latest && (family !== 'review-code' || hasReviewCodeReceipt)
    ? resolveReviewedInput(taskDir, latest, family === 'review-analysis' ? 'analysis' : family === 'review-plan' ? 'plan' : 'code', diagnostics)
    : null;
  return {
    status: 'ready', changed: false, requestRef, taskId: identity.taskId ?? null,
    taskDir, taskState: identity.taskState ?? null, family, artifacts, completed, latest,
    next: { round: max + 1, name: artifactName(family, max + 1) },
    openRounds, reviewedInput, diagnostics, error: null
  };
}

function resolveReviewedInput(
  taskDir: string,
  review: ArtifactIdentity,
  expectedFamily: ArtifactFamily,
  diagnostics: ArtifactDiagnostic[]
): ArtifactIdentity | null {
  try {
    const taskContent = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    const receipt = receiptForOutput(taskContent, review.name);
    const expectedEvent = reviewEventName(review.family);
    if (!receipt || receipt.event !== expectedEvent) throw new Error(`receipt for ${review.name} is missing or invalid`);
    const input = parseArtifactName(receipt.input);
    if (!input || input.family !== expectedFamily) throw new Error(`receipt input '${receipt.input}' is not a canonical ${expectedFamily} artifact`);
    const abs = path.join(taskDir, input.name);
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('referenced input is not a regular file');
    const actualSha256 = sha256File(abs);
    if (actualSha256 !== receipt.inputSha256) {
      throw new Error(`${input.name} content digest does not match receipt`);
    }
    return { ...input, path: abs, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    diagnostics.push(diagnostic('BROKEN_REFERENCE', review.family, review.name, String(error)));
    return null;
  }
}

function reviewEventName(family: ArtifactFamily): 'review-analysis.completed' | 'review-plan.completed' | 'review-code.completed' {
  if (family === 'review-analysis') return 'review-analysis.completed';
  if (family === 'review-plan') return 'review-plan.completed';
  if (family === 'review-code') return 'review-code.completed';
  throw new Error(`unsupported review family '${family}'`);
}

function resolveCodeInputReceipt(taskDir: string, code: ArtifactIdentity): { input: ArtifactIdentity; inputSha256: string } | null {
  let taskContent: string;
  try { taskContent = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8'); }
  catch { return null; }
  let receipt;
  try { receipt = receiptForOutput(taskContent, code.name); }
  catch { return null; }
  if (!receipt || receipt.event !== 'code.completed') return null;
  const identity = parseArtifactName(receipt.input);
  if (!identity || !['analysis', 'plan'].includes(identity.family)) return null;
  const source = inspectArtifactDirectory(taskDir, identity.family);
  if (source.status !== 'ready') return null;
  const input = source.artifacts.find((artifact) => artifact.name === receipt.input);
  return input ? { input, inputSha256: receipt.inputSha256 } : null;
}

function resolveCodePlanInput(taskDir: string, code: ArtifactIdentity): { input: ArtifactIdentity; inputSha256: string } | null {
  return resolveCodeInputReceipt(taskDir, code);
}

function lifecyclePathState(taskDir: string): LifecyclePathState {
  const analysis = inspectArtifactDirectory(taskDir, 'analysis');
  if (analysis.status !== 'ready' || !analysis.latest) return { status: 'missing', decision: null, message: 'analysis artifact is missing' };
  try {
    return parseLifecyclePathDecision(fs.readFileSync(analysis.latest.path, 'utf8'), analysis.latest.name, sha256File(analysis.latest.path));
  } catch (error) {
    return { status: 'invalid', decision: null, message: error instanceof Error ? error.message : String(error) };
  }
}

function assertWritableInventory(inventory: ArtifactInventoryResult): ArtifactError | null {
  if (inventory.status === 'failed') return inventory.error;
  const blockers = inventory.diagnostics.filter((item) => BLOCKING_DIAGNOSTICS.has(item.code));
  return blockers.length === 0 ? null : {
    code: 'ARTIFACT_TOPOLOGY_CONFLICT',
    message: blockers.map((item) => `${item.code}: ${item.message}`).join('; ')
  };
}

const REQUIRED_INPUT: Partial<Record<ArtifactFamily, ArtifactFamily>> = {
  'review-analysis': 'analysis', plan: 'analysis', 'review-plan': 'plan'
};
const OPTIONAL_CONTEXT: Partial<Record<ArtifactFamily, readonly ArtifactFamily[]>> = {
  analysis: ['review-analysis'],
  plan: ['review-analysis', 'review-plan'],
  'review-plan': ['review-analysis'],
  code: ['review-plan'],
  'review-code': ['code', 'plan', 'review-plan'],
  'manual-validation': ['review-code'],
  'validation-run': ['review-code']
};
function hasSelectionEvidence(
  content: string,
  family: ArtifactFamily,
  options: InspectOptions,
  context: ArtifactContextResult,
  pathState: LifecyclePathState
): boolean {
  if (options.sourceFinding && options.sourceArtifact && options.sourceSha256) return true;
  if (options.reasonCode === 'new-requirement' || options.reasonCode === 'upstream-fact-doubt'
    || family === 'review-code' && options.reasonCode === 'manual-review-supplement') return true;
  if ((family === 'plan' || family === 'code') && context.latest) {
    const latestInputs = Object.fromEntries(context.inputs.map((input) => [input.family, input.name]));
    const capturedInputs = receiptsForOutput(content, context.latest.name)
      .filter((receipt) => receipt.event === `${family}.completed`)
      .filter((receipt) => {
        try { return sha256File(path.join(context.taskDir!, receipt.input)) === receipt.inputSha256; }
        catch { return false; }
      })
      .map((receipt) => receipt.input);
    if (!executionInputsMatchLatest(family, pathState, latestInputs, capturedInputs)) return true;
  }
  if (family.startsWith('review-')) {
    const reviewedFamily = family === 'review-analysis' ? 'analysis' : family === 'review-plan' ? 'plan' : 'code';
    const currentInput = context.inputs.find((input) => input.family === reviewedFamily);
    if (family === 'review-code') {
      if (!context.latest) return false;
      try {
        const reportContent = fs.readFileSync(context.latest.path, 'utf8');
        const identity = inspectReviewIdentity(context.taskDir!, reportContent, options.repoRoot);
        return identity.status !== 'matched'
          || !context.taskDir
          || !hasValidArtifactCompletion(content, context.taskDir, context.latest.name, 'review-code.completed');
      } catch {
        return true;
      }
    }
    if (currentInput && context.reviewedInput?.name !== currentInput.name) return true;
  }
  const target = family === 'analysis' ? 'analysis' : family === 'plan' ? 'plan' : family === 'code' ? 'code' : null;
  if (target) {
    const parsed = parseReworkIntentDocument(content);
    if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
    if (parsed.intents.some((intent) => intent.status === 'pending'
      && (intent.target === target || family === 'analysis' && intent.target === 'plan'))) return true;
  }
  if (family === 'code') {
    if (context.latest && context.codeMode?.mode === 'init') return true;
    if (parseImplementationInputs(content).rows.some((input) => input.needsImplementation && input.status === 'pending')) return true;
  }
  return context.inputs.filter((candidate) => candidate.family.startsWith('review-')).some((input) => {
    const verdict = parseVerdict(input.path);
    if (!verdict.ok || verdict.verdict !== 'Changes Requested' || !context.latest) return false;
    const receipt = receiptForOutput(content, input.name);
    return receipt?.event === reviewEventName(input.family)
      && receipt.input === context.latest.name
      && receipt.inputSha256 === sha256File(context.latest.path);
  });
}

function attachArtifactSelection(
  context: ArtifactContextResult,
  pathState: LifecyclePathState,
  options: InspectOptions
): ArtifactContextResult {
  if (context.status !== 'ready' || !context.taskDir || !context.taskId
    || (context.family !== 'analysis' && pathState.status !== 'valid')) return context;
  const family = context.family as ArtifactFamily;
  const fail = (code: ArtifactErrorCode, message: string): ArtifactContextResult => ({
    ...context, status: 'failed', selection: null, error: { code, message }
  });
  if (!context.next) return fail('ARTIFACT_SELECTION_INDETERMINATE', 'artifact inventory did not provide a writable identity');
  const state = readArtifactSelectionState(context.taskDir, family);
  if (!state.ok) return fail('ARTIFACT_SELECTION_INDETERMINATE', state.message);
  const taskContent = state.content;
  const openRounds = state.openRounds;
  if (openRounds.length > 1) return fail('ARTIFACT_TOPOLOGY_CONFLICT', `multiple incomplete ${family} rounds are open: ${openRounds.join(', ')}`);
  const openRound = openRounds[0] ?? null;
  const selectedIdentity = openRound === null ? context.next : {
    family, round: openRound, name: artifactName(family, openRound),
    path: path.join(context.taskDir, artifactName(family, openRound)), size: 0, mtimeMs: 0
  };
  try {
    const hasChangeEvidence = hasSelectionEvidence(taskContent, family, options, context, pathState);
    const selection = selectArtifactDisposition({
      next: { family, round: selectedIdentity.round, name: selectedIdentity.name },
      latest: context.latest,
      open: openRound !== null,
      hasChangeEvidence
    });
    return {
      ...context,
      selection,
      next: selection.writeRequired ? { round: selection.artifact.round, name: selection.artifact.name } : null
    };
  } catch (error) {
    return fail('ARTIFACT_SELECTION_INDETERMINATE', error instanceof Error ? error.message : String(error));
  }
}

function readArtifactSelectionState(taskDir: string, family: ArtifactFamily):
  | { ok: true; content: string; openRounds: number[] }
  | { ok: false; message: string } {
  try {
    const content = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
    return { ok: true, content, openRounds: openArtifactRounds(taskDir, content, family) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function resolveArtifactContextFromTask(
  taskRef: string,
  family: string,
  options: InspectOptions,
  resolvedTask?: ResolvedTaskRef
): ArtifactContextResult {
  const inventory = inspectTaskArtifacts(taskRef, family, options, resolvedTask);
  if (inventory.status === 'failed') return { ...inventory, inputs: [], codeMode: null };
  const writableError = assertWritableInventory(inventory);
  if (writableError) return { ...inventory, status: 'failed', inputs: [], codeMode: null, error: writableError };
  const pathState = lifecyclePathState(inventory.taskDir!);
  if (inventory.family !== 'analysis' && pathState.status !== 'valid') {
    return contextFailure(inventory, 'LIFECYCLE_PATH_INVALID', pathState.message);
  }
  if (inventory.family === 'code') {
    const code = resolveCodeContext(inventory, options, resolvedTask);
    const selected = attachArtifactSelection(code, pathState, options);
    if (selected.status !== 'ready' || !selected.selection) return selected;
    if (selected.selection.disposition === 'reuse') return selected;
    if (selected.codeMode?.mode === 'error'
      && selected.codeMode.message.includes('is not captured by the latest code input receipt')) {
      return {
        ...selected,
        status: 'ready',
        codeMode: {
          ...selected.codeMode,
          mode: 'init',
          message: 'A new implementation round was requested.'
        },
        error: null
      };
    }
    if (selected.codeMode?.mode === 'refused') {
      return {
        ...selected,
        status: 'ready',
        codeMode: {
          ...selected.codeMode,
          mode: 'init',
          message: 'A new implementation round was requested.'
        },
        error: null
      };
    }
    return selected;
  }
  const required = REQUIRED_INPUT[inventory.family as ArtifactFamily];
  const inputs: ArtifactIdentity[] = [];
  if (required) {
    const input = inspectTaskArtifacts(taskRef, required, options, resolvedTask);
    if (input.status === 'failed' || !input.latest) {
      return { ...inventory, status: 'failed', inputs, codeMode: null, error: { code: 'ARTIFACT_INPUT_MISSING', message: `latest ${required} artifact is required` } };
    }
    inputs.push(input.latest);
  }
  const optional = OPTIONAL_CONTEXT[inventory.family as ArtifactFamily];
  if (optional) {
    for (const family of optional) {
      const context = inspectTaskArtifacts(taskRef, family, options, resolvedTask);
      if (context.status === 'ready' && context.latest) inputs.push(context.latest);
    }
  }
  if (inventory.family === 'manual-validation' || inventory.family === 'validation-run') {
    return { ...inventory, inputs, codeMode: null };
  }
  return attachArtifactSelection({ ...inventory, inputs, codeMode: null }, pathState, options);
}

function resolveArtifactContext(taskRef: string, family: string, options: InspectOptions = {}): ArtifactContextResult {
  return resolveArtifactContextFromTask(taskRef, family, options);
}

function resolveCodeContext(
  inventory: ArtifactInventoryResult,
  options: InspectOptions,
  resolvedTask?: ResolvedTaskRef
): ArtifactContextResult {
  const taskRef = inventory.requestRef;
  const pathState = lifecyclePathState(inventory.taskDir!);
  if (pathState.status !== 'valid') return contextFailure(inventory, 'LIFECYCLE_PATH_INVALID', pathState.message);
  const inputFamily = pathState.decision.path === 'streamlined' ? 'analysis' : 'plan';
  const source = inspectTaskArtifacts(taskRef, inputFamily, options, resolvedTask);
  if (source.status === 'failed' || !source.latest) return contextFailure(inventory, 'ARTIFACT_INPUT_MISSING', `latest ${inputFamily} artifact is required`);
  const reviewCode = inspectTaskArtifacts(taskRef, 'review-code', options, resolvedTask);
  try {
    const taskContent = fs.readFileSync(path.join(inventory.taskDir!, 'task.md'), 'utf8');
    const hasPendingImplementation = parseImplementationInputs(taskContent).rows.some((input) => input.needsImplementation && input.status === 'pending');
    if (hasPendingImplementation && !reviewCode.latest) {
      return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', 'no valid review-code completion fact is available for pending implementation inputs');
    }
  } catch (error) {
    return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', error instanceof Error ? error.message : String(error));
  }
  const latestCode = inventory.latest;
  const codeMax = inventory.next?.round ? inventory.next.round - 1 : latestCode?.round ?? 0;
  const reviewMax = reviewCode.latest?.round ?? 0;
  const inputs = [source.latest];
  const sourceReviewFamily = inputFamily === 'analysis' ? 'review-analysis' : 'review-plan';
  const sourceReview = inspectTaskArtifacts(taskRef, sourceReviewFamily, options, resolvedTask);
  if (sourceReview.status === 'ready' && sourceReview.latest && sourceReview.reviewedInput?.name === source.latest.name) inputs.push(sourceReview.latest);
  if (inventory.openRounds.length > 0) {
    try {
      const taskContent = fs.readFileSync(path.join(inventory.taskDir!, 'task.md'), 'utf8');
      const openRound = inventory.openRounds[0]!;
        const review = reviewCode.latest;
        const openInputs = review ? [...inputs, review] : inputs;
        const openVerdict = review ? parseVerdict(review.path) : null;
        const openRow = lifecycleExecutions(taskContent)
          .find((row) => row.family === 'code' && row.round === openRound);
        const decisionInput = openRow?.implementationInput ?? null;
        const fixInput = openRow?.fixFor ?? null;
        const mode = decisionInput ? 'decision'
          : fixInput || (openVerdict?.ok && openVerdict.verdict === 'Changes Requested') ? 'fix'
            : 'init';
        return withCodeMode(
          inventory, openInputs, 'ready', mode, codeMax, reviewMax,
          openVerdict?.ok ? openVerdict.verdict : null, fixInput ?? review?.name ?? null,
          `Resuming open code round ${openRound}.`,
          decisionInput
        );
    } catch (error) {
      return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', error instanceof Error ? error.message : String(error));
    }
  }
  if (!latestCode) {
    return withCodeMode(inventory, inputs, 'ready', 'init', codeMax, reviewMax, null, null,
      'No prior code artifact. Starting initial implementation (round 1 -> code.md).');
  }
  const codePlanInput = resolveCodePlanInput(inventory.taskDir!, latestCode);
  if (!codePlanInput) {
    return withCodeMode(inventory, inputs, 'ready', 'error', codeMax, reviewMax, null, null,
      `Code input receipt for ${latestCode.name} is unavailable.`);
  }
  const currentInputSha256 = sha256File(source.latest.path);
  if (codePlanInput.input.name !== source.latest.name || codePlanInput.inputSha256 !== currentInputSha256) {
    return withCodeMode(inventory, inputs, 'ready', 'init', codeMax, reviewMax, null, null,
      `Latest ${source.latest.name} is not captured by the latest code input receipt. Entering replan-driven init.`);
  }
  if (!reviewCode.latest || reviewCode.reviewedInput?.name !== latestCode.name) {
    const expected = reviewCode.next?.name ?? artifactName('review-code', reviewMax + 1);
    return withCodeMode(inventory, inputs, 'ready', 'error', codeMax, reviewMax, null, expected,
      `${expected} is required before another code round`);
  }
  const review = reviewCode.latest;
  if (!review) return contextFailure(inventory, 'ARTIFACT_INPUT_MISSING', 'latest review-code artifact is required');
  const verdict = parseVerdict(review.path);
  if (!verdict.ok) return contextFailure(inventory, 'ARTIFACT_VERDICT_INVALID', `${verdict.code}: ${verdict.message}`, review.name);
  const decision = resolveDecisionImplementationInput(reviewCode, review);
  if ('error' in decision) return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', decision.error, review.name);
  if (decision.input) {
    return withCodeMode(
      inventory, [...inputs, review], 'ready', 'decision', codeMax, reviewMax,
      verdict.verdict, review.name, `Implementation input ${decision.input.id} requires a new code round.`,
      decision.input.id, decision.input.ledgerId, decision.input.decisionEvidence
    );
  }
  try {
    const taskContent = fs.readFileSync(path.join(inventory.taskDir!, 'task.md'), 'utf8');
    const rework = parseReworkIntentDocument(taskContent);
    const reviewSha256 = sha256File(review.path);
    if (rework.ok && rework.intents.some((intent) => intent.status === 'pending'
      && intent.target === 'code'
      && intent.sourceArtifact === review.name
      && intent.sourceSha256 === reviewSha256)) {
      return withCodeMode(inventory, [...inputs, review], 'ready', 'fix', codeMax, reviewMax, verdict.verdict, review.name,
        `Pending rework evidence requires a new code round after ${review.name}.`);
    }
  } catch (error) {
    return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', error instanceof Error ? error.message : String(error), review.name);
  }
  if (verdict.verdict === 'Approved') {
    return withCodeMode(inventory, [...inputs, review], 'ready', 'refused', codeMax, reviewMax, verdict.verdict, review.name,
      `Latest ${review.name} verdict is Approved with no findings. Nothing to fix. Run /commit to proceed.`);
  }
  if (verdict.verdict === 'Rejected') {
    return withCodeMode(inventory, [...inputs, review], 'ready', 'refused', codeMax, reviewMax, verdict.verdict, review.name,
      `Latest ${review.name} verdict is Rejected. Re-plan before re-running code-task.`);
  }
  return withCodeMode(inventory, [...inputs, review], 'ready', 'fix', codeMax, reviewMax, verdict.verdict, review.name,
    `Latest ${review.name} requires or permits fixes. Entering fix mode.`);
}

function contextFailure(inventory: ArtifactInventoryResult, code: ArtifactErrorCode, message: string, reviewArtifact: string | null = null): ArtifactContextResult {
  return { ...inventory, status: 'failed', inputs: [], codeMode: { mode: 'error', codeMax: inventory.latest?.round ?? 0, reviewMax: 0, verdict: null, reviewArtifact, implementationInput: null, decisionId: null, decisionEvidence: null, message }, error: { code, message } };
}

function withCodeMode(
  inventory: ArtifactInventoryResult, inputs: ArtifactIdentity[], status: ArtifactContextStatus,
  mode: CodeArtifactMode, codeMax: number, reviewMax: number, verdict: string | null,
  reviewArtifact: string | null, message: string,
  implementationInput: string | null = null,
  decisionId: string | null = null,
  decisionEvidence: string | null = null
): ArtifactContextResult {
  return { ...inventory, status, inputs, codeMode: { mode, codeMax, reviewMax, verdict, reviewArtifact, implementationInput, decisionId, decisionEvidence, message }, error: status === 'refused' ? { code: 'ARTIFACT_MODE_REFUSED', message } : null };
}

function resolveDecisionImplementationInput(
  inventory: ArtifactInventoryResult,
  review: ArtifactIdentity
): { input: ReturnType<typeof selectPendingImplementationInput> } | { error: string } {
  if (!inventory.taskDir) return { error: 'task directory is unavailable' };
  let content: string;
  try { content = fs.readFileSync(path.join(inventory.taskDir, 'task.md'), 'utf8'); }
  catch (error) { return { error: String(error) }; }
  let rows;
  try { rows = parseImplementationInputs(content).rows; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  const pending = rows.filter((row) => row.needsImplementation && row.status === 'pending');
  if (pending.length === 0) return { input: null };
  if (inventory.latest?.name !== review.name
    || !inventory.completed.some((artifact) => artifact.name === review.name)) {
    return { error: `Review Code completion facts do not validate ${review.name}` };
  }
  try { return { input: selectPendingImplementationInput(rows) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function validateCompletedArtifact(taskDir: string, family: ArtifactFamily, name: string, round?: number): { ok: true; artifact: ArtifactIdentity } | { ok: false; error: ArtifactError } {
  if (path.basename(name) !== name) return { ok: false, error: { code: 'ARTIFACT_PATH_INVALID', message: 'artifact must be a top-level basename' } };
  const parsed = parseArtifactName(name);
  if (!parsed || parsed.family !== family || (round !== undefined && parsed.round !== round)) {
    return { ok: false, error: { code: 'ARTIFACT_IDENTITY_INVALID', message: `artifact '${name}' does not match ${family}${round ? ` round ${round}` : ''}` } };
  }
  const abs = path.join(taskDir, name);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(abs); }
  catch { return { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `artifact '${name}' is not landed` } }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: { code: 'ARTIFACT_NOT_REGULAR', message: `artifact '${name}' is not a regular file` } };
  try { fs.accessSync(abs, fs.constants.R_OK); }
  catch { return { ok: false, error: { code: 'ARTIFACT_NOT_READABLE', message: `artifact '${name}' is not readable` } }; }
  const inventory = inspectArtifactDirectory(taskDir, family);
  const topology = assertWritableInventory(inventory);
  if (topology) return { ok: false, error: topology };
  const artifact = inventory.artifacts.find((item) => item.name === name);
  return artifact ? { ok: true, artifact } : { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `artifact '${name}' is not in inventory` } };
}

/** A candidate may replace its current slot or fill the next slot, never skip rounds. */
export function validateArtifactPublication(taskDir: string, family: ArtifactFamily, name: string): ArtifactError | null {
  const inventory = inspectArtifactDirectory(taskDir, family);
  const error = assertWritableInventory(inventory);
  if (error) return error;
  if (inventory.next?.name === name) return null;
  const existing = inventory.artifacts.find((artifact) => artifact.name === name);
  if (existing) {
    try {
      const task = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
      if (hasCompletedArtifactRound(taskDir, task, family, existing.round, name)) {
        return { code: 'ARTIFACT_IDENTITY_INVALID', message: `completed artifact '${name}' is immutable` };
      }
      const event = completionEvent(family);
      const completionFactExists = event !== null && hasArtifactCompletionRecord(task, name, event);
      if (event && completionFactExists) {
        return { code: 'ARTIFACT_IDENTITY_INVALID', message: `completion evidence for '${name}' does not match its current content` };
      }
    } catch (error) {
      return { code: 'ARTIFACT_SELECTION_INDETERMINATE', message: error instanceof Error ? error.message : String(error) };
    }
    return null;
  }
  return { code: 'ARTIFACT_IDENTITY_INVALID', message: `artifact '${name}' is not a current or next ${family} slot` };
}

function buildArtifactLinkSection(content: string, artifact: ArtifactIdentity): {
  aliases: readonly string[];
  heading: string;
  body: string;
} {
  const spec = familySpec(artifact.family)!;
  const aliases = [...spec.sectionAliases];
  const heading = findSectionHeading(content, aliases);
  const english = heading === spec.sectionAliases[1];
  const label = english
    ? `${spec.labels[1]} (Round ${artifact.round})`
    : `${spec.labels[0]}（Round ${artifact.round}）`;
  const link = `${label}：\`${artifact.name}\``;
  let body = extractSection(content, aliases);
  if (body.includes(link)) return { aliases, heading, body };
  const placeholders = new Set([
    '[分析阶段的发现。哪些文件受影响？范围是什么？]',
    '[Findings from the analysis phase. Which files are affected? What is the scope?]',
    '[技术方案。接口、数据流、架构决策。]',
    '[Technical approach. Interfaces, data flow, architecture decisions.]',
    '[实现阶段的备注。做出的决策、权衡、与设计的偏差。]',
    '[Notes from the code phase. Decisions made, trade-offs, deviations from design.]'
  ]);
  const lines = body.split(/\r?\n/);
  const placeholder = lines.findIndex((line) => placeholders.has(line.trim()));
  if (placeholder >= 0) lines[placeholder] = link;
  else lines.push(...(body ? ['', link] : [link]));
  body = lines.join('\n').replace(/^\n+|\n+$/g, '');
  return { aliases, heading, body };
}

export {
  artifactFamilyCatalog, familySpec,
  inspectTaskArtifacts, inspectArtifactDirectory, resolveArtifactContext,
  resolveCodePlanInput, reviewEventName,
  assertWritableInventory, validateCompletedArtifact, buildArtifactLinkSection
};
export type {
  ArtifactFamily, ArtifactIdentity, ArtifactDiagnostic,
  ArtifactDiagnosticCode, ArtifactError, ArtifactErrorCode,
  ArtifactInventoryResult, ArtifactContextResult, CodeArtifactMode, InspectOptions
};
