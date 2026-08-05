import path from 'node:path';
// Verification runs in-process; configuration, review parsing and platform
// checks are provided by typed domain modules without a stdout protocol.
import { verifyInProcess } from './verification-engine.ts';

import { parseArtifactName } from './artifact-lifecycle.ts';
import type { ArtifactFamily } from './artifact-lifecycle.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import type { TaskWorkspaceState } from './resolve-ref.ts';

type VerificationEvent =
  | 'analyze.awaiting-input' | 'analyze.completed'
  | 'review-analysis.completed' | 'plan.completed' | 'review-plan.completed'
  | 'code.completed' | 'review-code.completed' | 'manual-validation.completed'
  | 'block-task.completed' | 'cancel-task.completed' | 'commit.completed'
  | 'complete-task.preflight' | 'complete-task.completed'
  | 'create-pr.completed' | 'create-task.completed'
  | 'import-codescan.completed' | 'import-dependabot.completed'
  | 'import-issue.completed' | 'watch-pr.completed'
  | 'run-task.paused' | 'run-task.completed';
type VerificationSpec = {
  skill: string;
  expectedState: 'active' | 'blocked' | 'completed';
  mode: 'gate' | 'checks';
  checks?: readonly string[];
  artifactFamily?: ArtifactFamily;
};
type VerificationInvocation = {
  status: 'pass' | 'fail' | 'blocked';
  exitCode: 0 | 1 | 2;
  payload: Record<string, unknown>;
};
type TaskVerificationResult = {
  status: 'pass' | 'fail' | 'blocked' | 'failed';
  changed: false;
  event: VerificationEvent | string;
  requestRef: string;
  taskId: string | null;
  taskDir: string | null;
  taskState: TaskWorkspaceState | null;
  skill: string | null;
  mode: 'gate' | 'checks' | null;
  artifact: string | null;
  invocations: readonly VerificationInvocation[];
  error: { code: string; message: string } | null;
};
type VerificationOptions = {
  repoRoot?: string;
  engine?: typeof verifyInProcess;
};

const gate = (skill: string, expectedState: VerificationSpec['expectedState'], artifactFamily?: ArtifactFamily): VerificationSpec => ({
  skill, expectedState, mode: 'gate', ...(artifactFamily ? { artifactFamily } : {})
});
const VERIFICATION_CATALOG: Readonly<Record<VerificationEvent, VerificationSpec>> = {
  'analyze.awaiting-input': { skill: 'analyze-task', expectedState: 'active', mode: 'checks', checks: ['task-meta'] },
  'analyze.completed': gate('analyze-task', 'active', 'analysis'),
  'review-analysis.completed': gate('review-analysis', 'active', 'review-analysis'),
  'plan.completed': gate('plan-task', 'active', 'plan'),
  'review-plan.completed': gate('review-plan', 'active', 'review-plan'),
  'code.completed': gate('code-task', 'active', 'code'),
  'review-code.completed': gate('review-code', 'active', 'review-code'),
  'manual-validation.completed': gate('complete-manual-validation', 'active', 'manual-validation'),
  'block-task.completed': gate('block-task', 'blocked'),
  'cancel-task.completed': gate('cancel-task', 'completed'),
  'commit.completed': gate('commit', 'active'),
  'complete-task.preflight': { skill: 'complete-task', expectedState: 'active', mode: 'checks', checks: ['review-ledger', 'manual-validation', 'post-review-commit', 'platform-sync-preflight'] },
  'complete-task.completed': gate('complete-task', 'completed'),
  'create-pr.completed': gate('create-pr', 'active'),
  'create-task.completed': gate('create-task', 'active'),
  'import-codescan.completed': gate('import-codescan', 'active'),
  'import-dependabot.completed': gate('import-dependabot', 'active'),
  'import-issue.completed': gate('import-issue', 'active'),
  'watch-pr.completed': gate('watch-pr', 'active'),
  'run-task.paused': { skill: 'run-task', expectedState: 'active', mode: 'checks', checks: ['orchestration-state'] },
  'run-task.completed': { skill: 'run-task', expectedState: 'active', mode: 'checks', checks: ['orchestration-state'] }
};

function failure(request: { taskRef: string; event: string; artifact?: string }, code: string, message: string, extra: Partial<TaskVerificationResult> = {}): TaskVerificationResult {
  return {
    status: 'failed', changed: false, event: request.event, requestRef: request.taskRef,
    taskId: null, taskDir: null, taskState: null, skill: null, mode: null,
    artifact: request.artifact ?? null, invocations: [], error: { code, message }, ...extra
  };
}

