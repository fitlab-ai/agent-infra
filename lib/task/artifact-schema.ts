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

type ArtifactSchemaFamily = Exclude<ArtifactFamily, 'manual-validation' | 'validation-run' | 'pr-review'>;
type ArtifactLocale = 'zh-CN' | 'en';
type ArtifactSection = Readonly<{
  id: string;
  order: number;
  headings: Readonly<{ zh: string; en: string }>;
  marker: string;
}>;
type ArtifactSchema = Readonly<{
  family: ArtifactSchemaFamily;
  title: Readonly<{ zh: string; en: string }>;
  sections: readonly ArtifactSection[];
  requiredPatterns: readonly string[];
}>;
type ArtifactSkeletonInput = Readonly<{
  taskId: string;
  family: ArtifactSchemaFamily;
  artifact: string;
  locale?: ArtifactLocale;
}>;

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

const LOCAL_SECTIONS = {
  analysis: [
    ['source', '需求来源', 'Requirements Source'],
    ['understanding', '需求理解', 'Requirements Understanding'],
    ['files', '相关文件', 'Related Files'],
    ['impact', '影响评估', 'Impact Assessment'],
    ['risks', '技术风险', 'Technical Risks'],
    ['effort', '工作量和复杂度评估', 'Effort and Complexity Assessment'],
    ['state-check', '状态核对', 'State Check']
  ],
  plan: [
    ['understanding', '问题理解', 'Problem Understanding'],
    ['constraints', '约束条件', 'Constraints'],
    ['options', '方案对比', 'Options Comparison'],
    ['approach', '技术方法', 'Technical Approach'],
    ['steps', '实施步骤', 'Implementation Steps'],
    ['files', '文件清单', 'File List'],
    ['verification', '验证策略', 'Verification Strategy'],
    ['state-check', '状态核对', 'State Check']
  ],
  code: [
    ['input', '实现输入', 'Implementation Input'],
    ['files', '变更文件', 'Changed Files'],
    ['key-code', '关键代码说明', 'Key Code Notes'],
    ['tests', '测试结果', 'Test Results'],
    ['deviations', '与方案的差异', 'Differences from Plan'],
    ['review-focus', '供审查关注的内容', 'Review Focus'],
    ['state-check', '状态核对', 'State Check'],
    ['evidence', '证据原文', 'Raw Evidence']
  ],
  'review-analysis': [
    ['summary', '审查摘要', 'Review Summary'],
    ['coverage', '检视覆盖声明', 'Inspection Coverage'],
    ['specialized-coverage', '需求分析专项覆盖', 'Requirements Analysis Coverage'],
    ['traceability', '追踪矩阵', 'Traceability Matrix'],
    ['issues', '问题清单', 'Findings'],
    ['non-blocking', '非阻塞建议', 'Non-blocking Suggestions'],
    ['manual-validation', '人工校验项', 'Manual Validation Items'],
    ['conclusion', '结论与建议', 'Conclusion and Recommendation'],
    ['state-check', '状态核对', 'State Check'],
    ['evidence', '证据原文', 'Raw Evidence'],
    ['self-critique', '自我质疑', 'Self-critique'],
    ['ledger-writeback', '审查分歧账本回写', 'Review Disagreement Ledger Write-back']
  ],
  'review-plan': [
    ['summary', '审查摘要', 'Review Summary'],
    ['coverage', '检视覆盖声明', 'Inspection Coverage'],
    ['specialized-coverage', '技术方案架构覆盖', 'Technical Plan Architecture Coverage'],
    ['traceability', '追踪矩阵', 'Traceability Matrix'],
    ['issues', '问题清单', 'Findings'],
    ['non-blocking', '非阻塞建议', 'Non-blocking Suggestions'],
    ['manual-validation', '人工校验项', 'Manual Validation Items'],
    ['conclusion', '结论与建议', 'Conclusion and Recommendation'],
    ['state-check', '状态核对', 'State Check'],
    ['evidence', '证据原文', 'Raw Evidence'],
    ['self-critique', '自我质疑', 'Self-critique'],
    ['ledger-writeback', '审查分歧账本回写', 'Review Disagreement Ledger Write-back']
  ],
  'review-code': [
    ['summary', '审查摘要', 'Review Summary'],
    ['coverage', '检视覆盖声明', 'Inspection Coverage'],
    ['specialized-coverage', '代码实现专项覆盖', 'Code Implementation Coverage'],
    ['traceability', '追踪矩阵', 'Traceability Matrix'],
    ['issues', '问题清单', 'Findings'],
    ['non-blocking', '非阻塞建议', 'Non-blocking Suggestions'],
    ['manual-validation', '人工校验项', 'Manual Validation Items'],
    ['conclusion', '结论与建议', 'Conclusion and Recommendation'],
    ['state-check', '状态核对', 'State Check'],
    ['evidence', '证据原文', 'Raw Evidence'],
    ['self-critique', '自我质疑', 'Self-critique'],
    ['ledger-writeback', '审查分歧账本回写', 'Review Disagreement Ledger Write-back']
  ]
} as const;

