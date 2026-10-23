export type SummaryContentOperations<T> = Readonly<{
  validate: (value: unknown) => T;
  correct: (value: unknown) => unknown;
  render: (value: T) => string;
}>;

function parse<T>(value: unknown, parser: (value: unknown) => T): T {
  try {
    return parser(value);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function runSummaryContentPipeline<T>(
  value: unknown,
  operations: SummaryContentOperations<T>
): Readonly<{ content: T; rendered: string }> {
  try { parse(value, operations.validate); } catch { /* Source correction gets a chance to repair invalid structure. */ }
  const corrected = operations.correct(value);
  const content = parse(corrected, operations.validate);
  return { content, rendered: operations.render(content) };
}
