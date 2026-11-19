import { coordinatePlatformWrite } from './operation-coordinator.ts';
import { createPlatformIssue as create, syncPlatformIssue as sync } from './issues-execution.ts';
import type { CreateOptions, SyncOptions } from './issues-execution.ts';
export { bindPlatformIssue, inspectPlatformIssue, requirementSectionAnchors } from './issues-execution.ts';
export type { CreateOptions, IssueResult, SyncOptions } from './issues-execution.ts';
export function createPlatformIssue(taskRef: string, options: CreateOptions) { return create(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
export function syncPlatformIssue(taskRef: string, options: SyncOptions) { return sync(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