function buildSections(family: ArtifactSchemaFamily): readonly ArtifactSection[] {
  return LOCAL_SECTIONS[family].map(([id, zh, en], index) => ({
    id,
    order: index + 1,
    headings: { zh, en },
    marker: `artifact-section:${family}:${id}`
  }));
}

const ARTIFACT_SCHEMAS: readonly ArtifactSchema[] = [
  { family: 'analysis', title: { zh: '需求分析报告', en: 'Requirements Analysis' }, sections: buildSections('analysis'), requiredPatterns: ['^\\$ '] },
  { family: 'review-analysis', title: { zh: '需求分析审查报告', en: 'Analysis Review Report' }, sections: buildSections('review-analysis'), requiredPatterns: ['^### 审查决定$', '^\\$ '] },
  { family: 'plan', title: { zh: '技术方案', en: 'Technical Plan' }, sections: buildSections('plan'), requiredPatterns: ['^\\$ '] },
  { family: 'review-plan', title: { zh: '技术方案审查报告', en: 'Plan Review Report' }, sections: buildSections('review-plan'), requiredPatterns: ['^### 审查决定$', '^\\$ '] },
  { family: 'code', title: { zh: '实现报告', en: 'Implementation Report' }, sections: buildSections('code'), requiredPatterns: ['^\\$ '] },
  { family: 'review-code', title: { zh: '代码审查报告', en: 'Code Review Report' }, sections: buildSections('review-code'), requiredPatterns: ['^### 审查决定$', '^\\$ '] }
];

function getArtifactSchema(family: string): ArtifactSchema | null {
  return ARTIFACT_SCHEMAS.find((schema) => schema.family === family) ?? null;
}

function renderArtifactSkeleton(input: ArtifactSkeletonInput): string {
  const schema = getArtifactSchema(input.family);
  if (!schema) throw new Error(`unknown artifact schema family '${input.family}'`);
  const locale = input.locale ?? 'zh-CN';
  const roundMatch = input.artifact.match(/-r(\d+)\.md$/);
  const round = roundMatch ? Number(roundMatch[1]) : 1;
  const title = schema.title[locale === 'en' ? 'en' : 'zh'];
  const headings = locale === 'en' ? 'en' : 'zh';
  const lines = [
    `<!-- artifact-context:${input.taskId}:${input.family}:${round} -->`,
    `# ${title}`,
    ''
  ];
  for (const section of schema.sections) {
    lines.push(`## ${section.headings[headings]}`);
    lines.push(`<!-- ${section.marker} -->`);
    lines.push('<!-- artifact-slot:empty -->');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export {
  ARTIFACT_FAMILY_CATALOG,
  ARTIFACT_SCHEMAS,
  getArtifactSchema,
  renderArtifactSkeleton
};
export type {
  ArtifactFamily,
  ArtifactFamilySpec,
  ArtifactLocale,
  ArtifactSchema,
  ArtifactSchemaFamily,
  ArtifactSection,
  ArtifactSkeletonInput
};
