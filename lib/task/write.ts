import fs from 'node:fs';
import path from 'node:path';

import { isValidAgentInfraVersion, VERSION } from '../version.ts';
import {
  parseTypedTaskFrontmatter,
  updateTaskFrontmatter
} from './frontmatter.ts';
import type { FrontmatterScalar } from './frontmatter.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import type {
  ResolveTaskRefErrorCode,
  TaskWorkspaceState
} from './resolve-ref.ts';
import { allowsManualOverride } from './guard-override.ts';
import type { ManualOverrideCapability } from './guard-override.ts';
import { mutateTableRow, upsertSection } from './sections.ts';
import { validateCurrentTaskContract } from './current-contract.ts';
import { invalidationBlocks, parseInvalidationDocument } from './invalidation.ts';
import type {
  TableRowDeleteMutation,
  TableRowUpsertMutation
} from './sections.ts';

type FrontmatterMutation = {
  kind: 'frontmatter';
  set: Readonly<Record<string, FrontmatterScalar>>;
  remove?: readonly string[];
};

type SectionMutation = {
  kind: 'section';
  aliases: readonly string[];
  heading: string;
  body: string;
};

type TaskMutation =
  | FrontmatterMutation
  | SectionMutation
  | TableRowUpsertMutation
  | TableRowDeleteMutation;

type TaskWriteRequest = {
  taskRef: string;
  expectedState: TaskWorkspaceState;
  mutations: readonly TaskMutation[];
  dryRun?: boolean;
};

type TaskOperationSummary =
  | {
      index: number;
      kind: 'frontmatter';
      fields: readonly string[];
      wouldChange: boolean;
    }
  | {
      index: number;
      kind: 'section';
      heading: string;
      operation: 'create' | 'update';
      wouldChange: boolean;
    }
  | {
      index: number;
      kind: 'table-row';
      section: string;
      keyColumn: string;
      key: string;
      operation: 'insert' | 'update' | 'delete';
      wouldChange: boolean;
    }
  | {
      index: -1;
      kind: 'metadata';
      fields: readonly ['updated_at', 'agent_infra_version'];
      wouldChange: boolean;
    };

type TaskWriteMetadata = {
  timestamp: string;
  agentInfraVersion: string;
};

type TaskWriteErrorCode =
  | ResolveTaskRefErrorCode
  | 'TASK_STATE_MISMATCH'
  | 'TASK_CURRENT_CONTRACT_INVALID'
  | 'TASK_INVALIDATION_INVALID'
  | 'TASK_INVALIDATION_BLOCKED'
  | 'TASK_READ_FAILED'
  | 'TASK_DOCUMENT_INVALID'
  | 'MUTATION_INVALID'
  | 'TABLE_NOT_FOUND'
  | 'TABLE_AMBIGUOUS'
  | 'TABLE_DUPLICATE_KEY'
  | 'TABLE_UNKNOWN_COLUMN'
  | 'TABLE_KEY_COLUMN_IN_VALUES'
  | 'TABLE_KEY_CONFLICT'
  | 'TABLE_MISSING_COLUMN'
  | 'TABLE_DELETE_VALUES_FORBIDDEN'
  | 'TABLE_CELL_INVALID'
  | 'METADATA_CAPTURE_FAILED'
  | 'TEMP_WRITE_FAILED'
  | 'RENAME_FAILED'
  | 'TEMP_CLEANUP_FAILED';

type TaskWriteError = { code: TaskWriteErrorCode; message: string };

type TaskWriteSuccessBase = {
  requestRef: string;
  expectedState: TaskWorkspaceState;
  taskId: string;
  taskMdPath: string;
  actualState: TaskWorkspaceState;
  operations: readonly TaskOperationSummary[];
  timestamp: string;
  agentInfraVersion: string;
  error: null;
};

