type SourceLine = {
  start: number;
  end: number;
  text: string;
};

type VisibleHeading = SourceLine & {
  level: number;
  text: string;
};

type VisibleAnchor = SourceLine & {
  id: string;
};

type VisibleMarkdown = {
  hasUnclosedFence: boolean;
  lines: SourceLine[];
  headings: VisibleHeading[];
  anchors: VisibleAnchor[];
};

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const ANCHOR = /^\s*<a\s+id=(['"])([^'"]+)\1\s*><\/a>\s*$/;

function sourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    lines.push({ start, end, text: content.slice(start, end).replace(/\r$/, '') });
    start = newline === -1 ? content.length : newline + 1;
  }
  return lines;
}

function scanVisibleMarkdown(content: string): VisibleMarkdown {
  const lines = sourceLines(content);
  const visible: SourceLine[] = [];
  const headings: VisibleHeading[] = [];
  const anchors: VisibleAnchor[] = [];
  let fence: { character: '`' | '~'; length: number } | null = null;

  for (const line of lines) {
    if (fence) {
      const close = line.text.match(FENCE_CLOSE);
      if (close && close[1]![0] === fence.character && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = line.text.match(FENCE_OPEN);
    const marker = open?.[1];
    const info = open?.[2] ?? '';
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = { character: marker[0] as '`' | '~', length: marker.length };
      continue;
    }
    visible.push(line);
    const heading = line.text.match(HEADING);
    if (heading) headings.push({ ...line, level: heading[1]!.length, text: heading[2]!.trim() });
    const anchor = line.text.match(ANCHOR);
    if (anchor) anchors.push({ ...line, id: anchor[2]! });
  }
  return { lines: visible, headings, anchors, hasUnclosedFence: fence !== null };
}

export { scanVisibleMarkdown };
export type { SourceLine, VisibleHeading, VisibleMarkdown };
