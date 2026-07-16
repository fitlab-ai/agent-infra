import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_NAME = '.short-ids.json';

type NormalizeResult =
  | { kind: 'shortId'; value: string }
  | { kind: 'pass'; value: string }
  | {
      kind: 'error';
      code: 'SHORT_ID_RESERVED' | 'SHORT_ID_CAPACITY_EXCEEDED';
      message: string;
    };

type NormalizeOpts = { shortIdLength: number };

function normalizeShortIdInput(input: string, opts: NormalizeOpts): NormalizeResult {
  const L = opts.shortIdLength;
  const m = /^#?(\d+)$/.exec(input);
  if (!m) {
    return { kind: 'pass', value: input };
  }
  const n = Number(m[1]);
  if (n === 0) {
    return {
      kind: 'error',
      code: 'SHORT_ID_RESERVED',
      message: `short id '${input}' is invalid (#${'0'.repeat(L)} is reserved)`
    };
  }
  const max = Math.pow(10, L) - 1;
  if (n > max) {
    return {
      kind: 'error',
      code: 'SHORT_ID_CAPACITY_EXCEEDED',
      message: `short id ${n} exceeds shortIdLength=${L} capacity (max=${max}); archive tasks or raise task.shortIdLength in .agents/.airc.json`
    };
  }
  return { kind: 'shortId', value: `#${String(n).padStart(L, '0')}` };
}

type ResolveShortIdErrorCode =
  | 'SHORT_ID_RESERVED'
  | 'SHORT_ID_CAPACITY_EXCEEDED'
  | 'SHORT_ID_REGISTRY_NOT_FOUND'
  | 'SHORT_ID_REGISTRY_READ_FAILED'
  | 'SHORT_ID_REGISTRY_INVALID_JSON'
  | 'SHORT_ID_REGISTRY_INVALID_SCHEMA'
  | 'SHORT_ID_REGISTRY_DUPLICATE_TASK'
  | 'SHORT_ID_NOT_FOUND'
  | 'SHORT_ID_STALE';

type ResolveShortIdResult =
  | { ok: true; taskId: string }
  | { ok: false; code: ResolveShortIdErrorCode; message: string; taskId: string | null };

function shortIdFailure(
  code: ResolveShortIdErrorCode,
  message: string,
  taskId: string | null = null
): ResolveShortIdResult {
  return { ok: false, code, message, taskId };
}

