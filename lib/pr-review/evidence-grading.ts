import fs from 'node:fs';
import path from 'node:path';

import { parseTaskFrontmatter } from '../task/frontmatter.ts';

// ---------------------------------------------------------------------------
// Host resolution (PL-4): PR -> unique / ambiguous / none.
// ---------------------------------------------------------------------------

export type HostCandidate = {
  taskId: string;
  taskDir: string;
  issueNumber: number | null;
  prNumber: number | null;
};

export type HostResolution =
  | { kind: 'unique'; taskId: string; taskDir: string; issueNumber: number; prNumber: number }
  | { kind: 'ambiguous'; candidates: Array<{ taskId: string; issueNumber: number }> }
  | { kind: 'none' };

export type HostResolutionErrorCode = 'HOST_AMBIGUOUS' | 'HOST_RESOLUTION_INVALID';

export class HostResolutionError extends Error {
  code: HostResolutionErrorCode;

  constructor(code: HostResolutionErrorCode, message: string) {
    super(message);
    this.name = 'HostResolutionError';
    this.code = code;
  }
}

function toPositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parse the PR body for closing-issue references. Handles the conventional
 * `Closes #1` / `Fixes: #2, #3` shapes (case-insensitive, comma/space
 * separated, optional keyword list on the same logical line).
 */
export function extractClosingIssueNumbers(body: string): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  const linePattern = /(?:^|\n)[^\n]*\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b[^\n]*/gi;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = linePattern.exec(body)) !== null) {
    const line = lineMatch[0]!;
    for (const numMatch of line.matchAll(/#(\d+)/g)) {
      const n = Number(numMatch[1]!);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        result.push(n);
      }
    }
  }
  return result;
}

/**
 * Scan `.agents/workspace/active/{task-id}/task.md` files for tasks bound to the
 * PR number or to one of the PR's closing issues. A task is emitted at most once;
 * a direct `pr_number` hit takes priority over the issue-number reverse lookup.
 */
export function collectHostCandidates(input: {
  prNumber: number;
  closingIssues: number[];
  workspaceRoot: string;
}): HostCandidate[] {
  const activeRoot = path.join(input.workspaceRoot, '.agents', 'workspace', 'active');
  const candidates: HostCandidate[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(activeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(activeRoot, entry.name);
    const taskMdPath = path.join(taskDir, 'task.md');
    let content: string;
    try {
      content = fs.readFileSync(taskMdPath, 'utf8');
    } catch {
      continue;
    }
    const frontmatter = parseTaskFrontmatter(content);
    const issueNumber = toPositiveNumber(frontmatter.issue_number);
    const prNumber = toPositiveNumber(frontmatter.pr_number);
    if (prNumber === input.prNumber) {
      candidates.push({ taskId: entry.name, taskDir, issueNumber, prNumber });
    } else if (issueNumber !== null && input.closingIssues.includes(issueNumber)) {
      candidates.push({ taskId: entry.name, taskDir, issueNumber, prNumber });
    }
  }
  return candidates;
}

/**
 * Collapse a candidate list into a typed HostResolution. Zero candidates ->
 * none; exactly one -> unique; more than one (no stable selection rule) ->
 * ambiguous (fail closed, AN-6).
 */
export function resolveHostFromCandidates(candidates: HostCandidate[]): HostResolution {
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    return {
      kind: 'unique',
      taskId: candidate.taskId,
      taskDir: candidate.taskDir,
      issueNumber: candidate.issueNumber ?? 0,
      prNumber: candidate.prNumber ?? 0
    };
  }
  return {
    kind: 'ambiguous',
    candidates: candidates.map((candidate) => ({ taskId: candidate.taskId, issueNumber: candidate.issueNumber ?? 0 }))
  };
}

// ---------------------------------------------------------------------------
// Evidence presence, head state, scenarios, risk and mode (AN-5/6/7, PL-3/5/9).
// ---------------------------------------------------------------------------

