import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_NAME = '.short-ids.json';
const LOCK_NAME = '.short-ids.json.lock';

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
  const m = /^(\d+)$/.exec(input);
  if (!m) {
    return { kind: 'pass', value: input };
  }
  const n = Number(m[1]);
  if (n === 0) {
    return {
      kind: 'error',
      code: 'SHORT_ID_RESERVED',
      message: `short id '${input}' is invalid (${'0'.repeat(L)} is reserved)`
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
  return { kind: 'shortId', value: String(n).padStart(L, '0') };
}

function isRemovedHashShortIdInput(input: string): boolean {
  return /^#\d+$/.test(input);
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

  const key = normalized.value;
  const registryPath = path.join(repoRoot, '.agents', 'workspace', 'active', REGISTRY_NAME);
  if (!fs.existsSync(registryPath)) {
    return shortIdFailure(
      'SHORT_ID_REGISTRY_NOT_FOUND',
      `short id '${key}' not found; active task registry is empty.`
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
        `duplicate registry entries for taskId ${taskId} at keys [${existing}, ${registryKey}]; manual resolution required`,
        taskId
      );
    }
    seen.set(taskId, registryKey);
  }

  const taskId = ids[key];
  if (!taskId) {
    const message = Object.keys(ids).length === 0
      ? `short id '${key}' not found; active task registry is empty.`
      : `short id '${key}' not found in active task registry (it may have been cleaned up after archival; check 'task-short-id.js list').`;
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
      ? `short id '${key}' not found; active task registry is empty.`
      : `short id '${key}' not found in active task registry (it may have been cleaned up after archival; check 'task-short-id.js list').`;
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

type ShortIdRegistryInspection =
  | { status: 'valid'; shortIds: Map<string, string> }
  | { status: 'missing' | 'invalid'; error: { code: string; message: string } };

type ShortIdMutationEffect = 'alloc' | 'release' | 'none';
type ShortIdMutationResult = {
  effect: 'allocated' | 'released' | 'unchanged';
  shortId: string | null;
  changed: boolean;
};

function configuredShortIdLength(repoRoot: string): number {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')
    ) as { task?: { shortIdLength?: unknown } };
    const value = config.task?.shortIdLength;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 2;
  } catch {
    return 2;
  }
}

function validateRegistry(data: unknown, registryPath: string, width: number): RegistrySchema {
  if (
    !data || typeof data !== 'object' || Array.isArray(data) ||
    (data as { version?: unknown }).version !== 1 ||
    !(data as { ids?: unknown }).ids || typeof (data as { ids?: unknown }).ids !== 'object' ||
    Array.isArray((data as { ids?: unknown }).ids)
  ) {
    throw Object.assign(new Error(`registry ${registryPath} has invalid schema`), {
      code: 'SHORT_ID_REGISTRY_INVALID_SCHEMA'
    });
  }
  const registry = data as RegistrySchema;
  const keyPattern = new RegExp(`^\\d{${width}}$`);
  const taskIds = new Set<string>();
  for (const [key, taskId] of Object.entries(registry.ids)) {
    if (!keyPattern.test(key) || Number(key) < 1 || typeof taskId !== 'string' || !/^TASK-\d{8}-\d{6}$/.test(taskId)) {
      throw Object.assign(new Error(`registry ${registryPath} has invalid schema`), {
        code: 'SHORT_ID_REGISTRY_INVALID_SCHEMA'
      });
    }
    if (taskIds.has(taskId)) {
      throw Object.assign(new Error(`duplicate registry entries for taskId ${taskId}`), {
        code: 'SHORT_ID_REGISTRY_DUPLICATE_TASK'
      });
    }
    taskIds.add(taskId);
  }
  return registry;
}

function readRegistryStrict(registryPath: string, width: number): RegistrySchema {
  if (!fs.existsSync(registryPath)) return { version: 1, ids: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`registry ${registryPath} is not valid JSON: ${String(error)}`), {
      code: 'SHORT_ID_REGISTRY_INVALID_JSON'
    });
  }
  return validateRegistry(parsed, registryPath, width);
}

function withRegistryLock<T>(activeDir: string, operation: () => T): T {
  fs.mkdirSync(activeDir, { recursive: true });
  const lockPath = path.join(activeDir, LOCK_NAME);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('registry lock timeout after 5000ms'), {
          code: 'SHORT_ID_LOCK_TIMEOUT'
        });
      }
    }
  }
  try {
    return operation();
  } finally {
    fs.rmdirSync(lockPath);
  }
}

