export type SummaryContentValidation<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Error }>;

export type SummaryContentOperations<T> = Readonly<{
  prepare: (value: unknown) => unknown;
  validate: (value: unknown) => SummaryContentValidation<T>;
  correct: (value: unknown, validation: SummaryContentValidation<T>) => unknown;
  render: (value: T) => string;
}>;

export function runSummaryContentPipeline<T>(
  value: unknown,
  operations: SummaryContentOperations<T>
): Readonly<{ content: T; rendered: string }> {
  const prepared = operations.prepare(value);
  const initial = operations.validate(prepared);
  const corrected = operations.correct(prepared, initial);
  const final = operations.validate(corrected);
  if (!final.ok) throw final.error;
  return { content: final.value, rendered: operations.render(final.value) };
}