function verifyTaskEvent(request: { taskRef: string; event: string; artifact?: string }, options: VerificationOptions = {}): TaskVerificationResult {
  const spec = VERIFICATION_CATALOG[request.event as VerificationEvent];
  if (!spec) return failure(request, 'VERIFY_EVENT_UNKNOWN', `unknown verification event '${request.event}'`);
  const resolved = resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return failure(request, resolved.code, resolved.message, { taskId: resolved.taskId, skill: spec.skill, mode: spec.mode });
  const identity = { taskId: resolved.taskId, taskDir: resolved.taskDir, taskState: resolved.state, skill: spec.skill, mode: spec.mode } as const;
  if (resolved.state !== spec.expectedState) {
    return failure(request, 'VERIFY_TASK_STATE_MISMATCH', `event '${request.event}' requires workspace '${spec.expectedState}', received '${resolved.state}'`, identity);
  }
  if (spec.artifactFamily) {
    if (!request.artifact) return failure(request, 'VERIFY_ARTIFACT_REQUIRED', `event '${request.event}' requires an artifact`, identity);
    const parsed = parseArtifactName(request.artifact);
    if (path.basename(request.artifact) !== request.artifact || !parsed || parsed.family !== spec.artifactFamily) {
      return failure(request, 'VERIFY_ARTIFACT_INVALID', `artifact '${request.artifact}' is not a canonical ${spec.artifactFamily} artifact`, identity);
    }
  } else if (request.artifact) {
    return failure(request, 'VERIFY_ARTIFACT_UNEXPECTED', `event '${request.event}' does not accept an artifact`, identity);
  }

  const invocations: VerificationInvocation[] = [];
  const engine = options.engine ?? verifyInProcess;
  if (spec.mode === 'gate') {
    const payload = engine({ mode: 'gate', skillName: spec.skill, taskDir: resolved.taskDir, artifactFile: request.artifact, checks: [], repositoryRoot: resolved.repoRoot }) as Record<string, unknown>;
    const status = payload.gate as 'pass' | 'fail' | 'blocked';
    invocations.push({ status, exitCode: ({ pass: 0, fail: 1, blocked: 2 } as const)[status], payload });
  } else {
    for (const check of spec.checks ?? []) {
      const payload = engine({ mode: 'checks', skillName: spec.skill, taskDir: resolved.taskDir, artifactFile: request.artifact, checks: [check], repositoryRoot: resolved.repoRoot }) as Record<string, unknown>;
      const status = payload.status as 'pass' | 'fail' | 'blocked';
      invocations.push({ status, exitCode: ({ pass: 0, fail: 1, blocked: 2 } as const)[status], payload });
      if (status !== 'pass') break;
    }
  }
  const status = invocations.some((item) => item.status === 'blocked') ? 'blocked'
    : invocations.some((item) => item.status === 'fail') ? 'fail' : 'pass';
  return {
    status, changed: false, event: request.event, requestRef: request.taskRef,
    ...identity, artifact: request.artifact ?? null, invocations, error: null
  };
}

function statusLabel(status: unknown): string {
  return status === 'fail' ? 'FAIL' : status === 'blocked' ? 'BLOCKED' : 'pass';
}

function renderPayload(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  if (Array.isArray(payload.checks)) {
    lines.push(`Verification: ${payload.gate} | Skill: ${payload.skill}`, '');
    for (const check of payload.checks as Array<Record<string, unknown>>) {
      lines.push(`  [${statusLabel(check.status)}] ${check.type} - ${check.message}`);
    }
    lines.push('', `Result: ${payload.summary} - ${payload.action}`);
  } else {
    lines.push(`Check: ${payload.status} | Skill: ${payload.skill} | Type: ${payload.type}`, '');
    lines.push(`  [${statusLabel(payload.status)}] ${payload.type} - ${payload.message}`);
    const summary = payload.status === 'pass' ? '1 passed, 0 failed'
      : payload.status === 'blocked' ? '0 passed, 0 failed, 1 blocked' : '0 passed, 1 failed';
    const action = payload.status === 'pass' ? 'Requested check passed'
      : payload.status === 'blocked' ? `Resolve blocked ${payload.type} check and re-run check`
        : `Fix ${payload.type} issues and re-run check`;
    lines.push('', `Result: ${summary} - ${action}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderTaskVerification(result: TaskVerificationResult): string {
  if (result.status === 'failed') return `Verification failed: ${result.error?.code ?? 'VERIFY_FAILED'} - ${result.error?.message ?? 'unknown error'}\n`;
  return result.invocations.map((invocation) => renderPayload(invocation.payload)).join('');
}

export { VERIFICATION_CATALOG, renderTaskVerification, verifyTaskEvent };
export type { TaskVerificationResult, VerificationEvent, VerificationInvocation, VerificationOptions, VerificationSpec };
