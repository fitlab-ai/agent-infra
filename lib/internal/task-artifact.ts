import fs from 'node:fs';
import path from 'node:path';

import { resolveArtifactContext } from '../task/artifact-lifecycle.ts';
import { parseArtifactName } from '../task/artifact-lifecycle.ts';
import { finalizeLocalArtifact } from '../task/local-artifact-finalization.ts';
import type { LocalArtifactFamily } from '../task/local-artifact-finalization.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { loadVerificationConfig } from '../task/verification-config.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';
import { getArtifactSchema } from '../task/artifact-schema.ts';
import {
  applyArtifactRepair,
  initializeArtifactSkeleton,
  inspectArtifactStructure
} from '../task/artifact-operations.ts';

const USAGE = `Usage: agent-infra-internal task-artifact <N | TASK-id> inspect --family <family>\n       agent-infra-internal task-artifact <N | TASK-id> init --family <family> --artifact <artifact> [--locale <zh-CN|en>]\n       agent-infra-internal task-artifact <N | TASK-id> repair --family <family> --artifact <artifact> --expected-sha256 <sha256> --expected-semantic-digest <digest>\n       agent-infra-internal task-artifact <N | TASK-id> finalize-local --family <analysis|plan|code> --artifact <artifact>\n\nInspect, initialize, repair, or finalize a workflow artifact without changing task state.\n`;

