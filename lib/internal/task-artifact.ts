import { resolveArtifactContext } from '../task/artifact-lifecycle.ts';
import { finalizeLocalArtifact } from '../task/local-artifact-finalization.ts';
import type { LocalArtifactFamily } from '../task/local-artifact-finalization.ts';
import { resolveTaskRef } from '../task/resolve-ref.ts';
import { loadVerificationConfig } from '../task/verification-config.ts';

const USAGE = `Usage: agent-infra-internal task-artifact <N | TASK-id> inspect --family <family>\n       agent-infra-internal task-artifact <N | TASK-id> finalize-local --family <analysis|plan> --artifact <artifact>\n\nInspect workflow artifact context or finalize a local analysis/plan artifact without changing task state.\n`;

function failUsage(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function taskArtifact(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length < 2) { failUsage('task ref and operation are required'); return; }
  const operation = args[1];
  if (operation !== 'inspect' && operation !== 'finalize-local') { failUsage(`unknown operation '${operation}'`); return; }
  let family = '';
  let artifact = '';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--family' && flag !== '--artifact') { failUsage(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { failUsage(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { failUsage(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    if (flag === '--family') family = value;
    else artifact = value;
  }
  if (!family) { failUsage("option '--family' is required"); return; }
  if (operation === 'inspect') {
    if (artifact) { failUsage("option '--artifact' is only valid for finalize-local"); return; }
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
  if (!artifact) { failUsage("option '--artifact' is required"); return; }
  if (family !== 'analysis' && family !== 'plan') {
    failUsage("finalize-local only supports 'analysis' and 'plan'");
    return;
  }
  const skillName = family === 'analysis' ? 'analyze-task' : 'plan-task';
  const resolved = resolveTaskRef(args[0]!);
  const repositoryRoot = resolved.ok ? resolved.repoRoot : process.cwd();
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
