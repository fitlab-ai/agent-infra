import { coordinatePlatformWrite } from './operation-coordinator.ts';
import { syncPlatformComment as comment } from './issue-comments.ts';
import type { SyncOptions as CommentOptions } from './issue-comments.ts';
import { createPlatformIssue as createIssue, syncPlatformIssue as syncIssue } from './issues.ts';
import type { CreateOptions as CreateIssueOptions, SyncOptions as IssueOptions } from './issues.ts';
import { bindPlatformPullRequest as bindPr, createPlatformPullRequest as createPr, syncPlatformPullRequest as syncPr } from './pull-requests.ts';
import type { BindOptions, CreateOptions as CreatePrOptions, SyncOptions as PrOptions } from './pull-requests.ts';
import { publishPrReview as review } from './pr-review.ts';
import type { PublishPrReviewOptions } from './pr-review.ts';
import { syncPullRequestSummary as summary } from './pr-summary.ts';
import type { PullRequestSummarySyncOptions } from './pr-summary.ts';

export function syncPlatformComment(taskRef: string, options: CommentOptions) { return comment(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function createPlatformIssue(taskRef: string, options: CreateIssueOptions) { return createIssue(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function syncPlatformIssue(taskRef: string, options: IssueOptions) { return syncIssue(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function bindPlatformPullRequest(taskRef: string, options: BindOptions) { return bindPr(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function createPlatformPullRequest(taskRef: string, options: CreatePrOptions) { return createPr(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function syncPlatformPullRequest(taskRef: string, options: PrOptions) { return syncPr(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function publishPrReview(options: PublishPrReviewOptions) { return review({ ...options, coordinate: coordinatePlatformWrite }); }
export function syncPullRequestSummary(taskRef: string, options: PullRequestSummarySyncOptions) { return summary(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
