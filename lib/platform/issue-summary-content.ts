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

export function prepareDeliverySummaryContent(value: unknown, sources: DeliverySummarySources): DeliverySummaryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery summary must be an object');
  const input = { ...(value as Record<string, unknown>) };
  if (typeof input.taskId !== 'string' || !input.taskId.trim()) input.taskId = sources.taskId;
  if (input.taskId !== sources.taskId) throw new Error('taskId does not match the active task');
  if (typeof input.title !== 'string' || !input.title.trim()) input.title = sources.title;
  if (!Array.isArray(input.artifacts) || input.artifacts.some((item) => typeof item !== 'string' || !item.trim())) input.artifacts = [...sources.artifacts];
  if (sources.verificationFallback) {
    if (!input.verification || typeof input.verification !== 'object' || Array.isArray(input.verification)) {
      input.verification = sources.verificationFallback;
    } else {
      const verification = { ...(input.verification as Record<string, unknown>) };
      if (typeof verification.state !== 'string' || !verification.state.trim()) verification.state = sources.verificationFallback.state;
      if (typeof verification.detail !== 'string' || !verification.detail.trim()) verification.detail = sources.verificationFallback.detail;
      input.verification = verification;
    }
  }
  return parseDeliverySummaryContent(input);
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

export function prepareCancelSummaryContent(value: unknown, sources: Readonly<{
  taskId: string; title: string; reason: string; cancelledAt: string; lastCompletedArtifact: string | null;
}>): CancelSummaryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cancel summary must be an object');
  const input = { ...(value as Record<string, unknown>) };
  if (typeof input.taskId !== 'string' || !input.taskId.trim()) input.taskId = sources.taskId;
  if (input.taskId !== sources.taskId) throw new Error('taskId does not match the task');
  if (typeof input.title !== 'string' || !input.title.trim()) input.title = sources.title;
  if (typeof input.reason !== 'string' || !input.reason.trim()) input.reason = sources.reason;
  if (typeof input.cancelledAt !== 'string' || !input.cancelledAt.trim()) input.cancelledAt = sources.cancelledAt;
  if (input.lastCompletedArtifact === undefined
    || (input.lastCompletedArtifact !== null && (typeof input.lastCompletedArtifact !== 'string' || !input.lastCompletedArtifact.trim()))) {
    input.lastCompletedArtifact = sources.lastCompletedArtifact;
  }
  return parseCancelSummaryContent(input);
}

export function renderCancelSummaryContent(value: CancelSummaryContent): string {
  const content = parseCancelSummaryContent(value);
  return [`# ${content.title}`, '', `结果：${content.outcome}`, '', `取消时间：${content.cancelledAt}`, '', `原因：${content.reason}`, '', `最近完成产物：${content.lastCompletedArtifact ?? '无'}`, ''].join('\n');
}
