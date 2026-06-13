function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string[] {
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

  return [renderRow(headers), ...rows.map((row) => renderRow(row))];
}

export { formatTable };