export type ArtifactPresence = {
  hasAnalysis: boolean;
  hasPlan: boolean;
  hasCode: boolean;
  hasReviewAnalysis: boolean;
  hasReviewPlan: boolean;
  hasReviewCode: boolean;
  hasPriorPrReview: boolean;
};

export type HeadState = {
  currentHeadSha: string;
  priorHeadSha: string | null;
  issueNumberBound: boolean;
  taskIssueMatches: boolean;
  prNumberBound: boolean;
  taskPrMatches: boolean;
};

export type EvidenceScenario = 'S1' | 'S2' | 'S3';
export type Freshness = 'fresh' | 'stale' | 'n/a';
export type Alignment = 'aligned' | 'misaligned' | 'n/a';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ReviewMode = 'verify' | 'audit' | 'reconstruct';

export type RiskFactors = {
  changeSize: 'LOW' | 'HIGH';
  sensitivity: 'LOW' | 'HIGH';
  structural: 'LOW' | 'HIGH';
  testCoverage: 'LOW' | 'HIGH';
  sourceCredibility: 'LOW' | 'HIGH';
  recoveryImpact: 'LOW' | 'HIGH';
};

export type DecisionRecord = {
  host: HostResolution;
  scenario: EvidenceScenario;
  freshness: Freshness;
  alignment: Alignment;
  risk: RiskLevel;
  mode: ReviewMode;
  firstReview: boolean;
  reason: string;
};

function hasNoLifecycleArtifacts(presence: ArtifactPresence): boolean {
  return !presence.hasAnalysis && !presence.hasPlan && !presence.hasCode &&
    !presence.hasReviewAnalysis && !presence.hasReviewPlan && !presence.hasReviewCode &&
    !presence.hasPriorPrReview;
}

function hasFullArtifacts(presence: ArtifactPresence): boolean {
  return presence.hasAnalysis && presence.hasPlan && presence.hasCode &&
    presence.hasReviewAnalysis && presence.hasReviewPlan && presence.hasReviewCode;
}

function isTrusted(head: HeadState): boolean {
  return head.issueNumberBound && head.taskIssueMatches && (!head.prNumberBound || head.taskPrMatches);
}

/**
 * Derive the S1(a) trust factor `taskIssueMatches` (PL-3) mechanically from
 * resolved data: a unique host is trusted on the issue dimension only when the
 * task's bound issue_number is among the PR's closing issues. Ambiguous/none
 * hosts and tasks without a positive issue_number cannot be confirmed -> false
 * (fail closed to S2/audit). `resolve-host` emits this value so the prompt layer
 * does not derive the trust factor ad hoc (CD-2).
 */
export function deriveTaskIssueMatches(host: HostResolution, closingIssues: number[]): boolean {
  return host.kind === 'unique' && host.issueNumber > 0 && closingIssues.includes(host.issueNumber);
}

/**
 * S1 -> S2 -> S3 classification (analysis §6.1). The ambiguous host is rejected
 * before classification (AN-6 fail closed). S3(a) is host.kind === 'none';
 * S3(b) is a unique task with no lifecycle artifacts and no prior pr-review
 * (PL-5/PL-9 symmetric: any review-only task falls to S2).
 */
export function classifyScenario(host: HostResolution, presence: ArtifactPresence, head: HeadState): EvidenceScenario {
  if (host.kind === 'ambiguous') {
    throw new HostResolutionError('HOST_AMBIGUOUS', 'multiple candidate hosts; resolve before evidence classification');
  }
  if (host.kind === 'none') return 'S3';
  if (hasNoLifecycleArtifacts(presence)) return 'S3';
  const priorHeadMatches = presence.hasPriorPrReview && head.priorHeadSha !== null && head.priorHeadSha === head.currentHeadSha;
  if (hasFullArtifacts(presence) && priorHeadMatches && isTrusted(head)) return 'S1';
  return 'S2';
}

