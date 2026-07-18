import { parse, stringify } from 'yaml';

type Frontmatter = Record<string, string>;
type FrontmatterScalar = string | number | boolean | null;
type TypedFrontmatter = Record<string, FrontmatterScalar>;

class FrontmatterError extends Error {
  code: 'TASK_DOCUMENT_INVALID' | 'MUTATION_INVALID';

  constructor(code: 'TASK_DOCUMENT_INVALID' | 'MUTATION_INVALID', message: string) {
    super(message);
    this.name = 'FrontmatterError';
    this.code = code;
  }
}

type FrontmatterBlock = {
  eol: '\n' | '\r\n';
  bodyStart: number;
  bodyEnd: number;
};

function locateFrontmatter(content: string): FrontmatterBlock {
  const opening = /^---(\r?\n)/.exec(content);
  if (!opening) {
    throw new FrontmatterError('TASK_DOCUMENT_INVALID', 'task.md frontmatter is missing');
  }
  const eol = opening[1] as '\n' | '\r\n';
  const bodyStart = opening[0].length;
  const closing = /^---\r?$/gm;
  closing.lastIndex = bodyStart;
  const match = closing.exec(content);
  if (!match) {
    throw new FrontmatterError('TASK_DOCUMENT_INVALID', 'task.md frontmatter is unclosed');
  }
  return { eol, bodyStart, bodyEnd: match.index };
}

function parseFrontmatterLines(content: string, block: FrontmatterBlock) {
  const body = content.slice(block.bodyStart, block.bodyEnd);
  const lines = body.split(block.eol);
  return lines.map((raw, index) => {
    if (!raw.trim() || raw.trimStart().startsWith('#')) {
      return { raw, index, key: null as string | null, value: null as string | null };
    }
    const match = /^([^\s:#][^:]*):(?:[ \t]*(.*))?$/.exec(raw);
    if (!match || !match[1]) {
      throw new FrontmatterError(
        'TASK_DOCUMENT_INVALID',
        `unsupported frontmatter structure on line ${index + 2}`
      );
    }
    return {
      raw,
      index,
      key: match[1].trim(),
      value: match[2] ?? ''
    };
  });
}

function serializeScalar(value: FrontmatterScalar): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new FrontmatterError('MUTATION_INVALID', 'frontmatter numbers must be finite');
  }
  if (value === '') return '';
  const serialized = stringify(value).trimEnd();
  if (serialized.includes('\n') || serialized.includes('\r')) {
    throw new FrontmatterError('MUTATION_INVALID', 'frontmatter values must be scalar');
  }
  return serialized;
}

function parseTaskFrontmatter(content: string): Frontmatter {
  const result: Frontmatter = {};
  if (!content.startsWith('---')) return result;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return result;
  const body = content.slice(3, end);
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function parseTypedTaskFrontmatter(content: string): TypedFrontmatter {
  const block = locateFrontmatter(content);
  const result: TypedFrontmatter = {};
  for (const line of parseFrontmatterLines(content, block)) {
    if (!line.key || line.value === null) continue;
    if (Object.hasOwn(result, line.key)) {
      throw new FrontmatterError(
        'TASK_DOCUMENT_INVALID',
        `duplicate frontmatter key '${line.key}'`
      );
    }
    if (line.value === '') {
      result[line.key] = '';
      continue;
    }
    let value: unknown;
    try {
      value = parse(line.value);
    } catch {
      throw new FrontmatterError(
        'TASK_DOCUMENT_INVALID',
        `frontmatter key '${line.key}' is not a valid scalar`
      );
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new FrontmatterError(
        'TASK_DOCUMENT_INVALID',
        `frontmatter key '${line.key}' is not a scalar`
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new FrontmatterError(
        'TASK_DOCUMENT_INVALID',
        `frontmatter key '${line.key}' is not a finite scalar`
      );
    }
    result[line.key] = value;
  }
  return result;
}

function updateTaskFrontmatter(
  content: string,
  set: Readonly<Record<string, FrontmatterScalar>>,
  remove: readonly string[] = []
): string {
  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    throw new FrontmatterError('MUTATION_INVALID', 'frontmatter set must be an object');
  }
  const entries = Object.entries(set);
  if (!Array.isArray(remove)) {
    throw new FrontmatterError('MUTATION_INVALID', 'frontmatter remove must be an array');
  }
  const removeSet = new Set(remove);
  if (removeSet.size !== remove.length) {
    throw new FrontmatterError('MUTATION_INVALID', 'frontmatter remove keys must be unique');
  }
  for (const [key, value] of entries) {
    if (!key || /[\r\n:]/.test(key)) {
      throw new FrontmatterError('MUTATION_INVALID', `invalid frontmatter key '${key}'`);
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new FrontmatterError('MUTATION_INVALID', `invalid scalar for '${key}'`);
    }
  }
  for (const key of remove) {
    if (!key || /[\r\n:]/.test(key)) {
      throw new FrontmatterError('MUTATION_INVALID', `invalid frontmatter key '${key}'`);
    }
    if (Object.hasOwn(set, key)) {
      throw new FrontmatterError(
        'MUTATION_INVALID',
        `frontmatter key '${key}' cannot be set and removed together`
      );
    }
  }

  const block = locateFrontmatter(content);
  const lines = parseFrontmatterLines(content, block);
  const indexes = new Map<string, number[]>();
  for (const line of lines) {
    if (!line.key) continue;
    const positions = indexes.get(line.key) ?? [];
    positions.push(line.index);
    indexes.set(line.key, positions);
  }

  for (const key of [...entries.map(([entryKey]) => entryKey), ...remove]) {
    if ((indexes.get(key)?.length ?? 0) > 1) {
      throw new FrontmatterError('TASK_DOCUMENT_INVALID', `duplicate frontmatter key '${key}'`);
    }
  }

  const nextLines = lines.map((line) => line.raw);
  const additions: string[] = [];
  for (const [key, value] of entries) {
    const serialized = serializeScalar(value);
    const replacement = serialized === '' ? `${key}:` : `${key}: ${serialized}`;
    const index = indexes.get(key)?.[0];
    if (index === undefined) additions.push(replacement);
    else nextLines[index] = replacement;
  }
  const retainedLines = nextLines.filter((_, index) => {
    const key = lines[index]?.key;
    return !key || !removeSet.has(key);
  });
  if (additions.length > 0) {
    if (retainedLines.at(-1) === '') retainedLines.splice(-1, 0, ...additions);
    else retainedLines.push(...additions);
  }
  const body = retainedLines.join(block.eol);
  return content.slice(0, block.bodyStart) + body + content.slice(block.bodyEnd);
}

function extractTitle(content: string): string {
  for (const line of content.split('\n')) {
    const m = /^#\s+(?:任务[:：]?\s*)?(.+)$/.exec(line.trim());
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

export {
  parseTaskFrontmatter,
  parseTypedTaskFrontmatter,
  updateTaskFrontmatter,
  extractTitle
};
export type { Frontmatter, FrontmatterScalar, TypedFrontmatter };
