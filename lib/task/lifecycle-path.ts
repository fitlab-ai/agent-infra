import { createHash } from 'node:crypto';

import { extractSection } from './sections.ts';

const PATH_STAGES = {
  streamlined: ['analysis', 'code', 'review-code'],
  standard: ['analysis', 'plan', 'code', 'review-code'],
  full: ['analysis', 'review-analysis', 'plan', 'review-plan', 'code', 'review-code']
} as const;

type LifecyclePath = keyof typeof PATH_STAGES;
type LifecycleStage = (typeof PATH_STAGES)[LifecyclePath][number];
type LifecyclePathDecision = Readonly<{
  path: LifecyclePath;
  stages: readonly LifecycleStage[];
  basis: string;
  unmetHigherConditions: string;
  upgradeTriggers: string;
  semanticDigest: string;
  sourceArtifact: string;
  sourceSha256: string;
}>;
type LifecyclePathState =
  | Readonly<{ status: 'missing'; decision: null; message: string }>
  | Readonly<{ status: 'invalid'; decision: null; message: string }>
  | Readonly<{ status: 'valid'; decision: LifecyclePathDecision; message: null }>;

const FIELD_ALIASES = {
  path: ['本任务路径', 'Path'],
  basis: ['判定依据', 'Basis'],
  unmetHigherConditions: ['未满足的更高路径条件', '未满足的较低路径条件', 'Unmet Higher-path Conditions'],
  upgradeTriggers: ['升级触发条件', 'Upgrade Triggers']
} as const;

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/[。.]$/, '');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pathToken(value: string): LifecyclePath | null {
  const normalized = normalizeText(value).toLowerCase().replace(/[`*_]/g, '');
  if (/^(?:streamlined|精简路径|精简)$/.test(normalized)) return 'streamlined';
  if (/^(?:standard|标准路径|标准)$/.test(normalized)) return 'standard';
  if (/^(?:full|完整路径|完整)$/.test(normalized)) return 'full';
  return null;
}

function fieldValues(body: string, aliases: readonly string[]): string[] {
  const wanted = new Set(aliases);
  const values: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\*\*([^*]+)\*\*[:：]\s*(.*?)\s*$/.exec(line);
    if (match && wanted.has(match[1]!.trim())) values.push(match[2]!.trim());
  }
  return values;
}

function parseLifecyclePathDecision(
  analysisContent: string,
  sourceArtifact = '',
  sourceSha256 = ''
): LifecyclePathState {
  const body = extractSection(analysisContent, ['流程裁定', 'Flow Decision']);
  if (!body) return { status: 'missing', decision: null, message: 'analysis flow decision section is missing' };
  const fields = Object.fromEntries(Object.entries(FIELD_ALIASES).map(([key, aliases]) => [key, fieldValues(body, aliases)])) as Record<keyof typeof FIELD_ALIASES, string[]>;
  const invalid = Object.entries(fields).find(([, values]) => values.length !== 1);
  if (invalid) return { status: 'invalid', decision: null, message: `flow decision field '${invalid[0]}' must appear exactly once` };
  const path = pathToken(fields.path[0]!);
  if (!path) return { status: 'invalid', decision: null, message: `unknown lifecycle path '${fields.path[0]}'` };
  const basis = normalizeText(fields.basis[0]!);
  const unmetHigherConditions = normalizeText(fields.unmetHigherConditions[0]!);
  const upgradeTriggers = normalizeText(fields.upgradeTriggers[0]!);
  if (!basis || !unmetHigherConditions || !upgradeTriggers) return { status: 'invalid', decision: null, message: 'flow decision fields must be non-empty' };
  return {
    status: 'valid',
    message: null,
    decision: {
      path,
      stages: PATH_STAGES[path],
      basis,
      unmetHigherConditions,
      upgradeTriggers,
      semanticDigest: digest({ path, basis, unmetHigherConditions, upgradeTriggers }),
      sourceArtifact,
      sourceSha256
    }
  };
}

function pathIncludes(state: LifecyclePathState | undefined, stage: LifecycleStage): boolean {
  return state?.status === 'valid' && state.decision.stages.includes(stage);
}

export { PATH_STAGES, parseLifecyclePathDecision, pathIncludes };
export type { LifecyclePath, LifecyclePathDecision, LifecyclePathState, LifecycleStage };
