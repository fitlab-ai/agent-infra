import fs from 'node:fs';
import path from 'node:path';

import { resolveTaskRef } from './resolve-ref.ts';
import type { ResolveTaskRefErrorCode, TaskWorkspaceState } from './resolve-ref.ts';
import { locateActivityLog } from './activity-log.ts';
import { parseImplementationInputs, selectPendingImplementationInput } from './implementation-inputs.ts';
import { parseVerdict } from './review-artifacts.ts';
import { extractSection, findSectionHeading } from './sections.ts';

const artifactFamilyCatalog = [
  { family: 'analysis', sectionAliases: ['分析', 'Analysis'], heading: '分析', labels: ['需求分析报告', 'Requirements Analysis'] },
  { family: 'review-analysis', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['需求分析审查', 'Analysis Review'] },
  { family: 'plan', sectionAliases: ['设计', 'Design'], heading: '设计', labels: ['技术方案', 'Technical Plan'] },
  { family: 'review-plan', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['技术方案审查', 'Plan Review'] },
  { family: 'code', sectionAliases: ['实现备注', 'Implementation Notes'], heading: '实现备注', labels: ['实现报告', 'Implementation Report'] },
  { family: 'review-code', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['代码审查', 'Code Review'] },
  { family: 'manual-validation', sectionAliases: ['实现备注', 'Implementation Notes'], heading: '实现备注', labels: ['人工验证', 'Manual Validation'] },
  { family: 'validation-run', sectionAliases: ['实现备注', 'Implementation Notes'], heading: '实现备注', labels: ['验证运行证据', 'Validation Run Evidence'] },
  { family: 'pr-review', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['PR 审查报告', 'PR Review Report'] }
] as const;