function failUsage(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function taskArtifact(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-artifact', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length < 2) { failUsage('task ref and operation are required'); return; }
  const operation = args[1];
  if (!internalHandlerRoute('task-artifact', 'inspect', operation ?? '')
    && !internalHandlerRoute('task-artifact', 'init', operation ?? '')
    && !internalHandlerRoute('task-artifact', 'repair', operation ?? '')
    && !internalHandlerRoute('task-artifact', 'finalize-local', operation ?? '')) { failUsage(`unknown operation '${operation}'`); return; }
  let family = '';
  let artifact = '';
  let locale: 'zh-CN' | 'en' | undefined;
  let expectedSha256 = '';
  let expectedSemanticDigest = '';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--family' && flag !== '--artifact' && flag !== '--locale' && flag !== '--expected-sha256' && flag !== '--expected-semantic-digest') { failUsage(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { failUsage(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { failUsage(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    if (flag === '--family') family = value;
    else if (flag === '--artifact') artifact = value;
    else if (flag === '--locale') {
      if (value !== 'zh-CN' && value !== 'en') { failUsage("option '--locale' must be 'zh-CN' or 'en'"); return; }
      locale = value;
    } else if (flag === '--expected-sha256') expectedSha256 = value;
    else expectedSemanticDigest = value;
  }
  if (!family) { failUsage("option '--family' is required"); return; }
  if ((operation === 'init' || operation === 'repair' || operation === 'finalize-local') && !artifact) { failUsage("option '--artifact' is required"); return; }
  if (internalHandlerRoute('task-artifact', 'inspect', operation ?? '')) {
    if (artifact || locale || expectedSha256 || expectedSemanticDigest) { failUsage("artifact options are only valid for init, repair, or finalize-local"); return; }
    const result = resolveArtifactContext(args[0]!, family);
    const output = family === 'code' && result.codeMode ? {
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
    } : result;
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (result.status === 'refused') process.exitCode = 1;
    else if (result.status === 'failed') process.exitCode = 2;
    return;
  }
  if (internalHandlerRoute('task-artifact', 'init', operation ?? '')) {
    if (expectedSha256 || expectedSemanticDigest) { failUsage("repair baseline options are only valid for repair"); return; }
    const schema = getArtifactSchema(family);
    const resolved = resolveTaskRef(args[0]!);
    if (!schema) { failUsage(`init does not support artifact family '${family}'`); return; }
    if (!resolved.ok) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`);
      process.exitCode = 1;
      return;
    }
    const parsed = parseArtifactName(artifact);
    if (!parsed || parsed.family !== family) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_INIT_CONTEXT_INVALID', message: `artifact '${artifact}' does not match ${family}` } })}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const existing = fs.lstatSync(path.join(resolved.taskDir, artifact));
      if (existing.isSymbolicLink() || !existing.isFile()) {
        process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_INIT_TARGET_INVALID', message: 'artifact target is not a regular file' } })}\n`);
        process.exitCode = 1;
        return;
      }
      const result = initializeArtifactSkeleton({ repoRoot: resolved.repoRoot, taskId: resolved.taskId, taskDir: resolved.taskDir, family: schema.family, artifact, ...(locale ? { locale } : {}) });
      process.stdout.write(`${JSON.stringify({ ...result, taskId: resolved.taskId, taskDir: resolved.taskDir, family, artifact })}\n`);
      if (result.status === 'failed') process.exitCode = 1;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_INIT_TARGET_INVALID', message: String(error) } })}\n`);
        process.exitCode = 1;
        return;
      }
    }
    const context = resolveArtifactContext(args[0]!, family);
    if (context.status !== 'ready' || !context.next || context.next.name !== artifact) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_INIT_CONTEXT_INVALID', message: context.error?.message ?? `artifact '${artifact}' is not the next ${family} artifact` } })}\n`);
      process.exitCode = 1;
      return;
    }
    if (!context.taskId || !context.taskDir) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_INIT_CONTEXT_INVALID', message: `artifact '${artifact}' does not match ${family}` } })}\n`);
      process.exitCode = 1;
      return;
    }
    const result = initializeArtifactSkeleton({
      repoRoot: resolved.repoRoot,
      taskId: context.taskId,
      taskDir: context.taskDir,
      family: schema.family,
      artifact,
      ...(locale ? { locale } : {})
    });
    process.stdout.write(`${JSON.stringify({ ...result, taskId: context.taskId, taskDir: context.taskDir, family, artifact })}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  if (internalHandlerRoute('task-artifact', 'repair', operation ?? '')) {
    if (locale) { failUsage("option '--locale' is only valid for init"); return; }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !/^[a-f0-9]{64}$/.test(expectedSemanticDigest)) {
      failUsage("repair requires lowercase 64-character '--expected-sha256' and '--expected-semantic-digest'");
      return;
    }
    const schema = getArtifactSchema(family);
    const resolved = resolveTaskRef(args[0]!);
    const parsed = parseArtifactName(artifact);
    if (!schema || !parsed || parsed.family !== family) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_REPAIR_TARGET_INVALID', message: `artifact '${artifact}' does not match ${family}` } })}\n`);
      process.exitCode = 1;
      return;
    }
    if (!resolved.ok) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: resolved.code, message: resolved.message } })}\n`);
      process.exitCode = 1;
      return;
    }
    let content: string;
    try { content = fs.readFileSync(path.join(resolved.taskDir, artifact), 'utf8'); }
    catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_REPAIR_TARGET_INVALID', message: String(error) } })}\n`);
      process.exitCode = 1;
      return;
    }
    const inspection = inspectArtifactStructure(content, schema);
    if (!inspection.repair) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, artifact, family, diagnostics: inspection.diagnostics, error: { code: 'ARTIFACT_REPAIR_UNSAFE', message: inspection.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ') || 'no deterministic structural repair is available' } })}\n`);
      process.exitCode = 1;
      return;
    }
    const result = applyArtifactRepair({
      repoRoot: resolved.repoRoot,
      taskId: resolved.taskId,
      taskDir: resolved.taskDir,
      family: schema.family,
      artifact,
      expectedSha256,
      expectedSemanticDigest,
      operation: inspection.repair
    });
    process.stdout.write(`${JSON.stringify({ ...result, taskId: resolved.taskId, taskDir: resolved.taskDir, family, artifact })}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  const resolved = resolveTaskRef(args[0]!);
  const repositoryRoot = resolved.ok ? resolved.repoRoot : process.cwd();
  if (!artifact) { failUsage("option '--artifact' is required"); return; }
  if (family !== 'analysis' && family !== 'plan' && family !== 'code') {
    failUsage("finalize-local only supports 'analysis', 'plan', and 'code'");
    return;
  }
  const skillName = family === 'analysis' ? 'analyze-task' : family === 'plan' ? 'plan-task' : 'code-task';
  let config: { requiredSections?: readonly string[]; requiredPatterns?: readonly string[] } = {};
  try {
    const loaded = loadVerificationConfig(repositoryRoot, skillName);
    const artifactConfig = loaded.checks.artifact;
    if (artifactConfig && typeof artifactConfig === 'object' && !Array.isArray(artifactConfig)) {
      const sections = artifactConfig.required_sections;
      const patterns = artifactConfig.required_patterns;
      config = {
        requiredSections: Array.isArray(sections) ? sections.filter((value): value is string => typeof value === 'string') : undefined,
        requiredPatterns: Array.isArray(patterns) ? patterns.filter((value): value is string => typeof value === 'string') : undefined
      };
    }
  } catch {
    // Isolated fixture repositories may not contain the project's verification config.
  }
  const result = finalizeLocalArtifact({
    taskRef: args[0]!,
    family: family as LocalArtifactFamily,
    artifact,
    repoRoot: repositoryRoot,
    ...config
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskArtifact };
