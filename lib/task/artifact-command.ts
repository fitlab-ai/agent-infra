import fs from 'node:fs';

import { resolveArtifactContext, hasOpenArtifactRound } from './artifact-lifecycle.ts';
import { parseArtifactName } from './artifact-name.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { getArtifactSchema } from './artifact-schema.ts';
import { finalizeLocalArtifact, preflightLocalArtifact } from './local-artifact-finalization.ts';
import { initializeArtifactSkeleton } from './artifact-operations.ts';

export type ArtifactCommand = Readonly<{
  taskRef: string;
  operation: 'inspect' | 'init' | 'preflight' | 'finalize-local';
  family: string;
  artifact: string;
  locale?: 'zh-CN' | 'en';
}>;

/** One option contract for the CLI and trusted projection executor. */
export function parseArtifactCommand(args: readonly string[]): ArtifactCommand {
  const [taskRef, operation] = args;
  if (!taskRef || !['inspect', 'init', 'preflight', 'finalize-local'].includes(operation ?? '')) {
    throw new Error('task ref and a supported artifact operation are required');
  }
  const fields: Record<string, string> = {};
  const allowed = {
    inspect: ['--family'],
    init: ['--family', '--artifact', '--locale'],
    'preflight': ['--family', '--artifact'],
    'finalize-local': ['--family', '--artifact']
  }[operation as ArtifactCommand['operation']];
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.includes(flag)) throw new Error(`unknown option '${flag}'`);
    if (Object.hasOwn(fields, flag)) throw new Error(`duplicate option '${flag}'`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`option '${flag}' requires a value`);
    fields[flag] = value;
  }
  if (!fields['--family']) throw new Error("option '--family' is required");
  if (operation !== 'inspect' && !fields['--artifact']) throw new Error("option '--artifact' is required");
  const locale = fields['--locale'];
  if (locale !== undefined && locale !== 'zh-CN' && locale !== 'en') throw new Error("option '--locale' must be 'zh-CN' or 'en'");
  return {
    taskRef, operation: operation as ArtifactCommand['operation'], family: fields['--family'],
    artifact: fields['--artifact'] ?? '', locale
  };
}
/** Resolve authoritative task metadata separately from a trusted candidate directory. */
export function executeArtifactCommand(
  command: ArtifactCommand,
  options: Readonly<{ repoRoot?: string; artifactDir?: string }> = {}
): Record<string, unknown> {
  const { taskRef, operation, family, artifact, locale } = command;
  const fail = (code: string, message: string) => ({ status: 'failed', changed: false, error: { code, message } });
  if (operation === 'inspect') {
    const result = resolveArtifactContext(taskRef, family, { repoRoot: options.repoRoot });
    return family === 'code' && result.codeMode ? {
      ...result, mode: result.codeMode.mode, code_max: result.codeMode.codeMax, rev_max: result.codeMode.reviewMax,
      verdict: result.codeMode.verdict, next_round: result.next?.round ?? null, next_artifact: result.next?.name ?? null,
      review_artifact: result.codeMode.reviewArtifact, implementation_input: result.codeMode.implementationInput,
      decision_id: result.codeMode.decisionId, decision_evidence: result.codeMode.decisionEvidence, message: result.codeMode.message
    } : { ...result };
  }
  const resolved = resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) return fail(resolved.code, resolved.message);
  const schema = getArtifactSchema(family);
  const parsed = parseArtifactName(artifact);
  if (!schema || !parsed || parsed.family !== family) {
    return fail('ARTIFACT_IDENTITY_INVALID', `artifact '${artifact}' does not match ${family}`);
  }
  const taskDir = options.artifactDir ?? resolved.taskDir;
  const identity = { taskId: resolved.taskId, taskDir, family, artifact };
  const input = { repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskDir, family: schema.family, artifact };
  if (operation === 'init') {
    const context = resolveArtifactContext(taskRef, family, { repoRoot: resolved.repoRoot });
    if (context.status !== 'ready' || (context.next?.name !== artifact && !hasOpenArtifactRound(fs.readFileSync(resolved.taskMdPath, 'utf8'), family, parsed.round))) {
      return fail('ARTIFACT_INIT_CONTEXT_INVALID', context.error?.message ?? `artifact '${artifact}' is not the next ${family} artifact`);
    }
    return { ...initializeArtifactSkeleton({ ...input, ...(locale ? { locale } : {}) }), ...identity };
  }
  if (family !== 'analysis' && family !== 'plan' && family !== 'code') {
    return fail('ARTIFACT_PAYLOAD_INVALID', "preflight and finalize-local only support 'analysis', 'plan', and 'code'");
  }
  if (operation === 'preflight') return { ...preflightLocalArtifact({ taskRef, family, artifact, repoRoot: resolved.repoRoot }) };
  return { ...finalizeLocalArtifact({ taskRef, family, artifact, repoRoot: resolved.repoRoot }) };
}
