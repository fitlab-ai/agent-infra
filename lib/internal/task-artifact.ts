import { resolveArtifactContext } from '../task/artifact-lifecycle.ts';

const USAGE = `Usage: agent-infra-internal task-artifact <N | #N | TASK-id> inspect --family <family>\n\nInspect one workflow artifact family and print a read-only JSON context.\n`;

function failUsage(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'ARTIFACT_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function taskArtifact(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args.length < 2) { failUsage('task ref and operation are required'); return; }
  if (args[1] !== 'inspect') { failUsage(`unknown operation '${args[1]}'`); return; }
  let family = '';
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--family') { failUsage(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { failUsage(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (!value || value.startsWith('--')) { failUsage(`option '${flag}' requires a value`); return; }
    seen.add(flag);
    family = value;
  }
  if (!family) { failUsage("option '--family' is required"); return; }
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
    message: result.codeMode.message
  } : result;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (result.status === 'refused') process.exitCode = 1;
  else if (result.status === 'failed') process.exitCode = 2;
}

export { taskArtifact };
