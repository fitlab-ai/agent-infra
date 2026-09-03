const REWORK_INTENT_HEADINGS = ['返工意图', 'Rework Intent'] as const;
const REWORK_INTENT_COLUMNS = [
  'intent_id', 'finding_id', 'source_artifact', 'source_sha256', 'target',
  'status', 'declared_at', 'consumed_at'
] as const;
type ReworkTarget = 'analysis' | 'plan' | 'code';
type ReworkIntentStatus = 'pending' | 'consumed' | 'superseded';
type ReworkIntent = {
  intentId: string;
  findingId: string;
  sourceArtifact: string;
  sourceSha256: string;
  target: ReworkTarget;
  status: ReworkIntentStatus;
  declaredAt: string;
  consumedAt: string;
};
type ReworkIntentParseResult =
  | { ok: true; present: boolean; intents: readonly ReworkIntent[] }
  | { ok: false; code: 'TASK_REWORK_INTENT_INVALID'; message: string };

function cells(line: string): string[] | null {
  const first = line.indexOf('|');
  const last = line.lastIndexOf('|');
  if (first < 0 || first === last || line.slice(0, first).trim() || line.slice(last + 1).trim()) return null;
  const inner = line.slice(first + 1, last);
  const result: string[] = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (char === '|' && !escaped) {
      result.push(inner.slice(start, index));
      start = index + 1;
    }
    escaped = char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }
  result.push(inner.slice(start));
  return result.map((cell) => cell.replace(/\\([\\|])/g, '$1').trim());
}

