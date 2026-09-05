import type { FrontmatterScalar } from './frontmatter.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type SectionMutationInput = {
  aliases: readonly string[];
  heading: string;
  body: string;
};

type TableRowBase = {
  kind: 'table-row';
  sectionAliases: readonly string[];
  columns: readonly string[];
  keyColumn: string;
  key: string;
};

type TableRowUpsertMutation = TableRowBase & {
  action: 'upsert';
  values: Readonly<Record<string, FrontmatterScalar>>;
};

type TableRowDeleteMutation = TableRowBase & { action: 'delete' };
type TableRowMutation = TableRowUpsertMutation | TableRowDeleteMutation;

type SectionMutationResult = {
  content: string;
  heading: string;
  operation: 'create' | 'update';
};

type TableMutationResult = {
  content: string;
  section: string;
  operation: 'insert' | 'update' | 'delete';
};

type ParsedTableRow = {
  values: Readonly<Record<string, string>>;
  sourceLine: number;
};

type ParsedTable = {
  heading: string;
  rows: readonly ParsedTableRow[];
};

type DocumentMutationErrorCode =
  | 'TASK_DOCUMENT_INVALID'
  | 'MUTATION_INVALID'
  | 'TABLE_NOT_FOUND'
  | 'TABLE_AMBIGUOUS'
  | 'TABLE_DUPLICATE_KEY'
  | 'TABLE_UNKNOWN_COLUMN'
  | 'TABLE_KEY_COLUMN_IN_VALUES'
  | 'TABLE_KEY_CONFLICT'
  | 'TABLE_MISSING_COLUMN'
  | 'TABLE_DELETE_VALUES_FORBIDDEN'
  | 'TABLE_CELL_INVALID';

class DocumentMutationError extends Error {
  code: DocumentMutationErrorCode;

  constructor(code: DocumentMutationErrorCode, message: string) {
    super(message);
    this.name = 'DocumentMutationError';
    this.code = code;
  }
}

function parseTable(
  content: string,
  input: { sectionAliases: readonly string[]; columns: readonly string[]; keyColumn?: string }
): ParsedTable | null {
  validateAliases(input.sectionAliases, 'table section aliases');
  if (
    !Array.isArray(input.columns) || input.columns.length === 0 ||
    input.columns.some((column) => !column || /[\r\n|]/.test(column)) ||
    new Set(input.columns).size !== input.columns.length
  ) {
    throw new DocumentMutationError('MUTATION_INVALID', 'table columns are invalid');
  }
  const keyColumn = input.keyColumn ?? input.columns[0]!;
  if (!input.columns.includes(keyColumn)) {
    throw new DocumentMutationError('MUTATION_INVALID', 'table key column is invalid');
  }
  const sections = matchingSections(content, input.sectionAliases);
  if (sections.length === 0) return null;
  if (sections.length > 1) {
    throw new DocumentMutationError('TASK_DOCUMENT_INVALID', 'table section is ambiguous');
  }
  const section = sections[0]!;
  const sectionLines = linesOf(content).filter(
    (line) => line.start >= section.bodyStart && line.start < section.end
  );
  const firstContent = sectionLines.findIndex((line) => line.text.trim() !== '');
  const tables: number[] = [];
  for (let index = 0; index + 1 < sectionLines.length; index += 1) {
    const header = splitTableCells(sectionLines[index]!.text);
    const separator = splitTableCells(sectionLines[index + 1]!.text);
    if (!header || !separator || header.cells.length !== input.columns.length) continue;
    const names = header.cells.map((cell) => decodeCell(cell).trim());
    if (!names.every((name, column) => name === input.columns[column])) continue;
    if (
      separator.cells.length === input.columns.length &&
      separator.cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
    ) tables.push(index);
  }
  if (tables.length === 0) {
    throw new DocumentMutationError('TABLE_NOT_FOUND', 'matching table not found');
  }
  if (tables.length > 1) {
    throw new DocumentMutationError('TABLE_AMBIGUOUS', 'matching table appears more than once');
  }
  const rows: ParsedTableRow[] = [];
  const seen = new Set<string>();
  for (let index = tables[0]! + 2; index < sectionLines.length; index += 1) {
    const line = sectionLines[index]!;
    if (!line.text.trim()) break;
    const parsed = splitTableCells(line.text);
    if (!parsed) break;
    if (parsed.cells.length !== input.columns.length) {
      throw new DocumentMutationError('TASK_DOCUMENT_INVALID', 'table row has the wrong column count');
    }
    const values = Object.fromEntries(input.columns.map((column, columnIndex) => [
      column,
      decodeCell(parsed.cells[columnIndex]!).trim()
    ]));
    const key = values[keyColumn]!;
    if (seen.has(key)) {
      throw new DocumentMutationError('TABLE_DUPLICATE_KEY', `duplicate table key '${key}'`);
    }
    seen.add(key);
    rows.push({ values, sourceLine: index - Math.max(firstContent, 0) });
  }
  return { heading: section.heading, rows };
}

