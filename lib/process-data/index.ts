import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { detectRepoRoot } from '../task/resolve-ref.ts';
import { normalizeObjects } from './normalize.ts';
import { reconcileRecords } from './reconcile.ts';
import { readAppliedOverlays, repairSnapshot } from './repair.ts';
import { collectGitHubObjects, collectLocalObjects } from './sources.ts';
import { canonicalJsonBytes, createObjectStore, publishSnapshot, verifySnapshot } from './store.ts';

import type { CapturedObject, NormalizedRecord, RestCollectionEvidence } from './types.ts';

const USAGE = `Usage: ai data <command> [options]

Commands:
  capture [--source all|local|github] [--root <dir>] [--include-excerpts]
  verify <snapshot-id> [--root <dir>]
  audit <snapshot-id> [--root <dir>] [--format json|text]
  repair <snapshot-id> [--root <dir>] [--apply]
  export <snapshot-id> [--root <dir>] [--repairs none|applied] [--output <file|->]
`;

type ParsedArgs = { positionals: string[]; options: Map<string, string | true> };

function parseArgs(args: string[], valueOptions: Set<string>, booleanOptions: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (booleanOptions.has(arg)) {
      if (options.has(arg)) throw new Error(`duplicate option: ${arg}`);
      options.set(arg, true);
      continue;
    }
    if (!valueOptions.has(arg)) throw new Error(`unknown option: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    if (options.has(arg)) throw new Error(`duplicate option: ${arg}`);
    options.set(arg, value);
    index += 1;
  }
  return { positionals, options };
}

function dataRoot(repoRoot: string, requested?: string): string {
  const workspace = path.resolve(repoRoot, '.agents', 'workspace');
  const resolved = path.resolve(repoRoot, requested ?? path.join('.agents', 'workspace', 'process-data'));
  const relative = path.relative(repoRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('data root must be inside the repository');
  const taskRoots = ['active', 'blocked', 'completed', 'archive'].map((state) => path.join(workspace, state));
  if (resolved === workspace || taskRoots.some((taskRoot) => resolved === taskRoot || resolved.startsWith(`${taskRoot}${path.sep}`))) {
    throw new Error('data root cannot be the workspace root or a task directory');
  }
  let current = resolved;
  while (current !== repoRoot) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('data root cannot traverse a symlink');
    current = path.dirname(current);
  }
  return resolved;
}

function repositoryIdentity(repoRoot: string): string {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoRoot, encoding: 'utf8' }).trim() || path.basename(repoRoot);
  } catch {
    return path.basename(repoRoot);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function optionString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function capture(args: string[]): number {
  const parsed = parseArgs(args, new Set(['--source', '--root']), new Set(['--include-excerpts']));
  if (parsed.positionals.length > 0) throw new Error('capture does not accept positional arguments');
  const scope = optionString(parsed, '--source') ?? 'all';
  if (!['all', 'local', 'github'].includes(scope)) throw new Error('--source must be all, local, or github');
  const repoRoot = detectRepoRoot();
  const root = dataRoot(repoRoot, optionString(parsed, '--root'));
  const observedFrom = new Date().toISOString();
  const objects: CapturedObject[] = [];
  const endpoints: RestCollectionEvidence[] = [];
  let repository = repositoryIdentity(repoRoot);

  if (scope === 'all' || scope === 'local') {
    const local = collectLocalObjects(repoRoot, { includeExcerpts: parsed.options.has('--include-excerpts') });
    if (!local.ok) { writeJson({ ok: false, error: local.error }); return 2; }
    objects.push(...local.value);
  }
  if (scope === 'all' || scope === 'github') {
    const github = collectGitHubObjects(repoRoot);
    if (!github.ok) { writeJson({ ok: false, error: github.error }); return 2; }
    objects.push(...github.value.objects);
    endpoints.push(...github.value.endpoints);
    repository = github.value.repository;
  }

  const store = createObjectStore(root);
  for (const object of objects) {
    if (object.content !== undefined && object.disposition?.state === 'included') {
      const stored = store.put(Buffer.from(object.content, 'utf8'));
      if (stored.sha256 !== object.sha256) throw new Error(`source hash mismatch: ${object.sourceIdentity}`);
    }
  }
  const records = normalizeObjects(objects);
  const reconciliation = reconcileRecords(records, scope as 'all' | 'local' | 'github');
  const observedTo = new Date().toISOString();
  const published = publishSnapshot(root, {
    scope: scope as 'all' | 'local' | 'github',
    repository,
    observedFrom,
    observedTo,
    objects: objects.map(({ content: _content, ...object }) => object),
    endpoints,
    excerptsEnabled: parsed.options.has('--include-excerpts'),
    records,
    quality: reconciliation.findings,
    repairs: reconciliation.repairs
  });
  writeJson({ ok: true, snapshotId: published.snapshotId, scope, created: published.created, objects: objects.length, records: records.length });
  return 0;
}

function verify(args: string[]): number {
  const parsed = parseArgs(args, new Set(['--root']), new Set());
  if (parsed.positionals.length !== 1) throw new Error('verify requires one snapshot id');
  const repoRoot = detectRepoRoot();
  const result = verifySnapshot(dataRoot(repoRoot, optionString(parsed, '--root')), parsed.positionals[0]!);
  writeJson(result);
  return result.ok ? 0 : 1;
}

function audit(args: string[]): number {
  const parsed = parseArgs(args, new Set(['--root', '--format']), new Set());
  if (parsed.positionals.length !== 1) throw new Error('audit requires one snapshot id');
  const format = optionString(parsed, '--format') ?? 'text';
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text');
  const repoRoot = detectRepoRoot();
  const root = dataRoot(repoRoot, optionString(parsed, '--root'));
  const verified = verifySnapshot(root, parsed.positionals[0]!);
  if (!verified.ok || !verified.snapshotPath || !verified.manifest) { writeJson(verified); return 1; }
  const quality = JSON.parse(fs.readFileSync(path.join(verified.snapshotPath, 'quality.json'), 'utf8')) as { findings: unknown[] };
  const records = fs.readFileSync(path.join(verified.snapshotPath, 'normalized.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => {
    const { schema: _schema, ...record } = JSON.parse(line) as { schema: string } & NormalizedRecord;
    return record;
  });
  const recomputed = reconcileRecords(records, verified.manifest.scope);
  if (!canonicalJsonBytes(recomputed.findings).equals(canonicalJsonBytes(quality.findings))) {
    writeJson({ ok: false, error: { code: 'QUALITY_MISMATCH', message: 'stored quality baseline does not match recomputed findings' } });
    return 1;
  }
  if (format === 'json') writeJson({ ok: true, snapshotId: parsed.positionals[0], findings: recomputed.findings });
  else process.stdout.write(`Snapshot ${parsed.positionals[0]}: ${quality.findings.length} findings\n`);
  return 0;
}

function repair(args: string[]): number {
  const parsed = parseArgs(args, new Set(['--root']), new Set(['--apply']));
  if (parsed.positionals.length !== 1) throw new Error('repair requires one snapshot id');
  const repoRoot = detectRepoRoot();
  const result = repairSnapshot(dataRoot(repoRoot, optionString(parsed, '--root')), parsed.positionals[0]!, parsed.options.has('--apply'));
  writeJson({ ok: true, ...result });
  return 0;
}

function exportSnapshot(args: string[]): number {
  const parsed = parseArgs(args, new Set(['--root', '--repairs', '--output']), new Set());
  if (parsed.positionals.length !== 1) throw new Error('export requires one snapshot id');
  const repairMode = optionString(parsed, '--repairs') ?? 'none';
  if (!['none', 'applied'].includes(repairMode)) throw new Error('--repairs must be none or applied');
  const output = optionString(parsed, '--output') ?? '-';
  const repoRoot = detectRepoRoot();
  const root = dataRoot(repoRoot, optionString(parsed, '--root'));
  const verified = verifySnapshot(root, parsed.positionals[0]!);
  if (!verified.ok || !verified.snapshotPath) { writeJson(verified); return 1; }
  let content = fs.readFileSync(path.join(verified.snapshotPath, 'normalized.jsonl'), 'utf8');
  if (repairMode === 'applied') content += readAppliedOverlays(root, parsed.positionals[0]!);
  if (output === '-') process.stdout.write(content);
  else {
    const destination = path.resolve(repoRoot, output);
    const relative = path.relative(repoRoot, destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('export output must be inside the repository');
    fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
    writeJson({ ok: true, snapshotId: parsed.positionals[0], output: relative });
  }
  return 0;
}

async function cmdData(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  try {
    switch (command) {
      case 'capture': return capture(rest);
      case 'verify': return verify(rest);
      case 'audit': return audit(rest);
      case 'repair': return repair(rest);
      case 'export': return exportSnapshot(rest);
      default:
        process.stderr.write(`Unknown data command: ${command}\n`);
        process.stdout.write(USAGE);
        return 1;
    }
  } catch (error) {
    writeJson({ ok: false, error: { code: 'DATA_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error) } });
    return 1;
  }
}

export { cmdData, dataRoot };
