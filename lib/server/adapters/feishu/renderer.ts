import { stripVTControlCharacters } from 'node:util';
import { normalizeOutbound, outboundToText, type DisplayMessage, type OutboundMessage } from '../../display.ts';
import type { FeishuMessagePayload } from './transport.ts';

const FEISHU_LARK_MD_MAX_LENGTH = 20_000;

type FeishuElement =
  | { tag: 'div'; text: { tag: 'lark_md'; content: string } }
  | { tag: 'div'; fields: Array<{ is_short: boolean; text: { tag: 'lark_md'; content: string } }> };

function templateForTone(tone: 'info' | 'success' | 'warning' | 'danger' | 'running'): string {
  if (tone === 'success') return 'green';
  if (tone === 'warning') return 'yellow';
  if (tone === 'danger') return 'red';
  return 'blue';
}

function templateForResult(exitCode: number | null): string {
  return exitCode === 0 ? 'green' : 'red';
}

export function cleanFeishuText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n/g, '\n');
}

function clampLarkMarkdown(text: string): string {
  const clean = cleanFeishuText(text);
  if (clean.length <= FEISHU_LARK_MD_MAX_LENGTH) return clean;
  return `${clean.slice(0, FEISHU_LARK_MD_MAX_LENGTH - 18)}\n\n...(truncated)`;
}

function div(content: string): FeishuElement {
  return { tag: 'div', text: { tag: 'lark_md', content: clampLarkMarkdown(content) } };
}

function fields(rows: [string, string][]): FeishuElement {
  return {
    tag: 'div',
    fields: rows.map(([label, value]) => ({
      is_short: true,
      text: { tag: 'lark_md', content: clampLarkMarkdown(`**${label}**\n${value}`) }
    }))
  };
}

function card(title: string, template: string, elements: FeishuElement[]): FeishuMessagePayload {
  return {
    msg_type: 'interactive',
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: cleanFeishuText(title) }, template },
      elements
    })
  };
}

function tableMarkdown(message: Extract<DisplayMessage, { kind: 'table' }>): string {
  return outboundToText(message);
}

function renderStatus(message: Extract<DisplayMessage, { kind: 'status-card' }>): FeishuMessagePayload {
  const elements: FeishuElement[] = [];
  if (message.fields && message.fields.length > 0) elements.push(fields(message.fields));
  if (message.body) elements.push(div(message.body));
  if (elements.length === 0) elements.push(div(message.title));
  return card(message.title, templateForTone(message.tone), elements);
}

function renderStream(message: Extract<DisplayMessage, { kind: 'stream-event' }>): FeishuMessagePayload {
  const template = message.phase === 'finished' ? templateForResult(message.exitCode ?? null) : 'blue';
  return card(message.title, template, [div(outboundToText(message))]);
}

function renderCommandResult(message: Extract<DisplayMessage, { kind: 'command-result' }>): FeishuMessagePayload {
  return card(message.title, templateForResult(message.exitCode), [div(outboundToText(message))]);
}

function renderUnknownDisplayKind(message: never): FeishuMessagePayload {
  return card('agent-infra', 'blue', [div(`[unknown display kind: ${String((message as { kind?: unknown }).kind)}]`)]);
}

export function renderFeishuMessage(message: OutboundMessage): FeishuMessagePayload {
  const normalized = normalizeOutbound(message);
  switch (normalized.kind) {
    case 'text':
      return card('agent-infra', 'blue', [div(normalized.text)]);
    case 'markdown':
      return card('agent-infra', 'blue', [div(normalized.markdown)]);
    case 'table':
      return card(normalized.title ?? 'agent-infra', 'blue', [div(tableMarkdown(normalized))]);
    case 'status-card':
      return renderStatus(normalized);
    case 'stream-event':
      return renderStream(normalized);
    case 'command-result':
      return renderCommandResult(normalized);
  }
  return renderUnknownDisplayKind(normalized);
}