type TaskWritePlanned = TaskWriteSuccessBase & { status: 'planned'; changed: true };
type TaskWriteApplied = TaskWriteSuccessBase & { status: 'applied'; changed: true };
type TaskWriteNoOp = TaskWriteSuccessBase & { status: 'no-op'; changed: false };

type TaskWriteFailed = {
  status: 'failed';
  requestRef: string;
  expectedState: TaskWorkspaceState;
  taskId: string | null;
  taskMdPath: string | null;
  actualState: TaskWorkspaceState | null;
  changed: false;
  operations: readonly TaskOperationSummary[];
  timestamp: string | null;
  agentInfraVersion: string | null;
  error: TaskWriteError;
};

type TaskWriteResult =
  | TaskWritePlanned
  | TaskWriteApplied
  | TaskWriteNoOp
  | TaskWriteFailed;

type TaskFileSystem = {
  readFileSync: (file: string) => string;
  statModeSync: (file: string) => number;
  writeFileSync: (file: string, content: string, mode: number) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (file: string) => void;
};

type TaskWriteOptions = {
  repoRoot?: string;
  taskLocation?: {
    repoRoot: string;
    taskId: string;
    taskMdPath: string;
    state: TaskWorkspaceState;
  };
  metadataProvider?: () => TaskWriteMetadata;
  randomSuffix?: () => string;
  fileSystem?: Partial<TaskFileSystem>;
  manualOverride?: ManualOverrideCapability;
  invalidationContext?: 'standard' | 'source-completion' | 'reconcile';
};

const DEFAULT_FILE_SYSTEM: TaskFileSystem = {
  readFileSync: (file) => fs.readFileSync(file, 'utf8'),
  statModeSync: (file) => fs.statSync(file).mode,
  writeFileSync: (file, content, mode) => {
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode });
  },
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (file) => fs.unlinkSync(file)
};

function canonicalTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offset = Math.abs(offsetMinutes);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

function captureTaskWriteMetadata(): TaskWriteMetadata {
  return { timestamp: canonicalTimestamp(), agentInfraVersion: VERSION };
}

function failure(
  request: TaskWriteRequest,
  identity: { taskId: string | null; taskMdPath: string | null; actualState: TaskWorkspaceState | null },
  code: TaskWriteErrorCode,
  message: string,
  operations: readonly TaskOperationSummary[] = [],
  metadata: TaskWriteMetadata | null = null
): TaskWriteFailed {
  return {
    status: 'failed',
    requestRef: request.taskRef,
    expectedState: request.expectedState,
    taskId: identity.taskId,
    taskMdPath: identity.taskMdPath,
    actualState: identity.actualState,
    changed: false,
    operations,
    timestamp: metadata?.timestamp ?? null,
    agentInfraVersion: metadata?.agentInfraVersion ?? null,
    error: { code, message }
  };
}

