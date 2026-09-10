import type { ReviewFinalizationRequest } from './review-finalization.ts';

export function parseReviewCommand(args: readonly string[]): ReviewFinalizationRequest & {
  overrideTicket?: string; overrideTarget?: string; overrideScope?: string;
} {
  if (!args[0] || args[1] !== 'finalize-summary') throw new Error('task ref and finalize-summary are required');
  const values: Record<string, string | boolean> = {};
  const flags = {
    '--stage': 'stage', '--artifact': 'artifact', '--orchestrated': 'orchestrated', '--dry-run': 'dryRun',
    '--override-ticket': 'overrideTicket', '--override-target': 'overrideTarget', '--override-scope': 'overrideScope'
  } as const;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!Object.hasOwn(flags, flag)) throw new Error(`unknown option '${flag}'`);
    const key = flags[flag as keyof typeof flags];
    if (Object.hasOwn(values, key)) throw new Error(`duplicate option '${flag}'`);
    const value = flag === '--orchestrated' || flag === '--dry-run' ? true : args[++index];
    if (!value || typeof value === 'string' && value.startsWith('--')) throw new Error(`option '${flag}' requires a value`);
    values[key] = value;
  }
  if (!values.stage || !values.artifact) throw new Error("options '--stage' and '--artifact' are required");
  return { taskRef: args[0], ...values } as ReturnType<typeof parseReviewCommand>;
}
