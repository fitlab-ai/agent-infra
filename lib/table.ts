import pc from 'picocolors';

function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: { zebra?: boolean } = {}
): string[] {
  const { zebra = false } = options;
  const columnCount = headers.length;
  const widths = headers.map((header, i) => {
    const headerLen = header.length;
    let max = headerLen;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const renderRow = (values: readonly string[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < columnCount; i += 1) {
      const cell = values[i] ?? '';
      if (i === columnCount - 1) {
        parts.push(cell);
      } else {
        parts.push(cell.padEnd(widths[i]!));
      }
    }
    return parts.join('  ').trimEnd();
  };

  const dataLines = rows.map((row, i) => {
    const line = renderRow(row);
    // Zebra stripes: dim even-numbered data rows (rows 2, 4, 6... -> 0-based
    // odd index). The header and odd rows are left untouched. When zebra is
    // off, pc.dim is never called, so the output is byte-identical to before.
    return zebra && i % 2 === 1 ? pc.dim(line) : line;
  });

  return [renderRow(headers), ...dataLines];
}

export { formatTable };
