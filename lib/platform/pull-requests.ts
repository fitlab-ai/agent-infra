import { coordinatePlatformWrite } from './operation-coordinator.ts';
import { bindPlatformPullRequest as bind, createPlatformPullRequest as create, syncPlatformPullRequest as sync } from './pull-requests-execution.ts';
import type { BindOptions, CreateOptions, SyncOptions } from './pull-requests-execution.ts';
export { inspectPlatformPullRequest, inspectPlatformPullRequestByNumber, recoverCreatedPullRequest, resolveExternalPullRequest, skipPlatformPullRequestFact, selectExternalPullRequest, syncPlatformPullRequestInLabels, warningResultForPrimary } from './pull-requests-execution.ts';
export type { BindOptions, CreateOptions, PullRequestResult, PullRequestSnapshot, SyncOptions } from './pull-requests-execution.ts';
export function bindPlatformPullRequest(taskRef: string, options: BindOptions) { return bind(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function createPlatformPullRequest(taskRef: string, options: CreateOptions) { return create(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function syncPlatformPullRequest(taskRef: string, options: SyncOptions) { return sync(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
