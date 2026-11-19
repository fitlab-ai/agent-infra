import { coordinatePlatformWrite } from './operation-coordinator.ts';
import { syncPlatformComment as sync } from './issue-comments-execution.ts';
import type { SyncOptions } from './issue-comments-execution.ts';
export { COMMENT_BYTE_LIMIT, MARKERS, chunkArtifactComment, inspectPlatformCommentOperation, findMarkerComments, checkPlatformCommentOwner, listPlatformComments, normalizeCommentContent, renderTaskComment, renderTaskCommentResult, validateRelatedMarkerSet } from './issue-comments-execution.ts';
export type { CommentKind, SyncOptions } from './issue-comments-execution.ts';
export function syncPlatformComment(taskRef: string, options: SyncOptions) { return sync(taskRef, { ...options, coordinate: coordinatePlatformWrite }); }
