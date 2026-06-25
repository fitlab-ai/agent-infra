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

export { extractSection, findSectionHeading };