type Line = {
  start: number;
  contentEnd: number;
  end: number;
  text: string;
  eol: string;
};

function linesOf(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline + 1;
    const hasCr = newline !== -1 && content[newline - 1] === '\r';
    const contentEnd = newline === -1 ? content.length : newline - (hasCr ? 1 : 0);
    lines.push({
      start,
      contentEnd,
      end,
      text: content.slice(start, contentEnd),
      eol: newline === -1 ? '' : hasCr ? '\r\n' : '\n'
    });
    start = end;
  }
  return lines;
}

function documentEol(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function matchingSections(content: string, aliases: readonly string[]) {
  const allowed = new Set(aliases);
  return linesOf(content)
    .map((line, index, lines) => {
      const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line.text);
      if (!match?.[2] || !allowed.has(match[2])) return null;
      const level = match[1]!.length;
      let end = content.length;
      for (let i = index + 1; i < lines.length; i += 1) {
        const nextHeading = /^(#{2,3})\s+/.exec(lines[i]!.text);
        if (nextHeading && nextHeading[1]!.length <= level) {
          end = lines[i]!.start;
          break;
        }
      }
      return { heading: match[2]!, line, bodyStart: line.end, end };
    })
    .filter((match): match is NonNullable<typeof match> => match !== null);
}

function validateAliases(aliases: readonly string[], name: string): void {
  if (!Array.isArray(aliases) || aliases.length === 0 || aliases.some((alias) => !alias || /[\r\n]/.test(alias))) {
    throw new DocumentMutationError('MUTATION_INVALID', `${name} must contain headings`);
  }
  if (new Set(aliases).size !== aliases.length) {
    throw new DocumentMutationError('MUTATION_INVALID', `${name} must be unique`);
  }
}

function upsertSection(content: string, input: SectionMutationInput): SectionMutationResult {
  validateAliases(input.aliases, 'section aliases');
  if (!input.heading || /[\r\n]/.test(input.heading) || typeof input.body !== 'string') {
    throw new DocumentMutationError('MUTATION_INVALID', 'section heading and body are invalid');
  }
  const matches = matchingSections(content, input.aliases);
  if (matches.length > 1) {
    throw new DocumentMutationError('TASK_DOCUMENT_INVALID', 'section aliases match more than once');
  }
  const eol = documentEol(content);
  const normalizedBody = input.body.replace(/\r?\n/g, eol).replace(/(?:\r?\n)+$/, '');
  if (matches.length === 0) {
    const separator = content.length === 0
      ? ''
      : content.endsWith(`${eol}${eol}`)
        ? ''
        : content.endsWith(eol)
          ? eol
          : `${eol}${eol}`;
    const body = normalizedBody ? `${eol}${eol}${normalizedBody}` : '';
    return {
      content: `${content}${separator}## ${input.heading}${body}${eol}`,
      heading: input.heading,
      operation: 'create'
    };
  }
  const match = matches[0]!;
  const existingBody = content
    .slice(match.bodyStart, match.end)
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '')
    .replace(/\r?\n/g, eol);
  if (existingBody === normalizedBody) {
    return { content, heading: match.heading, operation: 'update' };
  }
  const body = normalizedBody ? `${eol}${normalizedBody}${eol}${eol}` : eol;
  return {
    content: content.slice(0, match.bodyStart) + body + content.slice(match.end),
    heading: match.heading,
    operation: 'update'
  };
}

function splitTableCells(line: string): { prefix: string; suffix: string; cells: string[] } | null {
  const first = line.indexOf('|');
  const last = line.lastIndexOf('|');
  if (first === -1 || first === last || line.slice(0, first).trim() || line.slice(last + 1).trim()) {
    return null;
  }
  const inner = line.slice(first + 1, last);
  const cells: string[] = [];
  let start = 0;
  let backslashes = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '|' && backslashes % 2 === 0) {
      cells.push(inner.slice(start, i));
      start = i + 1;
    }
    backslashes = 0;
  }
  if (backslashes % 2 === 1) {
    throw new DocumentMutationError('TASK_DOCUMENT_INVALID', 'table cell has an unclosed escape');
  }
  cells.push(inner.slice(start));
  return { prefix: line.slice(0, first), suffix: line.slice(last + 1), cells };
}

function decodeCell(raw: string): string {
  let result = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\' && (raw[i + 1] === '\\' || raw[i + 1] === '|')) {
      result += raw[i + 1];
      i += 1;
    } else {
      result += raw[i];
    }
  }
  return result;
}