function errorDetails(error: unknown, fallback: TaskWriteErrorCode): TaskWriteError {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return {
      code: error.code as TaskWriteErrorCode,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return {
    code: fallback,
    message: error instanceof Error ? error.message : String(error)
  };
}

function writeTask(request: TaskWriteRequest, options: TaskWriteOptions = {}): TaskWriteResult {
  const resolved = options.taskLocation
    ? {
        ok: true as const,
        repoRoot: options.taskLocation.repoRoot,
        taskId: options.taskLocation.taskId,
        taskDir: path.dirname(options.taskLocation.taskMdPath),
        taskMdPath: options.taskLocation.taskMdPath,
        state: options.taskLocation.state
      }
    : resolveTaskRef(request.taskRef, { repoRoot: options.repoRoot });
  if (!resolved.ok) {
    return failure(
      request,
      { taskId: resolved.taskId, taskMdPath: null, actualState: null },
      resolved.code,
      resolved.message
    );
  }
  const identity = {
    taskId: resolved.taskId,
    taskMdPath: resolved.taskMdPath,
    actualState: resolved.state
  };
  if (resolved.state !== request.expectedState && !allowsManualOverride(options.manualOverride, 'task.write', 'TASK_STATE_MISMATCH')) {
    return failure(
      request,
      identity,
      'TASK_STATE_MISMATCH',
      `task ${resolved.taskId} is ${resolved.state}, expected ${request.expectedState}`
    );
  }

  const io: TaskFileSystem = { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem };
  let original: string;
  let mode: number;
  try {
    original = io.readFileSync(resolved.taskMdPath);
    mode = io.statModeSync(resolved.taskMdPath);
  } catch (error) {
    return failure(
      request,
      identity,
      'TASK_READ_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (resolved.state === 'active') {
    const contract = validateCurrentTaskContract(original);
    if (!contract.ok) {
      return failure(request, identity, contract.code, contract.message);
    }
    if (
      invalidationBlocks(contract.invalidation)
      && options.invalidationContext !== 'source-completion'
      && options.invalidationContext !== 'reconcile'
    ) {
      return failure(
        request,
        identity,
        'TASK_INVALIDATION_BLOCKED',
        'task has an incomplete artifact invalidation operation; reconcile it before writing downstream state'
      );
    }
  } else {
    const invalidation = parseInvalidationDocument(original);
    if (!invalidation.ok) return failure(request, identity, 'TASK_INVALIDATION_INVALID', invalidation.message);
  }

  let candidate = original;
  const operations: TaskOperationSummary[] = [];
  try {
    parseTypedTaskFrontmatter(original);
    if (!Array.isArray(request.mutations)) {
      throw Object.assign(new Error('mutations must be an array'), { code: 'MUTATION_INVALID' });
    }
    for (const [index, mutation] of request.mutations.entries()) {
      if (!mutation || typeof mutation !== 'object' || !('kind' in mutation)) {
        throw Object.assign(new Error(`mutation ${index} is invalid`), { code: 'MUTATION_INVALID' });
      }
      const before = candidate;
      if (mutation.kind === 'frontmatter') {
        candidate = updateTaskFrontmatter(candidate, mutation.set, mutation.remove);
        operations.push({
          index,
          kind: 'frontmatter',
          fields: [...Object.keys(mutation.set), ...(mutation.remove ?? [])],
          wouldChange: candidate !== before
        });
      } else if (mutation.kind === 'section') {
        const result = upsertSection(candidate, mutation);
        candidate = result.content;
        operations.push({
          index,
          kind: 'section',
          heading: result.heading,
          operation: result.operation,
          wouldChange: candidate !== before
        });
      } else if (mutation.kind === 'table-row') {
        const result = mutateTableRow(candidate, mutation);
        candidate = result.content;
        operations.push({
          index,
          kind: 'table-row',
          section: result.section,
          keyColumn: mutation.keyColumn,
          key: mutation.key.trim(),
          operation: result.operation,
          wouldChange: candidate !== before
        });
      } else {
        throw Object.assign(new Error(`mutation ${index} has an unknown kind`), {
          code: 'MUTATION_INVALID'
        });
      }
    }
  } catch (error) {
    const details = errorDetails(error, 'MUTATION_INVALID');
    return failure(request, identity, details.code, details.message);
  }

  let metadata: TaskWriteMetadata;
  try {
    metadata = (options.metadataProvider ?? captureTaskWriteMetadata)();
    if (
      !metadata ||
      typeof metadata.timestamp !== 'string' ||
      !metadata.timestamp ||
      typeof metadata.agentInfraVersion !== 'string' ||
      !metadata.agentInfraVersion
    ) {
      throw new Error('metadata provider returned invalid metadata');
    }
  } catch (error) {
    return failure(
      request,
      identity,
      'METADATA_CAPTURE_FAILED',
      error instanceof Error ? error.message : String(error),
      operations
    );
  }
  if (resolved.state === 'active' && !isValidAgentInfraVersion(metadata.agentInfraVersion)) {
    return failure(
      request,
      identity,
      'TASK_CURRENT_CONTRACT_INVALID',
      `metadata agentInfraVersion must be a valid v-prefixed semver (received ${metadata.agentInfraVersion})`,
      operations,
      metadata
    );
  }

  if (candidate === original) {
    return {
      status: 'no-op',
      requestRef: request.taskRef,
      expectedState: request.expectedState,
      taskId: resolved.taskId,
      taskMdPath: resolved.taskMdPath,
      actualState: resolved.state,
      changed: false,
      operations,
      timestamp: metadata.timestamp,
      agentInfraVersion: metadata.agentInfraVersion,
      error: null
    };
  }

  try {
    const beforeMetadata = candidate;
    candidate = updateTaskFrontmatter(candidate, {
      updated_at: metadata.timestamp,
      agent_infra_version: metadata.agentInfraVersion
    });
    operations.push({
      index: -1,
      kind: 'metadata',
      fields: ['updated_at', 'agent_infra_version'],
      wouldChange: candidate !== beforeMetadata
    });
  } catch (error) {
    const details = errorDetails(error, 'TASK_DOCUMENT_INVALID');
    return failure(request, identity, details.code, details.message, operations, metadata);
  }

  const successBase: TaskWriteSuccessBase = {
    requestRef: request.taskRef,
    expectedState: request.expectedState,
    taskId: resolved.taskId,
    taskMdPath: resolved.taskMdPath,
    actualState: resolved.state,
    operations,
    timestamp: metadata.timestamp,
    agentInfraVersion: metadata.agentInfraVersion,
    error: null
  };
  if (request.dryRun) {
    return { ...successBase, status: 'planned', changed: true };
  }

  const suffix = (options.randomSuffix ?? (() => Math.random().toString(36).slice(2)))();
  const tempPath = path.join(
    path.dirname(resolved.taskMdPath),
    `.task.md.${process.pid}.${suffix}.tmp`
  );
  let primary: TaskWriteError | null = null;
  let shouldCleanupTemp = false;
  try {
    io.writeFileSync(tempPath, candidate, mode);
    shouldCleanupTemp = true;
  } catch (error) {
    shouldCleanupTemp = (error as NodeJS.ErrnoException).code !== 'EEXIST';
    primary = errorDetails(error, 'TEMP_WRITE_FAILED');
    primary.code = 'TEMP_WRITE_FAILED';
  }
  if (!primary) {
    try {
      io.renameSync(tempPath, resolved.taskMdPath);
    } catch (error) {
      primary = errorDetails(error, 'RENAME_FAILED');
      primary.code = 'RENAME_FAILED';
    }
  }
  if (primary && shouldCleanupTemp) {
    try {
      io.unlinkSync(tempPath);
    } catch (cleanupError) {
      const nodeError = cleanupError as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        return failure(
          request,
          identity,
          'TEMP_CLEANUP_FAILED',
          `${primary.code}: ${primary.message}; failed to clean ${tempPath}: ${nodeError.message}`,
          operations,
          metadata
        );
      }
    }
  }
  if (primary) {
    return failure(
      request,
      identity,
      primary.code,
      primary.message,
      operations,
      metadata
    );
  }
  return { ...successBase, status: 'applied', changed: true };
}

export { writeTask, captureTaskWriteMetadata, canonicalTimestamp };
export type {
  FrontmatterMutation,
  SectionMutation,
  TaskMutation,
  TaskWriteRequest,
  TaskOperationSummary,
  TaskWriteMetadata,
  TaskWriteErrorCode,
  TaskWriteError,
  TaskWritePlanned,
  TaskWriteApplied,
  TaskWriteNoOp,
  TaskWriteFailed,
  TaskWriteResult,
  TaskFileSystem,
  TaskWriteOptions
};
export type { FrontmatterScalar } from './frontmatter.ts';
export type { ResolveTaskRefErrorCode, TaskWorkspaceState } from './resolve-ref.ts';
export type {
  TableRowBase,
  TableRowUpsertMutation,
  TableRowDeleteMutation
} from './sections.ts';
