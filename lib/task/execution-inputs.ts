import { pathIncludes } from './lifecycle-path.ts';
import type { LifecyclePathState } from './lifecycle-path.ts';

type ExecutionStage = 'plan' | 'code';
type ExecutionInputFamily = 'analysis' | 'review-analysis' | 'plan' | 'review-plan';

function expectedExecutionInputFamilies(stage: ExecutionStage, pathState: LifecyclePathState): ExecutionInputFamily[] {
  if (pathState.status !== 'valid') return [];
  const input: ExecutionInputFamily = stage === 'plan' ? 'analysis' : pathIncludes(pathState, 'plan') ? 'plan' : 'analysis';
  const review: ExecutionInputFamily = input === 'plan' ? 'review-plan' : 'review-analysis';
  return [input, ...(pathIncludes(pathState, review) ? [review] : [])];
}

function executionInputsMatchLatest(
  stage: ExecutionStage,
  pathState: LifecyclePathState,
  latest: Partial<Record<ExecutionInputFamily, string>>,
  captured: readonly string[]
): boolean {
  const expected = expectedExecutionInputFamilies(stage, pathState);
  return expected.every((family) => Boolean(latest[family] && captured.includes(latest[family]!)));
}

export { expectedExecutionInputFamilies, executionInputsMatchLatest };
export type { ExecutionInputFamily, ExecutionStage };
