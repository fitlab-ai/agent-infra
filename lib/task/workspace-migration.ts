import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveProjectTaskWorkspaceLayout, resolveTaskWorkspaceLayout } from './workspace-root.ts';

type Entry = { path: string; type: 'directory' | 'file' | 'symlink'; mode: number; sha256?: string; link?: string };
type Source = { root: string; entries: Entry[]; digest: string };
type Journal = {
  version: 1;
  migrationId: string;
  sources: Source[];
  entries: Entry[];
  manifestDigest: string;
  committed: boolean;
  deleting: string | null;
  cleaned: string[];
};
type MigrationStep = 'manifest-frozen' | 'staging-entry-copied' | 'staging-verified' | 'destination-committed'
  | 'source-item-removing' | 'source-item-deleted-before-journal' | 'source-item-removed';
type MigrationOptions = {
  discoverSources?: () => string[];
  onStep?: (step: MigrationStep, path?: string) => void;
};

const TASK_STATES = ['active', 'blocked', 'completed', 'archive'] as const;

export function splitDestinationPath(destination: string, pathApi: typeof path = path): { resolved: string; root: string; segments: string[] } {
  const resolved = pathApi.resolve(destination);
  const root = pathApi.parse(resolved).root;
  const segments = pathApi.relative(root, resolved).split(pathApi.sep).filter(Boolean);
  return { resolved, root, segments };
}

