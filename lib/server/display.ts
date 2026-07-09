export type OutboundMessage = string | DisplayMessage;

export type DisplayTone = 'info' | 'success' | 'warning' | 'danger' | 'running';

export type DisplayMessage =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { kind: 'status-card'; title: string; tone: DisplayTone; fields?: [string, string][]; body?: string }
  | {
      kind: 'stream-event';
      title: string;
      phase: 'started' | 'chunk' | 'finished';
      text?: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    }
  | {
      kind: 'command-result';
      title: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    };

export function textMessage(text: string): DisplayMessage {
  return { kind: 'text', text };
}

export function markdownMessage(markdown: string): DisplayMessage {
  return { kind: 'markdown', markdown };
}

export function tableMessage(columns: string[], rows: string[][], title?: string): DisplayMessage {
  return { kind: 'table', title, columns, rows };
}

export function statusCard(
  title: string,
  tone: DisplayTone,
  fields?: [string, string][],
  body?: string
): DisplayMessage {
  return { kind: 'status-card', title, tone, fields, body };
}

export function streamEvent(
  title: string,
  phase: 'started' | 'chunk' | 'finished',
  text?: string,
  exitCode?: number | null,
  signal?: NodeJS.Signals | null
): DisplayMessage {
  const message: Extract<DisplayMessage, { kind: 'stream-event' }> = { kind: 'stream-event', title, phase };
  if (text !== undefined) message.text = text;
  if (exitCode !== undefined) message.exitCode = exitCode;
  if (signal !== undefined) message.signal = signal;
  return message;
}

export function commandResult(
  title: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout?: string,
  stderr?: string
): DisplayMessage {
  return { kind: 'command-result', title, exitCode, signal, stdout, stderr };
}

export function normalizeOutbound(message: OutboundMessage): DisplayMessage {
  return typeof message === 'string' ? textMessage(message) : message;
}

function tableToText(message: Extract<DisplayMessage, { kind: 'table' }>): string {
  const lines: string[] = [];
  if (message.title) lines.push(message.title);
  lines.push(message.columns.join(' | '));
  lines.push(message.columns.map(() => '---').join(' | '));
  for (const row of message.rows) {
    lines.push(row.join(' | '));
  }
  return lines.join('\n');
}

function compact(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === 'string' && line !== '').join('\n');
}

function unknownDisplayKind(message: never): string {
  return `[unknown: ${String((message as { kind?: unknown }).kind)}]`;
}

export function outboundToText(message: OutboundMessage): string {
  const normalized = normalizeOutbound(message);
  switch (normalized.kind) {
    case 'text':
      return normalized.text;
    case 'markdown':
      return normalized.markdown;
    case 'table':
      return tableToText(normalized);
    case 'status-card':
      return compact([
        normalized.title,
        ...(normalized.fields ?? []).map(([label, value]) => `${label}: ${value}`),
        normalized.body
      ]);
    case 'stream-event':
      if (normalized.phase === 'started') return `started ${normalized.title}`;
      if (normalized.phase === 'chunk') return normalized.text ?? '';
      return `finished ${normalized.title} exitCode=${normalized.exitCode ?? 'null'} signal=${normalized.signal ?? 'null'}`;
    case 'command-result':
      return compact([
        `finished ${normalized.title} exitCode=${normalized.exitCode ?? 'null'} signal=${normalized.signal ?? 'null'}`,
        normalized.stdout,
        normalized.stderr
      ]);
  }
  return unknownDisplayKind(normalized);
}

export async function replyOutbound(
  inbound: {
    reply: (text: string) => Promise<void>;
    replyDisplay?: (message: OutboundMessage) => Promise<void>;
  },
  message: OutboundMessage
): Promise<void> {
  if (inbound.replyDisplay) {
    await inbound.replyDisplay(message);
    return;
  }
  await inbound.reply(outboundToText(message));
}
