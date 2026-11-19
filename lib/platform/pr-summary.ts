import { coordinatePlatformWrite } from './operation-coordinator.ts';
import { syncPullRequestSummary as sync } from './pr-summary-execution.ts';
import type { PullRequestSummarySyncOptions } from './pr-summary-execution.ts';
export { buildPullRequestSummary, reportWrite, summaryCommentState, summaryContext, warningResultForPrimary, prepareAndRenderPrSummaryContent } from './pr-summary-execution.ts';
export function syncPullRequestSummary(taskRef: string, options: PullRequestSummarySyncOptions) { return sync(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
