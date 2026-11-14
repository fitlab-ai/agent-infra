import fs from 'node:fs';
import path from 'node:path';

import { resolveArtifactContext, hasOpenArtifactRound } from './artifact-lifecycle.ts';
import { parseArtifactName } from './artifact-name.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { finalizeLocalArtifact, preflightLocalArtifact } from './local-artifact-finalization.ts';
import { initializeArtifactSkeleton } from './artifact-operations.ts';
import type { TriggerReason } from './capabilities.ts';

export type ArtifactCommand = Readonly<{
  taskRef: string;
  operation: 'inspect' | 'init' | 'preflight' | 'finalize-local';
  family: string;
  artifact: string;
  locale?: 'zh-CN' | 'en';
  reasonCode?: TriggerReason;
  sourceFinding?: string;
  sourceArtifact?: string;
  sourceSha256?: string;
}>;

function parseArtifactOptions(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.includes(flag)) throw new Error(`unknown option '${flag}'`);
    if (Object.hasOwn(fields, flag)) throw new Error(`duplicate option '${flag}'`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`option '${flag}' requires a value`);
    fields[flag] = value;
  }
  return fields;
}

/** One option contract for the CLI and trusted projection executor. */
export function parseArtifactCommand(args: readonly string[]): ArtifactCommand {
  const [taskRef, operation] = args;
  if (!taskRef || !['inspect', 'init', 'preflight', 'finalize-local'].includes(operation ?? '')) {
    throw new Error('task ref and a supported artifact operation are required');
  }
  const allowed = {
    inspect: ['--family', '--reason-code', '--source-finding', '--source-artifact', '--source-sha256'],
    init: ['--family', '--artifact', '--locale'],
    'preflight': ['--family', '--artifact'],
    'finalize-local': ['--family', '--artifact']
  }[operation as ArtifactCommand['operation']];
  const fields = parseArtifactOptions(args, allowed);
  if (!fields['--family']) throw new Error("option '--family' is required");
  if (operation !== 'inspect' && !fields['--artifact']) throw new Error("option '--artifact' is required");
  const locale = fields['--locale'];
  if (locale !== undefined && locale !== 'zh-CN' && locale !== 'en') throw new Error("option '--locale' must be 'zh-CN' or 'en'");
  const reasonCode = fields['--reason-code'];
  if (reasonCode !== undefined && !['user-request', 'new-requirement', 'upstream-fact-doubt', 'review-finding', 'manual-review-supplement', 'retry', 'validation-rerun'].includes(reasonCode)) {
    throw new Error("option '--reason-code' is invalid");
  }
  return {
    taskRef, operation: operation as ArtifactCommand['operation'], family: fields['--family'] ?? '',
    artifact: fields['--artifact'] ?? '', locale, reasonCode: reasonCode as TriggerReason | undefined,
    sourceFinding: fields['--source-finding'], sourceArtifact: fields['--source-artifact'],
    sourceSha256: fields['--source-sha256']
  };
}

function artifactCommandFailure(code: string, message: string): Record<string, unknown> {
  return { status: 'failed', changed: false, error: { code, message } };
}

function inspectArtifactCommand(
  command: ArtifactCommand,
  repoRoot: string | undefined
): Record<string, unknown> {
  const result = resolveArtifactContext(command.taskRef, command.family, {
    repoRoot,
    reasonCode: command.reasonCode,
    sourceFinding: command.sourceFinding,
    sourceArtifact: command.sourceArtifact,
    sourceSha256: command.sourceSha256
  });
  if (command.family !== 'code' || !result.codeMode) return { ...result };
  return {
    ...result,
    mode: result.codeMode.mode,
    code_max: result.codeMode.codeMax,
    rev_max: result.codeMode.reviewMax,
    verdict: result.codeMode.verdict,
    next_round: result.next?.round ?? null,
    next_artifact: result.next?.name ?? null,
    review_artifact: result.codeMode.reviewArtifact,
    implementation_input: result.codeMode.implementationInput,
    decision_id: result.codeMode.decisionId,
    decision_evidence: result.codeMode.decisionEvidence,
    message: result.codeMode.message
  };
}

function initializeArtifactCommand(
  command: ArtifactCommand,
  resolved: ReturnType<typeof resolveTaskRef> & { ok: true },
  schema: NonNullable<ReturnType<typeof getArtifactSchema>>,
  parsed: NonNullable<ReturnType<typeof parseArtifactName>>,
  taskDir: string
): Record<string, unknown> {
  const context = resolveArtifactContext(command.taskRef, command.family, { repoRoot: resolved.repoRoot });
  const existingCandidate = path.join(taskDir, command.artifact);
  let matchingInitializedSkeleton = false;
  try {
    const existing = fs.readFileSync(existingCandidate, 'utf8');
    matchingInitializedSkeleton = existing.includes(`<!-- artifact-context:${resolved.taskId}:${command.family}:${parsed.round} -->`);
  } catch { /* an absent candidate is created only for the selected identity */ }
  if ((context.status !== 'ready' && !matchingInitializedSkeleton) || (context.next?.name !== command.artifact
    && !hasOpenArtifactRound(taskDir, fs.readFileSync(resolved.taskMdPath, 'utf8'), schema.family, parsed.round)
    && !matchingInitializedSkeleton)) {
    return artifactCommandFailure('ARTIFACT_INIT_CONTEXT_INVALID', context.error?.message ?? `artifact '${command.artifact}' is not the next ${command.family} artifact`);
  }
  return {
    ...initializeArtifactSkeleton({
      repoRoot: resolved.repoRoot,
      taskId: resolved.taskId,
      taskDir,
      family: schema.family,
      artifact: command.artifact,
      ...(command.locale ? { locale: command.locale } : {})
    }),
    taskId: resolved.taskId,
    taskDir,
    family: command.family,
    artifact: command.artifact
  };
}

function finalizeArtifactCommand(
  command: ArtifactCommand,
  resolved: ReturnType<typeof resolveTaskRef> & { ok: true }
): Record<string, unknown> {
  if (command.family !== 'analysis' && command.family !== 'plan' && command.family !== 'code') {
    return artifactCommandFailure('ARTIFACT_PAYLOAD_INVALID', "preflight and finalize-local only support 'analysis', 'plan', and 'code'");
  }
  if (command.operation === 'preflight') {
    return preflightLocalArtifact({
      taskRef: command.taskRef, family: command.family, artifact: command.artifact, repoRoot: resolved.repoRoot
    });
  }
  return finalizeLocalArtifact({
    taskRef: command.taskRef, family: command.family, artifact: command.artifact, repoRoot: resolved.repoRoot
  });
}

/** Resolve authoritative task metadata separately from a trusted candidate directory. */
export function executeArtifactCommand(
  command: ArtifactCommand,
  options: Readonly<{ repoRoot?: string; artifactDir?: string }> = {}
): Record<string, unknown> {
  if (command.operation === 'inspect') return inspectArtifactCommand(command, options.repoRoot);
  const resolved = resolveTaskRef(command.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return artifactCommandFailure(resolved.code, resolved.message);
  const schema = getArtifactSchema(command.family);
  const parsed = parseArtifactName(command.artifact);
  if (!schema || !parsed || parsed.family !== command.family) {
    return artifactCommandFailure('ARTIFACT_IDENTITY_INVALID', `artifact '${command.artifact}' does not match ${command.family}`);
  }
  const taskDir = options.artifactDir ?? resolved.taskDir;
  if (command.operation === 'init') return initializeArtifactCommand(command, resolved, schema, parsed, taskDir);
  return finalizeArtifactCommand(command, resolved);
}