function resolveShortIdReadOnly(
  input: string,
  repoRoot: string,
  opts: NormalizeOpts
): ResolveShortIdResult {
  const normalized = normalizeShortIdInput(input, opts);
  if (normalized.kind === 'error') {
    return shortIdFailure(normalized.code, normalized.message);
  }
  if (normalized.kind !== 'shortId') {
    return shortIdFailure(
      'SHORT_ID_NOT_FOUND',
      `short id '${input}' not found in active task registry`
    );
  }

  const key = normalized.value.slice(1);
  const registryPath = path.join(repoRoot, '.agents', 'workspace', 'active', REGISTRY_NAME);
  if (!fs.existsSync(registryPath)) {
    return shortIdFailure(
      'SHORT_ID_REGISTRY_NOT_FOUND',
      `short id '#${key}' not found; active task registry is empty.`
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch (error) {
    return shortIdFailure(
      'SHORT_ID_REGISTRY_READ_FAILED',
      `cannot read registry ${registryPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return shortIdFailure(
      'SHORT_ID_REGISTRY_INVALID_JSON',
      `registry ${registryPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const max = Math.pow(10, opts.shortIdLength) - 1;
  const validKey = new RegExp(`^\\d{${opts.shortIdLength}}$`);
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    (data as { version?: unknown }).version !== 1 ||
    !(data as { ids?: unknown }).ids ||
    typeof (data as { ids?: unknown }).ids !== 'object' ||
    Array.isArray((data as { ids?: unknown }).ids)
  ) {
    return shortIdFailure(
      'SHORT_ID_REGISTRY_INVALID_SCHEMA',
      `registry ${registryPath} has invalid schema`
    );
  }

  const ids = (data as RegistrySchema).ids;
  const seen = new Map<string, string>();
  for (const [registryKey, taskId] of Object.entries(ids)) {
    const numericKey = Number(registryKey);
    if (
      !validKey.test(registryKey) ||
      numericKey < 1 ||
      numericKey > max ||
      typeof taskId !== 'string' ||
      !/^TASK-\d{8}-\d{6}$/.test(taskId)
    ) {
      return shortIdFailure(
        'SHORT_ID_REGISTRY_INVALID_SCHEMA',
        `registry ${registryPath} has invalid schema`
      );
    }
    const existing = seen.get(taskId);
    if (existing) {
      return shortIdFailure(
        'SHORT_ID_REGISTRY_DUPLICATE_TASK',
        `duplicate registry entries for taskId ${taskId} at keys [#${existing}, #${registryKey}]; manual resolution required`,
        taskId
      );
    }
    seen.set(taskId, registryKey);
  }

  const taskId = ids[key];
  if (!taskId) {
    const message = Object.keys(ids).length === 0
      ? `short id '#${key}' not found; active task registry is empty.`
      : `short id '#${key}' not found in active task registry (it may have been cleaned up after archival; check 'task-short-id.js list').`;
    return shortIdFailure('SHORT_ID_NOT_FOUND', message);
  }
  const taskMdPath = path.join(
    repoRoot,
    '.agents',
    'workspace',
    'active',
    taskId,
    'task.md'
  );
  if (!fs.existsSync(taskMdPath)) {
    const remainingActiveEntries = Object.values(ids).filter((candidateTaskId) =>
      fs.existsSync(
        path.join(
          repoRoot,
          '.agents',
          'workspace',
          'active',
          candidateTaskId,
          'task.md'
        )
      )
    );
    const message = remainingActiveEntries.length === 0
      ? `short id '#${key}' not found; active task registry is empty.`
      : `short id '#${key}' not found in active task registry (it may have been cleaned up after archival; check 'task-short-id.js list').`;
    return shortIdFailure(
      'SHORT_ID_STALE',
      message,
      taskId
    );
  }
  return { ok: true, taskId };
}

type RegistrySchema = {
  version: number;
  ids: Record<string, string>;
};

function readRegistry(repoRoot: string): RegistrySchema | null {
  const registryPath = path.join(repoRoot, '.agents', 'workspace', 'active', REGISTRY_NAME);
  if (!fs.existsSync(registryPath)) return null;
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const data = JSON.parse(raw) as RegistrySchema;
    if (!data || typeof data !== 'object' || !data.ids) return null;
    return data;
  } catch {
    return null;
  }
}

function readBranchFromTaskMd(repoRoot: string, taskId: string): string | null {
  const taskMdPath = path.join(repoRoot, '.agents', 'workspace', 'active', taskId, 'task.md');
  if (!fs.existsSync(taskMdPath)) return null;
  const content = fs.readFileSync(taskMdPath, 'utf8');
  const m = content.match(/^branch:\s*(.+)$/m);
  if (!m || !m[1]) return null;
  return m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
}

function loadShortIdByTaskId(repoRoot: string): Map<string, string> {
  const registry = readRegistry(repoRoot);
  const map = new Map<string, string>();
  if (!registry) return map;
  for (const [key, taskId] of Object.entries(registry.ids)) {
    map.set(taskId, `#${key}`);
  }
  return map;
}

/**
 * Resolve a branch to its active-task short id (`#NN`), or `null` when no
 * active task is bound to that branch.
 *
 * Two-state semantics: this only consults the active registry
 * (`active/.short-ids.json`) plus each `active/{taskId}/task.md`. Tasks moved
 * to completed/blocked/cancelled/archive have already released their short id,
 * so their branches return `null` — in `ai sandbox ls` that surfaces as `-`,
 * meaning the sandbox is free to remove.
 */
function lookupShortIdByBranch(
  branch: string,
  repoRoot: string,
  _opts?: { shortIdLength?: number }
): string | null {
  const registry = readRegistry(repoRoot);
  if (!registry) return null;
  const matches: string[] = [];
  for (const [key, taskId] of Object.entries(registry.ids)) {
    const taskBranch = readBranchFromTaskMd(repoRoot, taskId);
    if (taskBranch && taskBranch === branch) {
      matches.push(`#${key}`);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    process.stderr.write(
      `Warning: branch '${branch}' is bound to multiple active tasks: ${matches.join(', ')}; using ${matches[0]}\n`
    );
  }
  return matches[0]!;
}

export {
  normalizeShortIdInput,
  resolveShortIdReadOnly,
  lookupShortIdByBranch,
  loadShortIdByTaskId
};
export type {
  NormalizeResult,
  NormalizeOpts,
  ResolveShortIdErrorCode,
  ResolveShortIdResult
};