function fsyncDirectory(directoryPath: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directoryPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function discoverTaskWorkspaceSources(repoRoot: string): string[] {
  const layout = resolveProjectTaskWorkspaceLayout(repoRoot, 'host');
  const project = layout.projectKey;
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  const roots = worktrees.split(/\n\n/u).filter(Boolean).map((record) => {
    const worktree = record.match(/^worktree (.+)$/mu)?.[1];
    if (!worktree) throw new Error('git returned an invalid worktree record');
    const configPath = path.join(worktree, '.agents', '.airc.json');
    let candidate: { project?: unknown };
    try { candidate = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof candidate; }
    catch (error) { throw new Error(`cannot identify project for registered worktree ${worktree}: ${String(error)}`); }
    if (candidate.project !== project) return null;
    const workspace = path.join(worktree, '.agents', 'workspace');
    const stat = fs.lstatSync(workspace, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe legacy workspace root: ${workspace}`);
    return fs.realpathSync.native(workspace);
  }).filter((value): value is string => value !== null);
  return [...new Set(roots)].sort();
}

export function migrateProjectTaskWorkspace(repoRoot: string, migrationId: string): ReturnType<typeof migrateTaskWorkspace> {
  const layout = resolveProjectTaskWorkspaceLayout(repoRoot, 'host');
  return migrateTaskWorkspace({ sources: discoverTaskWorkspaceSources(repoRoot), destination: layout.root, migrationId }, {
    discoverSources: () => discoverTaskWorkspaceSources(repoRoot)
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scanTree(root: string, entries: Entry[], relative: string): void {
  const full = path.join(root, ...relative.split('/'));
  const stat = fs.lstatSync(full);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    entries.push({ path: relative, type: 'symlink', mode, link: fs.readlinkSync(full) });
  } else if (stat.isDirectory()) {
    entries.push({ path: relative, type: 'directory', mode });
    for (const name of fs.readdirSync(full).sort()) scanTree(root, entries, `${relative}/${name}`);
  } else if (stat.isFile()) {
    entries.push({ path: relative, type: 'file', mode, sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
  } else {
    throw new Error(`unsupported filesystem object: ${full}`);
  }
}

/** Scan only the four task-state trees and active short-id registry. */
function scanSource(root: string): Entry[] {
  const entries: Entry[] = [];
  for (const state of TASK_STATES) {
    const statePath = path.join(root, state);
    if (fs.existsSync(statePath)) scanTree(root, entries, state);
    else if (fs.lstatSync(statePath, { throwIfNoEntry: false })) scanTree(root, entries, state);
  }
  const activePath = path.join(root, 'active');
  const activeStat = fs.lstatSync(activePath, { throwIfNoEntry: false });
  const shortIds = path.join(activePath, '.short-ids.json');
  if (activeStat?.isDirectory() && fs.lstatSync(shortIds, { throwIfNoEntry: false })) {
    if (!entries.some((entry) => entry.path === 'active/.short-ids.json')) scanTree(root, entries, 'active/.short-ids.json');
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function assertSafePath(value: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/u).some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error(`unsafe manifest path: ${value}`);
  }
  const first = value.split('/')[0];
  if (!TASK_STATES.includes(first as typeof TASK_STATES[number])) throw new Error(`manifest path is outside task state trees: ${value}`);
}

function ensureRealDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`migration path must be a real directory: ${directory}`);
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
}

function assertSafeDestination(destination: string): void {
  const { resolved, root, segments: parts } = splitDestinationPath(destination);
  const managedIndex = parts.indexOf('.agent-infra');
  let anchor = managedIndex >= 0
    ? path.join(root, ...parts.slice(0, managedIndex))
    : path.dirname(resolved);
  if (!anchor) anchor = root;
  while (!fs.existsSync(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) throw new Error(`migration destination parent is unavailable: ${anchor}`);
    anchor = parent;
  }
  let current = fs.realpathSync.native(anchor);
  const start = managedIndex >= 0 ? managedIndex : parts.length - 1;
  for (const part of parts.slice(start)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`migration destination path contains a symlink or non-directory: ${current}`);
    }
    if (fs.realpathSync.native(current) !== current) {
      throw new Error(`migration destination path is not canonical: ${current}`);
    }
  }
}

function ensureDestinationParent(destination: string): void {
  assertSafeDestination(destination);
  const missing: string[] = [];
  let current = path.dirname(destination);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`migration destination parent is unavailable: ${current}`);
    current = parent;
  }
  for (const directory of [current, ...missing.reverse()]) ensureRealDirectory(directory);
}

function validateCurrentSource(source: Source, current: Entry[]): void {
  const frozen = new Map(source.entries.map((entry) => [entry.path, entry]));
  if (current.some((entry) => !frozen.has(entry.path) || !equalEntry(entry, frozen.get(entry.path)!))) {
    throw new Error(`migration source changed after destination commit: ${source.root}`);
  }
}

function copyEntry(source: string, target: string, entry: Entry): void {
  assertSafePath(entry.path);
  const from = path.join(source, ...entry.path.split('/'));
  const to = path.join(target, ...entry.path.split('/'));
  if (entry.type === 'directory') {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  } else if (entry.type === 'symlink') {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(entry.link!, to);
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

function applyEntryModes(root: string, entries: Entry[]): void {
  for (const entry of entries.filter((item) => item.type === 'file')) {
    fs.chmodSync(path.join(root, ...entry.path.split('/')), entry.mode);
  }
  for (const entry of entries.filter((item) => item.type === 'directory').sort((a, b) => b.path.length - a.path.length)) {
    fs.chmodSync(path.join(root, ...entry.path.split('/')), entry.mode);
  }
}

function equalEntry(a: Entry, b: Entry): boolean {
  return a.type === b.type && a.mode === b.mode && a.sha256 === b.sha256 && a.link === b.link;
}

function writeJournal(filePath: string, journal: Journal): void {
  const temporary = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(journal));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function isJournal(value: unknown): value is Journal {
  if (!value || typeof value !== 'object') return false;
  const journal = value as Partial<Journal>;
  if (journal.version !== 1 || typeof journal.migrationId !== 'string' || !Array.isArray(journal.sources)
    || !Array.isArray(journal.entries) || typeof journal.manifestDigest !== 'string'
    || typeof journal.committed !== 'boolean' || !Array.isArray(journal.cleaned)
    || (journal.deleting !== null && typeof journal.deleting !== 'string')) {
    return false;
  }
  return true;
}

function validateJournalEntries(entries: Entry[]): void {
  for (const entry of entries) assertSafePath(entry.path);
}

function validateJournalSources(sources: Source[]): void {
  for (const source of sources) {
    if (typeof source.root !== 'string' || !path.isAbsolute(source.root) || !Array.isArray(source.entries)) {
      throw new Error('migration journal source identity is invalid');
    }
    validateJournalEntries(source.entries);
  }
}

function readJournal(filePath: string): Journal {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!isJournal(value)) throw new Error('migration journal has an invalid schema');
  const journal = value;
  validateJournalEntries(journal.entries);
  validateJournalSources(journal.sources);
  const actualDigest = digest({ migrationId: journal.migrationId, sources: journal.sources, entries: journal.entries });
  if (actualDigest !== journal.manifestDigest) throw new Error('migration journal manifest digest is invalid');
  return journal;
}

function lockMigration(lockPath: string, migrationId: string): number {
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ migrationId, pid: process.pid }));
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    if (!fs.existsSync(lockPath)) throw error;
    let prior: { migrationId?: string; pid?: number };
    try { prior = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as typeof prior; }
    catch { throw new Error('migration lock identity is invalid; inspect before recovery'); }
    if (prior.migrationId !== migrationId || !Number.isSafeInteger(prior.pid)) throw new Error('migration lock belongs to another or unknown operation');
    try {
      process.kill(prior.pid!, 0);
      throw new Error('migration is already running');
    } catch (probe) {
      if (probe instanceof Error && probe.message === 'migration is already running') throw probe;
      if (!probe || typeof probe !== 'object' || !('code' in probe) || probe.code !== 'ESRCH') throw new Error('migration lock owner cannot be verified');
    }
    fs.rmSync(lockPath);
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ migrationId, pid: process.pid }));
    fs.fsyncSync(fd);
    return fd;
  }
}

function sourceManifest(root: string): Source {
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe migration source root: ${root}`);
  }
  const entries = fs.existsSync(root) ? scanSource(root) : [];
  return { root, entries, digest: digest(entries) };
}

function validateSourceSet(actual: Source[], frozen: Source[], committed: boolean, destination: string): void {
  if (actual.length !== frozen.length || actual.some((source, index) => source.root !== frozen[index]?.root)) {
    throw new Error('migration source set changed');
  }
  assertSafeDestination(destination);
  const target = new Map(scanSource(destination).map((entry) => [entry.path, entry]));
  for (let index = 0; index < frozen.length; index += 1) {
    const current = actual[index]!.entries;
    const original = new Map(frozen[index]!.entries.map((entry) => [entry.path, entry]));
    if (!committed && (current.length !== original.size || current.some((entry) => !original.has(entry.path) || !equalEntry(entry, original.get(entry.path)!)))) {
      throw new Error(`migration source changed before destination commit: ${frozen[index]!.root}`);
    }
    if (committed && current.some((entry) => !original.has(entry.path) || !equalEntry(entry, original.get(entry.path)!))) {
      throw new Error(`migration source changed after destination commit: ${frozen[index]!.root}`);
    }
    if (committed) for (const entry of current) {
      const targetEntry = target.get(entry.path);
      if (!targetEntry || !equalEntry(entry, targetEntry)) throw new Error(`migration target no longer proves source item ${entry.path}`);
    }
  }
}

function removeEntry(sourceRoot: string, entry: Entry): void {
  const sourcePath = path.join(sourceRoot, ...entry.path.split('/'));
  const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stat) return;
  if (entry.type === 'directory') fs.rmdirSync(sourcePath);
  else fs.unlinkSync(sourcePath);
  fsyncDirectory(path.dirname(sourcePath));
}

function verifiedDestinationEntries(destination: string, expected: Entry[]): Map<string, Entry> {
  assertSafeDestination(destination);
  const entries = scanSource(destination);
  if (digest(entries) !== digest(expected)) throw new Error('migration destination differs from frozen manifest');
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function verifyDestinationEntry(destination: string, expected: Entry[], entry: Entry): Map<string, Entry> {
  const target = verifiedDestinationEntries(destination, expected);
  if (!equalEntry(target.get(entry.path)!, entry)) throw new Error(`migration target no longer proves source item ${entry.path}`);
  return target;
}

function clearSources(
  journalPath: string,
  journal: Journal,
  destination: string,
  onStep?: (step: 'source-item-removing' | 'source-item-deleted-before-journal' | 'source-item-removed', path: string) => void
): void {
  let target = verifiedDestinationEntries(destination, journal.entries);
  for (const source of journal.sources) {
    for (const entry of [...source.entries].reverse()) {
      const current = scanSource(source.root);
      validateCurrentSource(source, current);
      const present = current.find((item) => item.path === entry.path);
      if (!present) {
        if (!target.has(entry.path) || !equalEntry(target.get(entry.path)!, entry)) throw new Error(`migration target does not prove previously removed source item ${entry.path}`);
        if (journal.deleting === entry.path) {
          journal.cleaned = [...new Set([...journal.cleaned, entry.path])].sort();
          journal.deleting = null;
          writeJournal(journalPath, journal);
        }
        continue;
      }
      if (!equalEntry(present, entry) || !equalEntry(target.get(entry.path)!, entry)) throw new Error(`migration source or target changed at ${entry.path}`);
      journal.deleting = entry.path;
      writeJournal(journalPath, journal);
      onStep?.('source-item-removing', entry.path);
      target = verifyDestinationEntry(destination, journal.entries, entry);
      removeEntry(source.root, entry);
      onStep?.('source-item-deleted-before-journal', entry.path);
      journal.cleaned = [...new Set([...journal.cleaned, entry.path])].sort();
      journal.deleting = null;
      writeJournal(journalPath, journal);
      onStep?.('source-item-removed', entry.path);
    }
    if (scanSource(source.root).length) throw new Error(`migration source was not fully cleared: ${source.root}`);
  }
  verifiedDestinationEntries(destination, journal.entries);
  for (const source of journal.sources) {
    if (scanSource(source.root).length) throw new Error(`migration source was not fully cleared: ${source.root}`);
  }
}

function migrationSources(input: { sources: string[] }, options: MigrationOptions): string[] {
  const sources = [...new Set(input.sources.map((source) => path.resolve(source)))].sort();
  if (!options.discoverSources) return sources;
  const discovered = [...new Set(options.discoverSources().map((source) => path.resolve(source)))].sort();
  if (digest(discovered) !== digest(sources)) throw new Error('migration source set changed after it was frozen');
  return sources;
}

function assertDiscoveredSourcesStable(sources: string[], options: MigrationOptions): void {
  migrationSources({ sources }, options);
}

function mergeManifests(manifests: Source[]): Entry[] {
  const union = new Map<string, Entry>();
  for (const source of manifests) for (const entry of source.entries) {
    assertSafePath(entry.path);
    const prior = union.get(entry.path);
    if (prior && !equalEntry(prior, entry)) throw new Error(`migration conflict at ${entry.path}`);
    union.set(entry.path, entry);
  }
  return [...union.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function stageEntries(
  destination: string,
  migrationId: string,
  sources: Source[],
  entries: Entry[],
  onStep: MigrationOptions['onStep'],
  mismatch: string
): string {
  const staging = `${destination}.staging.${migrationId}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const source = sources.find((candidate) => candidate.entries.some((item) => item.path === entry.path && equalEntry(item, entry)));
    if (!source) throw new Error(`frozen source manifest is incomplete at ${entry.path}`);
    copyEntry(source.root, staging, entry);
    onStep?.('staging-entry-copied', entry.path);
  }
  applyEntryModes(staging, entries);
  if (digest(scanSource(staging)) !== digest(entries)) throw new Error(mismatch);
  onStep?.('staging-verified');
  return staging;
}

function commitStaging(staging: string, destination: string): void {
  assertSafeDestination(destination);
  if (fs.existsSync(destination)) fs.rmdirSync(destination);
  fs.renameSync(staging, destination);
  fsyncDirectory(path.dirname(destination));
}

function result(status: 'migrated' | 'already-migrated', entries: Entry[], manifestDigest: string) {
  return { status, entries: entries.length, digest: manifestDigest };
}

function validateJournalIdentity(journal: Journal, sources: string[], migrationId: string): void {
  if (journal.migrationId !== migrationId || digest(journal.sources.map(({ root }) => root)) !== digest(sources)) {
    throw new Error('migration journal identity or source set changed');
  }
}

function destinationMatches(destination: string, entries: Entry[]): boolean {
  assertSafeDestination(destination);
  return fs.existsSync(destination) && digest(scanSource(destination)) === digest(entries);
}

function restoreJournalDestination(
  journal: Journal,
  destination: string,
  migrationId: string,
  options: MigrationOptions,
  sources: string[]
): void {
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('migration destination is not empty');
  const staging = stageEntries(destination, migrationId, journal.sources, journal.entries, options.onStep, 'recovered staging differs from frozen manifest');
  assertDiscoveredSourcesStable(sources, options);
  validateSourceSet(journal.sources.map((source) => sourceManifest(source.root)), journal.sources, false, destination);
  commitStaging(staging, destination);
}

function resumeMigration(
  journal: Journal,
  destination: string,
  migrationId: string,
  journalPath: string,
  sources: string[],
  options: MigrationOptions
) {
  assertSafeDestination(destination);
  validateJournalIdentity(journal, sources, migrationId);
  const actual = journal.sources.map((source) => sourceManifest(source.root));
  const hasCommittedDestination = destinationMatches(destination, journal.entries);
  if (journal.committed && !hasCommittedDestination) throw new Error('committed migration destination is missing or changed');
  if (!journal.committed && !hasCommittedDestination) validateSourceSet(actual, journal.sources, false, destination);
  if (!hasCommittedDestination) restoreJournalDestination(journal, destination, migrationId, options, sources);
  journal.committed = true;
  writeJournal(journalPath, journal);
  validateSourceSet(journal.sources.map((source) => sourceManifest(source.root)), journal.sources, true, destination);
  clearSources(journalPath, journal, destination, options.onStep);
  return result('already-migrated', journal.entries, journal.manifestDigest);
}

function createMigration(
  sources: string[],
  destination: string,
  migrationId: string,
  journalPath: string,
  options: MigrationOptions
) {
  ensureDestinationParent(destination);
  const manifests = sources.map(sourceManifest);
  const entries = mergeManifests(manifests);
  const manifestDigest = digest({ migrationId, sources: manifests, entries });
  const journal: Journal = { version: 1, migrationId, sources: manifests, entries, manifestDigest, committed: false, deleting: null, cleaned: [] };
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('migration destination is not empty');
  writeJournal(journalPath, journal);
  options.onStep?.('manifest-frozen');
  const staging = stageEntries(destination, migrationId, manifests, entries, options.onStep, 'staging does not match frozen destination manifest');
  assertDiscoveredSourcesStable(sources, options);
  validateSourceSet(manifests.map((source) => sourceManifest(source.root)), manifests, false, destination);
  commitStaging(staging, destination);
  if (digest(scanSource(destination)) !== digest(entries)) throw new Error('committed destination differs from frozen manifest');
  journal.committed = true;
  writeJournal(journalPath, journal);
  options.onStep?.('destination-committed');
  clearSources(journalPath, journal, destination, options.onStep);
  options.onStep?.('source-item-removed');
  return result('migrated', entries, manifestDigest);
}

/** Migrate a frozen set of legacy workspace roots into one isolated destination. */
export function migrateTaskWorkspace(
  input: { sources: string[]; destination: string; migrationId: string },
  options: MigrationOptions = {}
): { status: 'migrated' | 'already-migrated'; entries: number; digest: string } {
  const sources = [...new Set(input.sources.map((source) => path.resolve(source)))].sort();
  const destination = path.resolve(input.destination);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.migrationId)
    || sources.some((source) => source === destination
      || destination.startsWith(`${source}${path.sep}`) || source.startsWith(`${destination}${path.sep}`))) {
    throw new Error('source set is unsafe or overlaps destination');
  }
  assertDiscoveredSourcesStable(sources, options);
  ensureDestinationParent(destination);
  const lockPath = `${destination}.migration.lock`;
  const journalPath = `${destination}.migration.json`;
  const lock = lockMigration(lockPath, input.migrationId);
  try {
    if (fs.existsSync(journalPath)) {
      return resumeMigration(readJournal(journalPath), destination, input.migrationId, journalPath, sources, options);
    }
    return createMigration(sources, destination, input.migrationId, journalPath, options);
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}
