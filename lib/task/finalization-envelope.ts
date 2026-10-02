export type TaskFinalizationEnvelopeError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type TaskFinalizationEnvelope = Readonly<{
  version: 2;
  status: 'completed' | 'failed' | 'blocked' | 'unknown';
  changed: boolean | null;
  accepted: boolean;
  requestId: string | null;
  result: unknown;
  error: TaskFinalizationEnvelopeError | null;
}>;

export function serializeTaskFinalizationEnvelope(
  envelope: Omit<TaskFinalizationEnvelope, 'version'>
): string {
  return `${JSON.stringify({ version: 2, ...envelope })}\n`;
}