function scalarCell(value: FrontmatterScalar): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new DocumentMutationError('TABLE_CELL_INVALID', 'table numbers must be finite');
  }
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new DocumentMutationError('TABLE_CELL_INVALID', 'table cells must be scalar');
  }
  const raw = value === null ? '' : String(value);
  if (/[\r\n]/.test(raw)) {
    throw new DocumentMutationError('TABLE_CELL_INVALID', 'table cells cannot contain newlines');
  }
  return raw.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function replaceCellToken(raw: string, value: string): string {
  const firstContent = raw.search(/\S/);
  if (firstContent === -1) {
    const boundary = Math.floor(raw.length / 2);
    return `${raw.slice(0, boundary)}${value}${raw.slice(boundary)}`;
  }
  let lastContent = raw.length - 1;
  while (/\s/.test(raw[lastContent]!)) lastContent -= 1;
  return `${raw.slice(0, firstContent)}${value}${raw.slice(lastContent + 1)}`;
}

function mutateTableRow(content: string, mutation: TableRowMutation): TableMutationResult {
  validateAliases(mutation.sectionAliases, 'table section aliases');
  if (
    !Array.isArray(mutation.columns) ||
    mutation.columns.length === 0 ||
    mutation.columns.some((column) => !column || /[\r\n|]/.test(column)) ||
    new Set(mutation.columns).size !== mutation.columns.length ||
    !mutation.columns.includes(mutation.keyColumn) ||
    typeof mutation.key !== 'string' ||
    !mutation.key.trim() ||
    /[\r\n]/.test(mutation.key)
  ) {
    throw new DocumentMutationError('MUTATION_INVALID', 'table mutation shape is invalid');
  }
  const normalizedKey = mutation.key.trim();
  if (mutation.action !== 'upsert' && mutation.action !== 'delete') {
    throw new DocumentMutationError('MUTATION_INVALID', 'table action is invalid');
  }
  if (mutation.action === 'delete' && 'values' in mutation) {
    throw new DocumentMutationError('TABLE_DELETE_VALUES_FORBIDDEN', 'delete cannot include values');
  }
  if (
    mutation.action === 'upsert' &&
    (!mutation.values || typeof mutation.values !== 'object' || Array.isArray(mutation.values))
  ) {
    throw new DocumentMutationError('MUTATION_INVALID', 'upsert values must be an object');
  }

  const sections = matchingSections(content, mutation.sectionAliases);
  if (sections.length !== 1) {
    throw new DocumentMutationError(
      sections.length === 0 ? 'TABLE_NOT_FOUND' : 'TASK_DOCUMENT_INVALID',
      sections.length === 0 ? 'table section not found' : 'table section is ambiguous'
    );
  }
  const section = sections[0]!;
  const sectionLines = linesOf(content).filter(
    (line) => line.start >= section.bodyStart && line.start < section.end
  );
  const tables: { headerIndex: number; cells: string[] }[] = [];
  for (let i = 0; i + 1 < sectionLines.length; i += 1) {
    const header = splitTableCells(sectionLines[i]!.text);
    const separator = splitTableCells(sectionLines[i + 1]!.text);
    if (!header || !separator || header.cells.length !== mutation.columns.length) continue;
    const names = header.cells.map((cell) => decodeCell(cell).trim());
    if (!names.every((name, index) => name === mutation.columns[index])) continue;
    if (
      separator.cells.length !== mutation.columns.length ||
      !separator.cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
    ) continue;
    tables.push({ headerIndex: i, cells: header.cells });
  }
  if (tables.length === 0) {
    throw new DocumentMutationError('TABLE_NOT_FOUND', 'matching table not found');
  }
  if (tables.length > 1) {
    throw new DocumentMutationError('TABLE_AMBIGUOUS', 'matching table appears more than once');
  }

  const table = tables[0]!;
  const keyIndex = mutation.columns.indexOf(mutation.keyColumn);
  let rowIndex = table.headerIndex + 2;
  const rows: { line: Line; parsed: NonNullable<ReturnType<typeof splitTableCells>> }[] = [];
  while (rowIndex < sectionLines.length) {
    const line = sectionLines[rowIndex]!;
    const parsed = splitTableCells(line.text);
    if (!parsed) break;
    if (parsed.cells.length !== mutation.columns.length) {
      throw new DocumentMutationError('TASK_DOCUMENT_INVALID', 'table row has the wrong column count');
    }
    rows.push({ line, parsed });
    rowIndex += 1;
  }
  const matches = rows.filter(
    (row) => decodeCell(row.parsed.cells[keyIndex]!).trim() === normalizedKey
  );
  if (matches.length > 1) {
    throw new DocumentMutationError('TABLE_DUPLICATE_KEY', `duplicate table key '${normalizedKey}'`);
  }

  if (mutation.action === 'delete') {
    if (matches.length === 0) return { content, section: section.heading, operation: 'delete' };
    const line = matches[0]!.line;
    return {
      content: content.slice(0, line.start) + content.slice(line.end),
      section: section.heading,
      operation: 'delete'
    };
  }

  const values = mutation.values;
  for (const [column, value] of Object.entries(values)) {
    if (!mutation.columns.includes(column)) {
      throw new DocumentMutationError('TABLE_UNKNOWN_COLUMN', `unknown table column '${column}'`);
    }
    if (column === mutation.keyColumn) {
      const serialized = scalarCell(value);
      throw new DocumentMutationError(
        decodeCell(serialized).trim() === normalizedKey
          ? 'TABLE_KEY_COLUMN_IN_VALUES'
          : 'TABLE_KEY_CONFLICT',
        `key column '${column}' must not appear in values`
      );
    }
    scalarCell(value);
  }

  if (matches.length === 1) {
    const row = matches[0]!;
    const cells = [...row.parsed.cells];
    for (const [column, value] of Object.entries(values)) {
      const index = mutation.columns.indexOf(column);
      cells[index] = replaceCellToken(cells[index]!, scalarCell(value));
    }
    const rebuilt = `${row.parsed.prefix}|${cells.join('|')}|${row.parsed.suffix}`;
    return {
      content:
        content.slice(0, row.line.start) +
        rebuilt +
        row.line.eol +
        content.slice(row.line.end),
      section: section.heading,
      operation: 'update'
    };
  }

  const missing = mutation.columns.filter(
    (column) => column !== mutation.keyColumn && !Object.hasOwn(values, column)
  );
  if (missing.length > 0) {
    throw new DocumentMutationError(
      'TABLE_MISSING_COLUMN',
      `new table row is missing columns: ${missing.join(', ')}`
    );
  }
  const newCells = mutation.columns.map((column) =>
    column === mutation.keyColumn ? scalarCell(normalizedKey) : scalarCell(values[column]!)
  );
  const newLine = `| ${newCells.join(' | ')} |`;
  const separatorLine = sectionLines[table.headerIndex + 1]!;
  const lastLine = rows.at(-1)?.line ?? separatorLine;
  const eol = lastLine.eol || documentEol(content);
  const needsLeadingEol = lastLine.eol === '';
  return {
    content:
      content.slice(0, lastLine.end) +
      (needsLeadingEol ? eol : '') +
      newLine +
      eol +
      content.slice(lastLine.end),
    section: section.heading,
    operation: 'insert'
  };
}

