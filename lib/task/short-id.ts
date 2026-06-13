import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_NAME = '.short-ids.json';

type NormalizeResult =
  | { kind: 'shortId'; value: string }
  | { kind: 'pass'; value: string }
  | { kind: 'error'; message: string };

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
      message: `short id '${input}' is invalid (#${'0'.repeat(L)} is reserved)`
    };
  }
  const max = Math.pow(10, L) - 1;
  if (n > max) {
    return {
      kind: 'error',
      message: `short id ${n} exceeds shortIdLength=${L} capacity (max=${max}); archive tasks or raise task.shortIdLength in .agents/.airc.json`
    };
  }
  return { kind: 'shortId', value: `#${String(n).padStart(L, '0')}` };
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

export { normalizeShortIdInput, lookupShortIdByBranch, loadShortIdByTaskId };
export type { NormalizeResult, NormalizeOpts };
