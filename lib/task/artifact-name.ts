type ArtifactFamily =
  | 'analysis'
  | 'review-analysis'
  | 'plan'
  | 'review-plan'
  | 'code'
  | 'review-code'
  | 'manual-validation'
  | 'validation-run'
  | 'pr-review';

type ArtifactFamilySpec = Readonly<{
  family: ArtifactFamily;
  sectionAliases: readonly [string, string];
  heading: string;
  labels: readonly [string, string];
}>;

const ARTIFACT_FAMILY_CATALOG = [
  { family: 'analysis', sectionAliases: ['分析', 'Analysis'], heading: '分析', labels: ['需求分析报告', 'Requirements Analysis'] },
  { family: 'review-analysis', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['需求分析审查', 'Analysis Review'] },
  { family: 'plan', sectionAliases: ['设计', 'Design'], heading: '设计', labels: ['技术方案', 'Technical Plan'] },
  { family: 'review-plan', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['技术方案审查', 'Plan Review'] },
  { family: 'code', sectionAliases: ['实现备注', 'Implementation Notes'], heading: '实现备注', labels: ['实现报告', 'Implementation Report'] },
  { family: 'review-code', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['代码审查', 'Code Review'] },
  { family: 'manual-validation', sectionAliases: ['实现备注', 'Implementation Notes'], heading: '实现备注', labels: ['人工验证', 'Manual Validation'] },
  { family: 'validation-run', sectionAliases: ['实现备注', 'Implementation Notes'], heading: '实现备注', labels: ['验证运行证据', 'Validation Run Evidence'] },
  { family: 'pr-review', sectionAliases: ['审查反馈', 'Review Feedback'], heading: '审查反馈', labels: ['PR 审查报告', 'PR Review Report'] }
] as const satisfies readonly ArtifactFamilySpec[];

const FAMILIES = new Set<string>(ARTIFACT_FAMILY_CATALOG.map(({ family }) => family));

export function artifactName(family: ArtifactFamily, round: number): string {
  if (!FAMILIES.has(family)) throw new Error(`unknown artifact family '${family}'`);
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('artifact round must be a safe positive integer');
  return round === 1 ? `${family}.md` : `${family}-r${round}.md`;
}

export function parseArtifactName(name: string): { family: ArtifactFamily; round: number; name: string } | null {
  const match = /^(.+?)(?:-r([1-9]\d*))?\.md$/.exec(name);
  if (!match || match[0] !== name || !FAMILIES.has(match[1]!)) return null;
  const round = match[2] ? Number(match[2]) : 1;
  if (!Number.isSafeInteger(round) || (match[2] && round < 2)) return null;
  return { family: match[1] as ArtifactFamily, round, name };
}

export function maxArtifactRound(names: readonly string[], family: string): number {
  return names.reduce((max, name) => {
    const identity = parseArtifactName(name);
    return identity?.family === family ? Math.max(max, identity.round) : max;
  }, 0);
}

export { ARTIFACT_FAMILY_CATALOG };
export type { ArtifactFamily, ArtifactFamilySpec };