function sectionBody(content: string): string | null {
  const heading = REWORK_INTENT_HEADINGS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = new RegExp(`^##\\s+(${heading})\\s*$`, 'm').exec(content);
  if (!match) return null;
  const start = (match.index ?? 0) + match[0].length;
  const rest = content.slice(start);
  const end = rest.search(/^##\s+/m);
  return rest.slice(0, end < 0 ? rest.length : end);
}

function parseReworkIntentDocument(content: string): ReworkIntentParseResult {
  const body = sectionBody(content);
  if (body === null) return { ok: true, present: false, intents: [] };
  const lines = body.split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0] ? cells(lines[0]) : null;
  const separator = lines[1] ? cells(lines[1]) : null;
  if (!header || !separator || header.length !== REWORK_INTENT_COLUMNS.length || !header.every((value, index) => value === REWORK_INTENT_COLUMNS[index]) || !separator.every((value) => /^:?-{3,}:?$/.test(value))) {
    return { ok: false, code: 'TASK_REWORK_INTENT_INVALID', message: 'rework intent section must contain its canonical table' };
  }
  try {
    const intents = lines.slice(2).map((line) => {
      const values = cells(line);
      if (!values || values.length !== REWORK_INTENT_COLUMNS.length) throw new Error('rework intent row has the wrong column count');
      const row = Object.fromEntries(REWORK_INTENT_COLUMNS.map((column, index) => [column, values[index]!])) as Record<string, string>;
      if (!/^RI-[1-9]\d*$/.test(row.intent_id!)) throw new Error(`invalid intent id '${row.intent_id}'`);
      if (!/^(AN|PL|CD)-[1-9]\d*$/.test(row.finding_id!)) throw new Error(`invalid finding id '${row.finding_id}'`);
      if (!['analysis', 'plan', 'code'].includes(row.target!)) throw new Error(`invalid rework target '${row.target}'`);
      if (!['pending', 'consumed', 'superseded'].includes(row.status!)) throw new Error(`invalid rework status '${row.status}'`);
      if (!/^[a-f0-9]{64}$/.test(row.source_sha256!)) throw new Error(`invalid source hash for '${row.intent_id}'`);
      if (!row.source_artifact || !row.declared_at) throw new Error(`rework intent '${row.intent_id}' has invalid required fields`);
      const terminal = row.status === 'consumed' || row.status === 'superseded';
      if (terminal !== Boolean(row.consumed_at)) throw new Error(`rework intent '${row.intent_id}' has invalid consumed_at`);
      return {
        intentId: row.intent_id!, findingId: row.finding_id!, sourceArtifact: row.source_artifact!,
        sourceSha256: row.source_sha256!, target: row.target as ReworkTarget,
        status: row.status as ReworkIntentStatus, declaredAt: row.declared_at!, consumedAt: row.consumed_at!
      } satisfies ReworkIntent;
    });
    const ids = new Set<string>();
    for (const intent of intents) {
      if (ids.has(intent.intentId)) throw new Error(`duplicate intent '${intent.intentId}'`);
      ids.add(intent.intentId);
    }
    return { ok: true, present: true, intents };
  } catch (error) {
    return { ok: false, code: 'TASK_REWORK_INTENT_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

function renderReworkIntents(intents: readonly ReworkIntent[]): string {
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  return [
    `| ${REWORK_INTENT_COLUMNS.join(' | ')} |`,
    `| ${REWORK_INTENT_COLUMNS.map(() => '---').join(' | ')} |`,
    ...intents.map((intent) => `| ${[
      intent.intentId, intent.findingId, intent.sourceArtifact, intent.sourceSha256,
      intent.target, intent.status, intent.declaredAt, intent.consumedAt
    ].map(escape).join(' | ')} |`)
  ].join('\n');
}

function upsertReworkIntent(intents: readonly ReworkIntent[], intent: ReworkIntent): { changed: boolean; intents: readonly ReworkIntent[] } {
  const existing = intents.find((candidate) => candidate.intentId === intent.intentId);
  if (!existing) return { changed: true, intents: [...intents, intent] };
  const identity = (value: ReworkIntent) => [value.intentId, value.findingId, value.sourceArtifact, value.sourceSha256, value.target];
  if (JSON.stringify(identity(existing)) !== JSON.stringify(identity(intent))) throw new Error(`intent '${intent.intentId}' identity conflicts with existing state`);
  return { changed: false, intents };
}

function consumeReworkIntents(
  intents: readonly ReworkIntent[],
  target: ReworkTarget,
  sourceHashes: Readonly<Record<string, string>>,
  consumedAt: string
): { changed: boolean; intents: readonly ReworkIntent[] } {
  let changed = false;
  const next = intents.map((intent) => {
    if (
      intent.status !== 'pending'
      || intent.target !== target
      || sourceHashes[intent.sourceArtifact] !== intent.sourceSha256
    ) return intent;
    changed = true;
    return { ...intent, status: 'consumed' as const, consumedAt };
  });
  return { changed, intents: next };
}

function supersedeReworkIntents(
  intents: readonly ReworkIntent[],
  sourceArtifact: string,
  sourceSha256: string,
  supersededAt: string
): { changed: boolean; intents: readonly ReworkIntent[] } {
  let changed = false;
  const next = intents.map((intent) => {
    if (intent.status !== 'pending' || intent.sourceArtifact !== sourceArtifact || intent.sourceSha256 === sourceSha256) return intent;
    changed = true;
    return { ...intent, status: 'superseded' as const, consumedAt: supersededAt };
  });
  return { changed, intents: next };
}

function reworkIntentMutation(content: string, intents: readonly ReworkIntent[]) {
  return {
    kind: 'section' as const,
    aliases: REWORK_INTENT_HEADINGS,
    heading: /^##\s+Rework Intent\s*$/m.test(content) ? REWORK_INTENT_HEADINGS[1] : REWORK_INTENT_HEADINGS[0],
    body: renderReworkIntents(intents)
  };
}

export {
  REWORK_INTENT_COLUMNS,
  REWORK_INTENT_HEADINGS,
  parseReworkIntentDocument,
  renderReworkIntents,
  reworkIntentMutation,
  consumeReworkIntents,
  supersedeReworkIntents,
  upsertReworkIntent
};
export type { ReworkIntent, ReworkIntentParseResult, ReworkIntentStatus, ReworkTarget };