function writeRegistry(registryPath: string, registry: RegistrySchema): void {
  const temporary = `${registryPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx' });
  try {
    fs.renameSync(temporary, registryPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort temp cleanup */ }
    throw error;
  }
}

function mutateShortIdRegistry(
  repoRoot: string,
  taskId: string,
  requested: ShortIdMutationEffect
): ShortIdMutationResult {
  const activeDir = path.join(repoRoot, '.agents', 'workspace', 'active');
  return mutateShortIdRegistryAt(activeDir, configuredShortIdLength(repoRoot), taskId, requested);
}

type ShortIdCommandRequest = {
  operation: 'alloc' | 'release' | 'resolve' | 'list';
  argument?: string;
  activeDir: string;
  shortIdLength: number;
  verify?: boolean;
};
type ShortIdCommandResult = {
  status: 'applied' | 'no-op' | 'failed';
  changed: boolean;
  output: string;
  error: { code: string; message: string } | null;
};

function mutateShortIdRegistryAt(
  activeDir: string,
  width: number,
  taskId: string,
  requested: ShortIdMutationEffect
): ShortIdMutationResult {
  const registryPath = path.join(activeDir, REGISTRY_NAME);
  return withRegistryLock(activeDir, () => {
    const registry = readRegistryStrict(registryPath, width);
    const original = JSON.stringify(registry.ids);
    for (const [key, candidate] of Object.entries(registry.ids)) {
      if (candidate !== taskId && !fs.existsSync(path.join(activeDir, candidate, 'task.md'))) delete registry.ids[key];
    }
    const existing = Object.entries(registry.ids).find(([, candidate]) => candidate === taskId);
    let result: ShortIdMutationResult;
    if (requested === 'alloc') {
      if (!fs.existsSync(path.join(activeDir, taskId, 'task.md'))) {
        throw Object.assign(new Error(`task ${taskId} not found in ${activeDir}`), { code: 'SHORT_ID_TASK_NOT_ACTIVE' });
      }
      if (existing) result = { effect: 'unchanged', shortId: existing[0], changed: false };
      else {
        let key: string | null = null;
        for (let value = 1; value < 10 ** width; value += 1) {
          const candidate = String(value).padStart(width, '0');
          if (!registry.ids[candidate]) { key = candidate; break; }
        }
        if (!key) throw Object.assign(new Error(`short id width exhausted (current shortIdLength=${width})`), { code: 'SHORT_ID_CAPACITY_EXCEEDED' });
        registry.ids[key] = taskId;
        result = { effect: 'allocated', shortId: key, changed: true };
      }
    } else if (requested === 'release') {
      if (!existing) result = { effect: 'unchanged', shortId: null, changed: false };
      else { delete registry.ids[existing[0]]; result = { effect: 'released', shortId: existing[0], changed: true }; }
    } else result = { effect: 'unchanged', shortId: existing ? existing[0] : null, changed: false };
    const changed = original !== JSON.stringify(registry.ids);
    if (changed) writeRegistry(registryPath, registry);
    return { ...result, changed };
  });
}

function executeShortIdCommand(request: ShortIdCommandRequest): ShortIdCommandResult {
  try {
    if (!Number.isInteger(request.shortIdLength) || request.shortIdLength < 1) {
      throw Object.assign(new Error('short-id-length must be a positive integer'), { code: 'SHORT_ID_PAYLOAD_INVALID' });
    }
    if (request.operation === 'alloc' || request.operation === 'release') {
      if (!request.argument || !/^TASK-\d{8}-\d{6}$/.test(request.argument)) {
        throw Object.assign(new Error(`${request.operation} requires a full TASK-id`), { code: 'SHORT_ID_PAYLOAD_INVALID' });
      }
      const result = mutateShortIdRegistryAt(request.activeDir, request.shortIdLength, request.argument, request.operation);
      return { status: result.changed ? 'applied' : 'no-op', changed: result.changed, output: result.shortId ?? '', error: null };
    }
    const registryPath = path.join(request.activeDir, REGISTRY_NAME);
    if (request.operation === 'resolve') {
      if (!request.argument) throw Object.assign(new Error('resolve requires a short id'), { code: 'SHORT_ID_PAYLOAD_INVALID' });
      const normalized = normalizeShortIdInput(request.argument, { shortIdLength: request.shortIdLength });
      if (normalized.kind === 'error') throw Object.assign(new Error(normalized.message), { code: normalized.code });
      if (normalized.kind !== 'shortId') {
        throw Object.assign(new Error(`invalid short id format '${request.argument}'`), { code: 'SHORT_ID_FORMAT_INVALID' });
      }
      return withRegistryLock(request.activeDir, () => {
        const registry = readRegistryStrict(registryPath, request.shortIdLength);
        let changed = false;
        for (const [key, taskId] of Object.entries(registry.ids)) {
          if (!fs.existsSync(path.join(request.activeDir, taskId, 'task.md'))) { delete registry.ids[key]; changed = true; }
        }
        if (changed) writeRegistry(registryPath, registry);
        const taskId = registry.ids[normalized.value];
        if (!taskId) throw Object.assign(new Error(`short id '${normalized.value}' not found in active task registry`), { code: 'SHORT_ID_NOT_FOUND' });
        return { status: changed ? 'applied' : 'no-op', changed, output: taskId, error: null };
      });
    }
    const registry = readRegistryStrict(registryPath, request.shortIdLength);
    if (request.verify) {
      const active = fs.existsSync(request.activeDir)
        ? fs.readdirSync(request.activeDir).filter((entry) => /^TASK-\d{8}-\d{6}$/.test(entry) && fs.existsSync(path.join(request.activeDir, entry, 'task.md')))
        : [];
      const registered = new Map<string, string[]>();
      for (const [key, taskId] of Object.entries(registry.ids)) registered.set(taskId, [...(registered.get(taskId) ?? []), key]);
      const diff = {
        missing_in_registry: active.filter((taskId) => !registered.has(taskId)).map((taskId) => ({ taskId })),
        orphans_in_registry: Object.entries(registry.ids).filter(([, taskId]) => !active.includes(taskId)).map(([key, taskId]) => ({ key, taskId })),
        duplicate_registry_keys: [...registered.entries()].filter(([, keys]) => keys.length > 1).map(([taskId, keys]) => ({ taskId, keys }))
      };
      const clean = Object.values(diff).every((items) => items.length === 0);
      return { status: clean ? 'no-op' : 'failed', changed: false, output: clean ? '' : JSON.stringify(diff), error: clean ? null : { code: 'SHORT_ID_VERIFY_FAILED', message: 'registry differs from active tasks' } };
    }
    return { status: 'no-op', changed: false, output: JSON.stringify(registry, null, 2), error: null };
  } catch (error) {
    return { status: 'failed', changed: false, output: '', error: { code: (error as { code?: string }).code ?? 'SHORT_ID_OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
}

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
    map.set(taskId, key);
  }
  return map;
}

function inspectShortIdRegistry(repoRoot: string): ShortIdRegistryInspection {
  const registryPath = path.join(repoRoot, '.agents', 'workspace', 'active', REGISTRY_NAME);
  if (!fs.existsSync(registryPath)) {
    return {
      status: 'missing',
      error: {
        code: 'SHORT_ID_REGISTRY_NOT_FOUND',
        message: 'canonical short-id registry is missing'
      }
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch {
    return {
      status: 'invalid',
      error: {
        code: 'SHORT_ID_REGISTRY_READ_FAILED',
        message: 'canonical short-id registry is unreadable'
      }
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: 'invalid',
      error: {
        code: 'SHORT_ID_REGISTRY_INVALID_JSON',
        message: 'canonical short-id registry contains invalid JSON'
      }
    };
  }

  try {
    const registry = validateRegistry(parsed, registryPath, configuredShortIdLength(repoRoot));
    const shortIds = new Map<string, string>();
    for (const [key, taskId] of Object.entries(registry.ids)) shortIds.set(taskId, key);
    return { status: 'valid', shortIds };
  } catch (error) {
    return {
      status: 'invalid',
      error: {
        code: typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'SHORT_ID_REGISTRY_INVALID_SCHEMA',
        message: (error as { code?: unknown }).code === 'SHORT_ID_REGISTRY_DUPLICATE_TASK'
          ? 'canonical short-id registry contains duplicate task entries'
          : 'canonical short-id registry has invalid schema'
      }
    };
  }
}

/**
 * Resolve a branch to its active-task short id (`NN`), or `null` when no
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
      matches.push(key);
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
  isRemovedHashShortIdInput,
  resolveShortIdReadOnly,
  lookupShortIdByBranch,
  loadShortIdByTaskId,
  inspectShortIdRegistry,
  configuredShortIdLength,
  mutateShortIdRegistry,
  executeShortIdCommand
};
export type {
  NormalizeResult,
  NormalizeOpts,
  ResolveShortIdErrorCode,
  ResolveShortIdResult,
  ShortIdMutationEffect,
  ShortIdMutationResult,
  ShortIdCommandRequest,
  ShortIdCommandResult,
  ShortIdRegistryInspection
};
