function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * pull a single `### HD-N` human-decision detail block out of an artifact. The
 * prefix must be followed by a word boundary so `HD-1` does not match `HD-10`
 * (e.g. `### HD-1`, `### HD-1：标题`, `### HD-1 [needs-human-decision]`). Leading
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

export { extractSection, findSectionHeading, extractSubSection };
