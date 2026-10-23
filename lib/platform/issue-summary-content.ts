import { runSummaryContentPipeline } from './summary-content-pipeline.ts';

export type DeliverySummaryContent = Readonly<{
  taskId: string; title: string; summary: string; artifacts: readonly string[];
  verification: Readonly<{ state: string; detail: string }>;
}>;
export type CancelSummaryContent = Readonly<{
  taskId: string; title: string; outcome: 'cancelled'; reason: string; cancelledAt: string;
  lastCompletedArtifact: string | null;
}>;

export type DeliverySummarySources = Readonly<{
  taskId: string;
  title: string;
  artifacts: readonly string[];
  verificationFallback?: Readonly<{ state: string; detail: string }>;
}>;

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function isMissingText(value: unknown): boolean {
  return typeof value !== 'string' || !value.trim();
}

function fillText(input: Record<string, unknown>, key: string, fallback: string): void {
  if (isMissingText(input[key])) input[key] = fallback;
}

function fillDeliveryVerification(
  input: Record<string, unknown>, fallback: Readonly<{ state: string; detail: string }>
): void {
  if (!input.verification || typeof input.verification !== 'object' || Array.isArray(input.verification)) {
    input.verification = fallback;
    return;
  }
  const verification = { ...(input.verification as Record<string, unknown>) };
  fillText(verification, 'state', fallback.state);
  fillText(verification, 'detail', fallback.detail);
  input.verification = verification;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim());
}

export function parseDeliverySummaryContent(value: unknown): DeliverySummaryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery summary must be an object');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.artifacts) || input.artifacts.some((item) => typeof item !== 'string')) throw new Error('artifacts must be a string array');
  if (!input.verification || typeof input.verification !== 'object' || Array.isArray(input.verification)) throw new Error('verification must be an object');
  const verification = input.verification as Record<string, unknown>;
  return {
    taskId: text(input.taskId, 'taskId'), title: text(input.title, 'title'), summary: text(input.summary, 'summary'),
    artifacts: input.artifacts.map((item) => text(item, 'artifacts[]')),
    verification: { state: text(verification.state, 'verification.state'), detail: text(verification.detail, 'verification.detail') }
  };
}

function correctDeliverySummaryContent(value: unknown, sources: DeliverySummarySources): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery summary must be an object');
  const input = { ...(value as Record<string, unknown>) };
  fillText(input, 'taskId', sources.taskId);
  if (input.taskId !== sources.taskId) throw new Error('taskId does not match the active task');
  fillText(input, 'title', sources.title);
  if (!isStringArray(input.artifacts)) input.artifacts = [...sources.artifacts];
  if (sources.verificationFallback) fillDeliveryVerification(input, sources.verificationFallback);
  return input;
}

export function prepareAndRenderDeliverySummaryContent(value: unknown, sources: DeliverySummarySources) {
  return runSummaryContentPipeline(value, {
    prepare: (input) => input,
    validate: (input) => {
      try { return { ok: true as const, value: parseDeliverySummaryContent(input) }; }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }; }
    },
    correct: (input) => correctDeliverySummaryContent(input, sources),
    render: renderDeliverySummaryContent
  });
}

export function prepareDeliverySummaryContent(value: unknown, sources: DeliverySummarySources): DeliverySummaryContent {
  return prepareAndRenderDeliverySummaryContent(value, sources).content;
}

export function renderDeliverySummaryContent(value: DeliverySummaryContent): string {
  const content = parseDeliverySummaryContent(value);
  return [
    `# ${content.title}`, '', content.summary, '', '## 交付产物', '',
    ...(content.artifacts.length ? content.artifacts.map((item) => `- ${item}`) : ['- 无']), '',
    '## 验证', '', `状态：${content.verification.state}`, '', content.verification.detail, ''
  ].join('\n');
}

export function parseCancelSummaryContent(value: unknown): CancelSummaryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cancel summary must be an object');
  const input = value as Record<string, unknown>;
  if (input.outcome !== 'cancelled') throw new Error('outcome must be cancelled');
  if (input.lastCompletedArtifact !== null && typeof input.lastCompletedArtifact !== 'string') throw new Error('lastCompletedArtifact must be a string or null');
  return {
    taskId: text(input.taskId, 'taskId'), title: text(input.title, 'title'), outcome: 'cancelled',
    reason: text(input.reason, 'reason'), cancelledAt: text(input.cancelledAt, 'cancelledAt'),
    lastCompletedArtifact: input.lastCompletedArtifact === null ? null : text(input.lastCompletedArtifact, 'lastCompletedArtifact')
  };
}

function correctCancelSummaryContent(value: unknown, sources: Readonly<{
  taskId: string; title: string; reason: string; cancelledAt: string; lastCompletedArtifact: string | null;
}>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cancel summary must be an object');
  const input = { ...(value as Record<string, unknown>) };
  fillText(input, 'taskId', sources.taskId);
  if (input.taskId !== sources.taskId) throw new Error('taskId does not match the task');
  fillText(input, 'title', sources.title);
  fillText(input, 'reason', sources.reason);
  fillText(input, 'cancelledAt', sources.cancelledAt);
  if (input.lastCompletedArtifact === undefined
    || (input.lastCompletedArtifact !== null && (typeof input.lastCompletedArtifact !== 'string' || !input.lastCompletedArtifact.trim()))) {
    input.lastCompletedArtifact = sources.lastCompletedArtifact;
  }
  return input;
}

export function prepareAndRenderCancelSummaryContent(value: unknown, sources: Readonly<{
  taskId: string; title: string; reason: string; cancelledAt: string; lastCompletedArtifact: string | null;
}>) {
  return runSummaryContentPipeline(value, {
    prepare: (input) => input,
    validate: (input) => {
      try { return { ok: true as const, value: parseCancelSummaryContent(input) }; }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }; }
    },
    correct: (input) => correctCancelSummaryContent(input, sources),
    render: renderCancelSummaryContent
  });
}

export function prepareCancelSummaryContent(value: unknown, sources: Readonly<{
  taskId: string; title: string; reason: string; cancelledAt: string; lastCompletedArtifact: string | null;
}>): CancelSummaryContent {
  return prepareAndRenderCancelSummaryContent(value, sources).content;
}

export function renderCancelSummaryContent(value: CancelSummaryContent): string {
  const content = parseCancelSummaryContent(value);
  return [`# ${content.title}`, '', `结果：${content.outcome}`, '', `取消时间：${content.cancelledAt}`, '', `原因：${content.reason}`, '', `最近完成产物：${content.lastCompletedArtifact ?? '无'}`, ''].join('\n');
}