/**
 * Return the body of the first `## {alias}` section (any alias matches), from
 * the heading line to the next `## ` heading or EOF. Lines are preserved
 * verbatim (checkbox text is never normalized); only leading/trailing blank
 * lines are trimmed. Returns '' when no alias heading is present.
 */
function extractSection(content: string, aliases: string[]): string {
  const lines = content.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (aliases.some((alias) => new RegExp(`^##\\s+${escapeRegExp(alias)}\\s*$`).test(line))) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Return the heading alias that actually appears as a `## {alias}` line, so a
 * rendered section can mirror the source language. Falls back to the first
 * alias when none is present.
 */
function findSectionHeading(content: string, aliases: string[]): string {
  for (const alias of aliases) {
    if (new RegExp(`^##\\s+${escapeRegExp(alias)}\\s*$`, 'm').test(content)) return alias;
  }
  return aliases[0]!;
}

/**
 * Return the body of the first `### {headingPrefix}` sub-section, from the
 * heading line (inclusive) to the next `### ` / `## ` heading or EOF. Used to
 * pull a single `### {ledger-id}` detail block out of an artifact. The prefix
 * must be followed by a word boundary so `PL-1` does not match `PL-10`
 * (e.g. `### PL-1`, `### PL-1：标题`, `### PL-1 [needs-human-decision]`). Leading
 * and trailing blank lines are trimmed. Returns '' when no match is present.
 */
function extractSubSection(content: string, headingPrefix: string): string {
  const lines = content.split('\n');
  const headRe = new RegExp(`^###\\s+${escapeRegExp(headingPrefix)}(?![\\w-])`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headRe.test(lines[i]!.trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^###?\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

export {
  extractSection,
  findSectionHeading,
  extractSubSection,
  parseTable,
  upsertSection,
  mutateTableRow,
  DocumentMutationError
};
export type {
  SectionMutationInput,
  SectionMutationResult,
  TableRowBase,
  TableRowUpsertMutation,
  TableRowDeleteMutation,
  TableRowMutation,
  TableMutationResult,
  DocumentMutationErrorCode,
  ParsedTableRow,
  ParsedTable
};