type ArtifactFamily = (typeof artifactFamilyCatalog)[number]['family'];
type ArtifactFamilySpec = (typeof artifactFamilyCatalog)[number];
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
  | 'FILESYSTEM_RACE' | 'CATALOG_CONFLICT' | 'BROKEN_REFERENCE';
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
  | 'ARTIFACT_IDENTITY_INVALID' | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_NOT_REGULAR' | 'ARTIFACT_NOT_READABLE' | 'ARTIFACT_MODE_REFUSED';
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
  latest: ArtifactIdentity | null;
  next: { round: number; name: string } | null;
  reviewedInput: ArtifactIdentity | null;
  diagnostics: readonly ArtifactDiagnostic[];
  error: ArtifactError | null;
};
type ArtifactContextStatus = 'ready' | 'refused' | 'failed';
type CodeArtifactMode = 'init' | 'fix' | 'decision' | 'refused' | 'error';
type ArtifactContextResult = Omit<ArtifactInventoryResult, 'status'> & {
  status: ArtifactContextStatus;
  inputs: readonly ArtifactIdentity[];
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
type InspectOptions = { repoRoot?: string };

const FAMILY_SET = new Set<string>(artifactFamilyCatalog.map((item) => item.family));
const BLOCKING_DIAGNOSTICS = new Set<ArtifactDiagnosticCode>([
  'NONCANONICAL_NAME', 'ROUND_OUT_OF_RANGE', 'MISSING_BASE', 'ROUND_GAP',
  'DUPLICATE_LOGICAL_ROUND', 'NON_REGULAR_FILE', 'SYMBOLIC_LINK',
  'FILESYSTEM_RACE', 'CATALOG_CONFLICT'
]);

function familySpec(family: string): ArtifactFamilySpec | null {
  return artifactFamilyCatalog.find((item) => item.family === family) ?? null;
}

function artifactName(family: ArtifactFamily, round: number): string {
  if (!FAMILY_SET.has(family)) throw new Error(`unknown artifact family '${family}'`);
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('artifact round must be a safe positive integer');
  return round === 1 ? `${family}.md` : `${family}-r${round}.md`;
}

function parseArtifactName(name: string): { family: ArtifactFamily; round: number; name: string } | null {
  if (path.basename(name) !== name) return null;
  const matches: Array<{ family: ArtifactFamily; round: number; name: string }> = [];
  for (const spec of artifactFamilyCatalog) {
    if (name === `${spec.family}.md`) matches.push({ family: spec.family, round: 1, name });
    const match = new RegExp(`^${escapeRegExp(spec.family)}-r([1-9]\\d*)\\.md$`).exec(name);
    if (!match) continue;
    const round = Number(match[1]);
    if (Number.isSafeInteger(round) && round >= 2 && String(round) === match[1]) {
      matches.push({ family: spec.family, round, name });
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failure(requestRef: string, family: string, error: ArtifactError, extra: Partial<ArtifactInventoryResult> = {}): ArtifactInventoryResult {
  return {
    status: 'failed', changed: false, requestRef, taskId: null, taskDir: null,
    taskState: null, family, artifacts: [], latest: null, next: null,
    reviewedInput: null, diagnostics: [], error, ...extra
  };
}

function diagnostic(code: ArtifactDiagnosticCode, family: ArtifactFamily, name: string | null, message: string): ArtifactDiagnostic {
  return { code, family, name, message };
}

function inspectTaskArtifacts(taskRef: string, family: string, options: InspectOptions = {}): ArtifactInventoryResult {
  const spec = familySpec(family);
  if (!spec) return failure(taskRef, family, { code: 'ARTIFACT_FAMILY_UNKNOWN', message: `unknown artifact family '${family}'` });
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
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
  const artifacts: ArtifactIdentity[] = [];
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
      artifacts.push({ ...parsed, path: abs, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      diagnostics.push(diagnostic('FILESYSTEM_RACE', family, entry.name, String(error)));
    }
  }
  artifacts.sort((left, right) => left.round - right.round);
  const rounds = new Set(artifacts.map((item) => item.round));
  if (artifacts.length > 0 && !rounds.has(1)) diagnostics.push(diagnostic('MISSING_BASE', family, null, `${family}.md is missing`));
  const max = artifacts.at(-1)?.round ?? 0;
  for (let round = 1; round <= max; round += 1) {
    if (!rounds.has(round)) diagnostics.push(diagnostic('ROUND_GAP', family, null, `${artifactName(family, round)} is missing`));
  }
  const latest = artifacts.at(-1) ?? null;
  const reviewedInput = family.startsWith('review-') && latest
    ? resolveReviewedInput(taskDir, latest, family === 'review-analysis' ? 'analysis' : family === 'review-plan' ? 'plan' : 'code', diagnostics)
    : null;
  return {
    status: 'ready', changed: false, requestRef, taskId: identity.taskId ?? null,
    taskDir, taskState: identity.taskState ?? null, family, artifacts, latest,
    next: { round: max + 1, name: artifactName(family, max + 1) },
    reviewedInput, diagnostics, error: null
  };
}

function resolveReviewedInput(
  taskDir: string,
  review: ArtifactIdentity,
  expectedFamily: ArtifactFamily,
  diagnostics: ArtifactDiagnostic[]
): ArtifactIdentity | null {
  let content: string;
  try { content = fs.readFileSync(review.path, 'utf8'); }
  catch (error) {
    diagnostics.push(diagnostic('BROKEN_REFERENCE', review.family, review.name, String(error)));
    return null;
  }
  const lines = content.split(/\r?\n/);
  const header = lines.findIndex((line) => /\*\*(?:审查输入|Review Input)\*\*[:：]/.test(line));
  const referenceBlock = header >= 0 ? lines.slice(header, header + 12).join('\n') : '';
  const candidates = [...referenceBlock.matchAll(/`([^`]+\.md)`/g)].map((match) => match[1]!);
  const parsed = candidates.map((name) => parseArtifactName(name)).find((item) => item?.family === expectedFamily);
  if (!parsed) {
    diagnostics.push(diagnostic('BROKEN_REFERENCE', review.family, review.name, `${review.name} does not reference a canonical ${expectedFamily} artifact`));
    return null;
  }
  const abs = path.join(taskDir, parsed.name);
  try {
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('referenced input is not a regular file');
    if (stat.mtimeMs > review.mtimeMs) {
      diagnostics.push(diagnostic('BROKEN_REFERENCE', review.family, review.name, `${parsed.name} is newer than ${review.name}`));
      return null;
    }
    return { ...parsed, path: abs, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    diagnostics.push(diagnostic('BROKEN_REFERENCE', review.family, review.name, `${parsed.name}: ${String(error)}`));
    return null;
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
  'review-analysis': 'analysis', plan: 'analysis', 'review-plan': 'plan', 'review-code': 'code'
};
const OPTIONAL_CONTEXT: Partial<Record<ArtifactFamily, { family: ArtifactFamily; requireReference?: boolean }>> = {
  analysis: { family: 'review-analysis', requireReference: true },
  plan: { family: 'review-plan', requireReference: true },
  'review-code': { family: 'review-plan' },
  'manual-validation': { family: 'review-code' },
  'validation-run': { family: 'review-code' }
};

function resolveArtifactContext(taskRef: string, family: string, options: InspectOptions = {}): ArtifactContextResult {
  const inventory = inspectTaskArtifacts(taskRef, family, options);
  if (inventory.status === 'failed') return { ...inventory, inputs: [], codeMode: null };
  const writableError = assertWritableInventory(inventory);
  if (writableError) return { ...inventory, status: 'failed', inputs: [], codeMode: null, error: writableError };
  if (inventory.family === 'code') return resolveCodeContext(inventory, options);
  const required = REQUIRED_INPUT[inventory.family as ArtifactFamily];
  const inputs: ArtifactIdentity[] = [];
  if (required) {
    const input = inspectTaskArtifacts(taskRef, required, options);
    if (input.status === 'failed' || !input.latest) {
      return { ...inventory, status: 'failed', inputs, codeMode: null, error: { code: 'ARTIFACT_INPUT_MISSING', message: `latest ${required} artifact is required` } };
    }
    inputs.push(input.latest);
  }
  const optional = OPTIONAL_CONTEXT[inventory.family as ArtifactFamily];
  if (optional) {
    const context = inspectTaskArtifacts(taskRef, optional.family, options);
    if (context.status === 'ready' && context.latest) {
      if (optional.requireReference && !context.reviewedInput) {
        return { ...inventory, status: 'failed', inputs, codeMode: null, error: { code: 'ARTIFACT_REFERENCE_INVALID', message: `${context.latest.name} has no valid reviewed input` } };
      }
      inputs.push(context.latest);
    }
  }
  return { ...inventory, inputs, codeMode: null };
}

function resolveCodeContext(inventory: ArtifactInventoryResult, options: InspectOptions): ArtifactContextResult {
  const taskRef = inventory.requestRef;
  const plan = inspectTaskArtifacts(taskRef, 'plan', options);
  if (plan.status === 'failed' || !plan.latest) return contextFailure(inventory, 'ARTIFACT_INPUT_MISSING', 'latest plan artifact is required');
  const reviewPlan = inspectTaskArtifacts(taskRef, 'review-plan', options);
  const reviewCode = inspectTaskArtifacts(taskRef, 'review-code', options);
  const latestCode = inventory.latest;
  const codeMax = latestCode?.round ?? 0;
  const reviewMax = reviewCode.latest?.round ?? 0;
  const inputs = [plan.latest];
  if (!latestCode) {
    if (!reviewPlan.latest || reviewPlan.reviewedInput?.name !== plan.latest.name) {
      return contextFailure(inventory, 'ARTIFACT_INPUT_MISSING', `latest plan '${plan.latest.name}' requires a matching approved review-plan`);
    }
    const verdict = parseVerdict(reviewPlan.latest.path);
    if (!verdict.ok) return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', verdict.message, reviewPlan.latest.name);
    if (verdict.verdict !== 'Approved') {
      return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', `latest ${reviewPlan.latest.name} is not approved`, reviewPlan.latest.name);
    }
    return withCodeMode(inventory, inputs, 'ready', 'init', codeMax, reviewMax, null, null,
      'No prior code artifact. Starting initial implementation (round 1 -> code.md).');
  }
  if (reviewPlan.latest && reviewPlan.reviewedInput?.name === plan.latest.name) {
    const verdict = parseVerdict(reviewPlan.latest.path);
    if (verdict.ok && verdict.verdict === 'Approved' && reviewPlan.latest.mtimeMs > latestCode.mtimeMs) {
      return withCodeMode(inventory, inputs, 'ready', 'init', codeMax, reviewMax, verdict.verdict, reviewPlan.latest.name,
        `Latest ${reviewPlan.latest.name} is approved and newer than the latest code artifact. Entering replan-driven init.`);
    }
  }
  if (reviewMax < codeMax) {
    const expected = artifactName('review-code', codeMax);
    return contextFailure(inventory, 'ARTIFACT_INPUT_MISSING', `${expected} is required before another code round`, expected);
  }
  const review = reviewCode.latest;
  if (!review) return contextFailure(inventory, 'ARTIFACT_INPUT_MISSING', 'latest review-code artifact is required');
  const verdict = parseVerdict(review.path);
  if (!verdict.ok) return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', verdict.message);
  if (verdict.verdict === 'Approved') {
    const decision = resolveDecisionImplementationInput(inventory, review);
    if ('error' in decision) return contextFailure(inventory, 'ARTIFACT_REFERENCE_INVALID', decision.error, review.name);
    if (decision.input) {
      return withCodeMode(
        inventory, [...inputs, review], 'ready', 'decision', codeMax, reviewMax,
        verdict.verdict, review.name, `Implementation input ${decision.input.id} requires a new code round.`,
        decision.input.id, decision.input.ledgerId, decision.input.decisionEvidence
      );
    }
  }
  if (verdict.verdict === 'Approved' || verdict.verdict === 'Rejected') {
    return withCodeMode(inventory, [...inputs, review], 'refused', 'refused', codeMax, reviewMax, verdict.verdict, review.name,
      verdict.verdict === 'Approved'
        ? `Latest ${review.name} verdict is Approved with no findings. Nothing to fix. Run /commit to proceed.`
        : `Latest ${review.name} verdict is Rejected. Re-plan before re-running code-task.`);
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
  const activity = locateActivityLog(content);
  if (!activity) return { error: 'task has no unique Activity Log section' };
  const completed = activity.entries.some((entry) =>
    /^Review Code \(Round \d+\)$/.test(entry.step) && entry.note.includes(`→ ${review.name}`)
  );
  if (!completed) return { error: `cannot find completed Activity Log identity for ${review.name}` };
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
  const link = `[${label}](${artifact.name})`;
  let body = extractSection(content, aliases);
  if (body.includes(`](${artifact.name})`)) return { aliases, heading, body };
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
  artifactFamilyCatalog, artifactName, parseArtifactName, familySpec,
  inspectTaskArtifacts, inspectArtifactDirectory, resolveArtifactContext,
  assertWritableInventory, validateCompletedArtifact, buildArtifactLinkSection
};
export type {
  ArtifactFamily, ArtifactFamilySpec, ArtifactIdentity, ArtifactDiagnostic,
  ArtifactDiagnosticCode, ArtifactError, ArtifactErrorCode,
  ArtifactInventoryResult, ArtifactContextResult, CodeArtifactMode, InspectOptions
};