/**
 * Freshness is benchmarked against the prior `pr-review*` reviewed head SHA
 * (analysis §6.2, AN-7). No prior review -> n/a/n/a (first-review special case).
 */
export function evaluateHead(head: HeadState): { freshness: Freshness; alignment: Alignment } {
  if (head.priorHeadSha === null) return { freshness: 'n/a', alignment: 'n/a' };
  const freshness: Freshness = head.priorHeadSha === head.currentHeadSha ? 'fresh' : 'stale';
  const aligned = freshness === 'fresh' && isTrusted(head);
  return { freshness, alignment: aligned ? 'aligned' : 'misaligned' };
}

/**
 * Pure-evidence risk aggregation (analysis §6.3, AN-5): any priority factor
 * (sensitivity / sourceCredibility) HIGH -> HIGH; otherwise any HIGH -> MEDIUM;
 * all LOW -> LOW. Identity factors are structurally absent from the input type.
 */
export function gradeRisk(factors: RiskFactors): RiskLevel {
  const priority = [factors.sensitivity, factors.sourceCredibility] as const;
  if (priority.includes('HIGH')) return 'HIGH';
  const values = Object.values(factors) as Array<'LOW' | 'HIGH'>;
  if (values.includes('HIGH')) return 'MEDIUM';
  return 'LOW';
}

/**
 * verify / audit / reconstruct selection matrix (analysis §6.4). S3 ->
 * reconstruct; S2 -> audit; S1 fresh+aligned -> verify (LOW/MEDIUM risk) or
 * audit (HIGH risk); any other S1 combination falls back to audit.
 */
export function selectMode(scenario: EvidenceScenario, freshness: Freshness, alignment: Alignment, risk: RiskLevel): ReviewMode {
  if (scenario === 'S3') return 'reconstruct';
  if (scenario === 'S2') return 'audit';
  if (freshness === 'fresh' && alignment === 'aligned') {
    return risk === 'HIGH' ? 'audit' : 'verify';
  }
  return 'audit';
}

function buildReason(input: {
  scenario: EvidenceScenario;
  freshness: Freshness;
  alignment: Alignment;
  risk: RiskLevel;
  mode: ReviewMode;
  firstReview: boolean;
  hasPriorPrReview: boolean;
}): string {
  const pieces: string[] = [];
  if (input.firstReview) pieces.push('first review (no prior pr-review head)');
  if (input.hasPriorPrReview) pieces.push(`prior head ${input.freshness}`);
  if (input.freshness === 'fresh') pieces.push(`alignment ${input.alignment}`);
  pieces.push(`evidence scenario ${input.scenario}`);
  pieces.push(`risk ${input.risk}`);
  pieces.push(`mode ${input.mode}`);
  return pieces.join('; ');
}

/**
 * Full decision pipeline: classify -> freshness/alignment -> risk -> mode,
 * producing a traceable DecisionRecord (AC3). Ambiguous hosts are rejected
 * before any classification runs (AN-6).
 */
export function decide(input: {
  host: HostResolution;
  presence: ArtifactPresence;
  head: HeadState;
  riskFactors: RiskFactors;
}): DecisionRecord {
  if (input.host.kind === 'ambiguous') {
    throw new HostResolutionError('HOST_AMBIGUOUS', 'ambiguous host; resolve before evidence classification');
  }
  const scenario = classifyScenario(input.host, input.presence, input.head);
  const { freshness, alignment } = evaluateHead(input.head);
  const risk = gradeRisk(input.riskFactors);
  const mode = selectMode(scenario, freshness, alignment, risk);
  const firstReview = !input.presence.hasPriorPrReview;
  return {
    host: input.host,
    scenario,
    freshness,
    alignment,
    risk,
    mode,
    firstReview,
    reason: buildReason({
      scenario,
      freshness,
      alignment,
      risk,
      mode,
      firstReview,
      hasPriorPrReview: input.presence.hasPriorPrReview
    })
  };
}

export {
  hasFullArtifacts,
  hasNoLifecycleArtifacts,
  isTrusted
};
