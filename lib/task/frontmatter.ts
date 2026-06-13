type Frontmatter = Record<string, string>;

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

function extractTitle(content: string): string {
  for (const line of content.split('\n')) {
    const m = /^#\s+(?:任务[:：]?\s*)?(.+)$/.exec(line.trim());
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

export { parseTaskFrontmatter, extractTitle };
export type { Frontmatter };
