import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export type ServerLogConfig = {
  path: string;
  rotateAtBytes: number;
};

export type ServerAdapterConfig = {
  enabled: boolean;
  [key: string]: unknown;
};

export type ServerConfig = {
  repoRoot: string;
  log: ServerLogConfig;
  // Absolute path to the PID file, under ~/.agent-infra/run/<project>/server.pid.
  pidFile: string;
  heartbeatMs: number;
  adapters: Record<string, ServerAdapterConfig>;
  command?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  stream?: Record<string, unknown>;
};

export type ServerValidation =
  | { ok: true }
  | { ok: false; error: string; fields: string[] };

const ENV_PREFIX = 'AGENT_INFRA_SERVER_';

// Keys whose presence in the *committed* server.json is treated as a leaked
// secret. Secrets belong in .agents/server.local.json or the environment.
const SECRET_KEY_PATTERN = /secret|token|password|passwd|credential|apikey|api_key/i;

const DEFAULT_ROTATE_BYTES = 52_428_800; // 50 MiB

export const DEFAULT_SERVER_CONFIG: {
  log: { rotateAtBytes: number };
  heartbeatMs: number;
  adapters: Record<string, ServerAdapterConfig>;
} = {
  log: { rotateAtBytes: DEFAULT_ROTATE_BYTES },
  heartbeatMs: 30_000,
  adapters: {}
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Daemon runtime state (log + PID) lives OUTSIDE the repo, under the user's home
// directory, keyed by the .airc.json "project" AND a stable hash of the repo
// root path:
//   ~/.agent-infra/logs/<project>/<repo-hash>/server.log
//   ~/.agent-infra/run/<project>/<repo-hash>/server.pid
// The <project> segment groups a project's checkouts for readability; the
// <repo-hash> segment guarantees that two checkouts/worktrees of the same
// project (same "project" but different absolute path) get ISOLATED runtime
// dirs, so they never read/control each other's daemon. Using os.homedir() +
// path.join keeps this correct on Windows too (C:\Users\<name>\.agent-infra\...).
// An explicit log.path in server.json/.local/env still overrides the log default.
function resolveProjectKey(repoRoot: string): string {
  try {
    const airc = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')
    ) as { project?: unknown };
    if (typeof airc.project === 'string' && airc.project.trim() !== '') {
      return airc.project.trim();
    }
  } catch {
    // No .airc.json / unreadable → fall back to the repo directory name.
  }
  return path.basename(repoRoot);
}

// Short, stable, filesystem-safe discriminator for a checkout's absolute path.
function repoKey(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
}

function runtimePath(repoRoot: string, projectKey: string, kind: 'logs' | 'run', file: string): string {
  return path.join(homedir(), '.agent-infra', kind, projectKey, repoKey(repoRoot), file);
}

function detectRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    throw new Error('server: current directory is not inside a git repository');
  }
}

// Plain-object deep merge: objects recurse, everything else (arrays, scalars)
// replaces. Intentionally small — server config is shallow and this avoids
// coupling to lib/merge.ts, whose semantics target the task workspace.
function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function readJsonIfPresent(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isPlainObject(parsed)) {
    throw new Error(`server: ${path.basename(filePath)} must contain a JSON object`);
  }
  return parsed;
}

function coerceEnvValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

// Map AGENT_INFRA_SERVER_<path> env vars into a nested override object. The
// path after the prefix uses `__` to separate nesting levels and is treated
// case-sensitively (e.g. AGENT_INFRA_SERVER_adapters__dev__enabled=false ->
// { adapters: { dev: { enabled: false } } }).
function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const override: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || rawValue === undefined) continue;
    const segments = key.slice(ENV_PREFIX.length).split('__').filter(Boolean);
    if (segments.length === 0) continue;
    let cursor = override;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      const next = cursor[segment];
      if (!isPlainObject(next)) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = coerceEnvValue(rawValue);
  }
  return override;
}

// Collect dotted paths of secret-looking, non-empty string fields.
function collectSecretFields(value: unknown, trail: string[] = []): string[] {
  if (!isPlainObject(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = [...trail, key];
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child.trim() !== '') {
      found.push(here.join('.'));
    } else if (isPlainObject(child)) {
      found.push(...collectSecretFields(child, here));
    }
  }
  return found;
}

// Reject secrets that live in the committed server.json. server.local.json and
// the environment are the sanctioned places for secrets and are not scanned.
export function validateServerConfig(committed: Record<string, unknown>): ServerValidation {
  const fields = collectSecretFields(committed);
  if (fields.length > 0) {
    return {
      ok: false,
      fields,
      error:
        `server: refusing to start — secret-like field(s) found in committed .agents/server.json: ${fields.join(', ')}. ` +
        'Move them to .agents/server.local.json or AGENT_INFRA_SERVER_* environment variables.'
    };
  }
  return { ok: true };
}

export function loadServerConfig({ rootDir }: { rootDir?: string } = {}): ServerConfig {
  const repoRoot = rootDir ?? detectRepoRoot();
  const agentsDir = path.join(repoRoot, '.agents');

  const committed = readJsonIfPresent(path.join(agentsDir, 'server.json'));
  const validation = validateServerConfig(committed);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const local = readJsonIfPresent(path.join(agentsDir, 'server.local.json'));

  let merged: Record<string, unknown> = deepMerge<Record<string, unknown>>(
    { log: { rotateAtBytes: DEFAULT_ROTATE_BYTES }, heartbeatMs: DEFAULT_SERVER_CONFIG.heartbeatMs, adapters: {} },
    committed
  );
  merged = deepMerge(merged, local);
  merged = deepMerge(merged, envOverrides(process.env));

  const projectKey = resolveProjectKey(repoRoot);

  const log = isPlainObject(merged.log) ? merged.log : {};
  // No explicit log.path → default under ~/.agent-infra/logs/<project>/.
  // Explicit relative path resolves against the repo root; absolute is used as-is.
  const explicitPath = typeof log.path === 'string' ? log.path : null;
  const resolvedLogPath = explicitPath === null
    ? runtimePath(repoRoot, projectKey, 'logs', 'server.log')
    : (path.isAbsolute(explicitPath) ? explicitPath : path.join(repoRoot, explicitPath));

  return {
    repoRoot,
    pidFile: runtimePath(repoRoot, projectKey, 'run', 'server.pid'),
    log: {
      path: resolvedLogPath,
      rotateAtBytes: typeof log.rotateAtBytes === 'number' ? log.rotateAtBytes : DEFAULT_ROTATE_BYTES
    },
    heartbeatMs: typeof merged.heartbeatMs === 'number' ? merged.heartbeatMs : DEFAULT_SERVER_CONFIG.heartbeatMs,
    adapters: isPlainObject(merged.adapters) ? (merged.adapters as Record<string, ServerAdapterConfig>) : {},
    command: isPlainObject(merged.command) ? merged.command : undefined,
    auth: isPlainObject(merged.auth) ? merged.auth : undefined,
    stream: isPlainObject(merged.stream) ? merged.stream : undefined
  };
}
