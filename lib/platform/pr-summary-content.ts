import { CANONICAL_REPORT_PLACEHOLDER } from './pr-change-report.ts';
import { MANUAL_VALIDATION_RECEIPT_PLACEHOLDER } from '../task/manual-validation-receipt.ts';

export type PrSummaryContent = Readonly<{
  overview: string;
  tests: Readonly<{ state: string; detail: string }>;
  review: Readonly<{ state: string; detail: string }>;
  manualValidation: Readonly<{ state: string; detail: string }>;
  humanDecisions: Readonly<{ open: number; resolved: number; detail: string }>;
  risks: string;
}>;

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

export function parsePrSummaryContent(value: unknown): PrSummaryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PR summary must be an object');
  const input = value as Record<string, unknown>;
  const pair = (key: 'tests' | 'review' | 'manualValidation') => {
    const item = input[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${key} must be an object`);
    const fields = item as Record<string, unknown>;
    return { state: nonEmpty(fields.state, `${key}.state`), detail: nonEmpty(fields.detail, `${key}.detail`) };
  };
  const decisions = input.humanDecisions;
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('humanDecisions must be an object');
  const counts = decisions as Record<string, unknown>;
  for (const key of ['open', 'resolved'] as const) {
    if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0) throw new Error(`humanDecisions.${key} must be a non-negative integer`);
  }
  return {
    overview: nonEmpty(input.overview, 'overview'),
    tests: pair('tests'), review: pair('review'), manualValidation: pair('manualValidation'),
    humanDecisions: { open: counts.open as number, resolved: counts.resolved as number, detail: nonEmpty(counts.detail, 'humanDecisions.detail') },
    risks: nonEmpty(input.risks, 'risks')
  };
}

export function renderPrSummaryContent(value: PrSummaryContent): string {
  const content = parsePrSummaryContent(value);
  const manualValidationHeading = content.manualValidation.state === 'required' ? '⚠️ 需人工校验'
    : content.manualValidation.state === 'pending' ? '⏳ 人工验证待收尾'
    : content.manualValidation.state === 'passed' ? '✅ 人工验证已通过'
      : ['none', 'not-required'].includes(content.manualValidation.state) ? '✅ 无需人工校验'
        : content.manualValidation.state === 'unavailable' ? '⚠️ 人工校验状态不可用'
          : content.manualValidation.state === 'not-observed' ? 'ℹ️ 尚未读取人工校验状态'
            : `人工校验状态：${content.manualValidation.state}`;
  return [
    '## 审查摘要', '', content.overview, '',
    '### 关键技术决策', '', '（见审查历程）', '',
    '### 审查历程', '', `状态：${content.review.state}`, '', content.review.detail, '',
    '### 测试结果', '', `状态：${content.tests.state}`, '', content.tests.detail, '',
    `### ${manualValidationHeading}`, '', `状态：${content.manualValidation.state}`, '', content.manualValidation.detail,
    ...(content.manualValidation.state === 'passed' ? ['', MANUAL_VALIDATION_RECEIPT_PLACEHOLDER] : []), '',
    '### 人工决策', '', `未解决：${content.humanDecisions.open}；已解决：${content.humanDecisions.resolved}`, '', content.humanDecisions.detail, '',
    '### 风险', '', content.risks, '', CANONICAL_REPORT_PLACEHOLDER, ''
  ].join('\n');
}
