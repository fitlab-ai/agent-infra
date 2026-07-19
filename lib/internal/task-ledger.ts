import { applyLedgerIntent } from '../task/ledger-intents.ts';
import type { LedgerIntent } from '../task/ledger-intents.ts';

const USAGE = `Usage: agent-infra-internal task-ledger <task-ref> <intent> [intent flags] [--dry-run]\n\nIntents: finding-upsert, finding-respond, finding-review, decision-next-id, decision-upsert\n`;
const FLAGS: Record<string, string> = {
  '--stage': 'stage', '--review-artifact': 'reviewArtifact', '--ordinal': 'ordinal',
  '--severity': 'severity', '--evidence': 'evidence', '--id': 'id', '--round': 'round',
  '--status': 'status', '--artifact': 'artifact'
};
const NUMERIC = new Set(['ordinal', 'round']);

function usageFailure(message: string): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'LEDGER_PAYLOAD_INVALID', message } })}\n`);
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskLedger(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  const [taskRef, kind] = args;
  if (!taskRef || !kind) { usageFailure('task ref and intent are required'); return; }
  if (!['finding-upsert', 'finding-respond', 'finding-review', 'decision-next-id', 'decision-upsert'].includes(kind)) {
    usageFailure(`unknown ledger intent '${kind}'`); return;
  }
  const values: Record<string, unknown> = { kind, taskRef };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--dry-run') {
      if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
      seen.add(flag); values.dryRun = true; continue;
    }
    const key = FLAGS[flag];
    if (!key) { usageFailure(`unknown option '${flag}'`); return; }
    if (seen.has(flag)) { usageFailure(`duplicate option '${flag}'`); return; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) { usageFailure(`option '${flag}' requires a value`); return; }
    seen.add(flag); values[key] = NUMERIC.has(key) ? Number(value) : value;
  }
  const required: Record<string, string[]> = {
    'finding-upsert': ['stage', 'reviewArtifact', 'ordinal', 'severity', 'evidence'],
    'finding-respond': ['id', 'round', 'status', 'evidence'],
    'finding-review': ['id', 'status', 'evidence'],
    'decision-next-id': [],
    'decision-upsert': ['id', 'stage', 'artifact']
  };
  const allowed = new Set(['kind', 'taskRef', 'dryRun', ...required[kind]!]);
  const unexpected = Object.keys(values).find((key) => !allowed.has(key));
  const missing = required[kind]!.find((key) => values[key] === undefined);
  if (unexpected) { usageFailure(`${kind} does not accept '${unexpected}'`); return; }
  if (missing) { usageFailure(`${kind} requires '${missing}'`); return; }
  const result = applyLedgerIntent(values as LedgerIntent);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

export { taskLedger };
