import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { writeDurableFile } from '../fs/durable-write.ts';
import {
  decodePrDeliveryFact,
  encodePrDeliveryFact
} from './pr-delivery-fact.ts';
import type { PrDeliveryFact } from './pr-delivery-fact.ts';
import {
  parseResourceIdentity,
  resourceIdentityEquals,
  serializeResourceIdentity
} from '../platform/resource-identity.ts';
import type { ResourceIdentity } from '../platform/resource-identity.ts';
import { parseTypedTaskFrontmatter, updateTaskFrontmatter } from './frontmatter.ts';
import { transitionBuildAttestation, withTransitionMigrationLock } from './task-execution-lock.ts';
import type { TransitionBuildAttestation } from './task-execution-lock.ts';
import type { PlatformCapabilities } from '../platform/provider-contract.ts';
import type { ProviderIdentityDeclaration } from '../platform/resource-identity.ts';
import { primaryIdentityKind } from '../platform/resource-identity.ts';

const ACTIVE_TASK_ID = /^TASK-\d{8}-\d{6}$/u;
const MANIFEST_NAME = 'pr-delivery-fact-v1-to-v2.json';

type MigrationProvider = Readonly<{
  name: string;
  identity: Pick<ProviderIdentityDeclaration, 'issue' | 'pull-request'>;
  capabilities: Pick<PlatformCapabilities, 'authenticated' | 'triage' | 'push' | 'admin'>;
  verifyIssueIdentity: (input: Readonly<{ taskId: string; identity: ResourceIdentity; fact: PrDeliveryFact | null }>) => boolean | Promise<boolean>;
  verifyPullRequestFact: (input: Readonly<{ taskId: string; fact: PrDeliveryFact }>) => boolean | Promise<boolean>;
}>;

type MigrationAuthority = Readonly<{
  mode: 'direct-host' | 'task-bound' | 'partial';
  repositoryRoot: string;
  repository: string;
  provider: string;
  authenticated: boolean;
  transitionBuild: TransitionBuildAttestation;
}>;

type ActiveTaskMigrationOptions = Readonly<{
  authority: MigrationAuthority;
  repository: string;
  provider: MigrationProvider;
  manifestPath?: string;
  lockRoot?: string;
  ownerName?: string;
  now?: () => string;
}>;

type MigrationItem = {
  taskId: string;
  taskPath: string;
  beforeDigest: string;
  targetDigest: string;
  postDigest: string | null;
  beforeContent: string;
};

type MigrationManifest = {
  version: 1;
  status: 'prepared' | 'completed' | 'failed';
  authority: 'direct-host';
  repository: string;
  provider: string;
  root: string;
  scope: 'active';
  inventoryDigest: string;
  transitionBuild: TransitionBuildAttestation;
  startedAt: string;
  updatedAt: string;
  items: MigrationItem[];
  error?: { code: string; message: string };
};

type ActiveTaskMigrationResult = Readonly<{
  status: 'completed' | 'no-op';
  changed: number;
  inventoryDigest: string;
  manifestPath: string;
}>;

class ActiveTaskMigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ActiveTaskMigrationError';
    this.code = code;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function migrationTimestamp(now: () => string): string {
  const value = now();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ActiveTaskMigrationError('MIGRATION_TIMESTAMP_INVALID', 'migration clock returned an invalid timestamp');
  }
  return new Date(value).toISOString();
}

function positiveNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_INVALID', `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', `${label} must be a non-empty trimmed string`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', `${label} has an invalid field set`);
  }
}

function isoTimestamp(value: unknown, label: string): string {
  const stringValue = text(value, label);
  if (Number.isNaN(Date.parse(stringValue))) {
    throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', `${label} must be a valid timestamp`);
  }
  return new Date(stringValue).toISOString();
}

function ref(value: unknown, label: string): { repository: string; ref: string; sha: string } {
  const object = record(value, label);
  exactKeys(object, ['repository', 'ref', 'sha'], label);
  return {
    repository: text(object.repository, `${label}.repository`),
    ref: text(object.ref, `${label}.ref`),
    sha: text(object.sha, `${label}.sha`)
  };
}

function migrateLegacyFact(value: unknown): PrDeliveryFact {
  // TODO(compat): Remove this transition reader/fallback and migration-only parser once the active migration manifest is completed and the current-only build is deployed.
  const legacy = record(value, 'v1 PR delivery fact');
  if (legacy.version !== 1) {
    return decodePrDeliveryFact(value);
  }
  const state = text(legacy.state, 'fact.state');
  if (state === 'unbound') {
    exactKeys(legacy, ['version', 'state', 'reason'], 'v1 unbound fact');
    if (legacy.reason !== 'initial') throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', 'v1 unbound reason is invalid');
    return decodePrDeliveryFact({ version: 2, state: 'unbound', reason: 'initial' });
  }
  if (state === 'skipped') {
    exactKeys(legacy, ['version', 'state', 'reason', 'decidedAt'], 'v1 skipped fact');
    if (legacy.reason !== 'explicit') throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', 'v1 skipped reason is invalid');
    return decodePrDeliveryFact({ version: 2, state: 'skipped', reason: 'explicit', decidedAt: isoTimestamp(legacy.decidedAt, 'fact.decidedAt') });
  }
  if (state !== 'bound') throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', 'v1 fact state is invalid');
  exactKeys(legacy, ['version', 'state', 'identity', 'binding', 'provenance'], 'v1 bound fact');
  const identity = record(legacy.identity, 'v1 identity');
  exactKeys(identity, ['repository', 'number', 'nodeId', 'url', 'head', 'base'], 'v1 identity');
  const binding = record(legacy.binding, 'v1 binding');
  exactKeys(binding, ['status', 'source', 'verifiedAt', 'issueNumber', 'remoteState', 'mergedAt', 'mergeCommitSha'], 'v1 binding');
  const provenance = record(legacy.provenance, 'v1 provenance');
  exactKeys(provenance, ['establishedBy'], 'v1 provenance');
  const issueNumber = binding.issueNumber === null ? null : positiveNumber(binding.issueNumber, 'v1 binding.issueNumber');
  const mergedAt = binding.mergedAt === null ? null : isoTimestamp(binding.mergedAt, 'v1 binding.mergedAt');
  const mergeCommitSha = binding.mergeCommitSha === null ? null : text(binding.mergeCommitSha, 'v1 binding.mergeCommitSha');
  if (Boolean(mergedAt) !== Boolean(mergeCommitSha)) {
    throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', 'v1 mergedAt and mergeCommitSha must be paired');
  }
  return decodePrDeliveryFact({
    version: 2,
    state: 'bound',
    identity: {
      resource: { kind: 'number', value: positiveNumber(identity.number, 'v1 identity.number') },
      repository: text(identity.repository, 'v1 identity.repository'),
      url: text(identity.url, 'v1 identity.url'),
      head: ref(identity.head, 'v1 identity.head'),
      base: ref(identity.base, 'v1 identity.base')
    },
    binding: {
      status: binding.status,
      source: binding.source,
      verifiedAt: isoTimestamp(binding.verifiedAt, 'v1 binding.verifiedAt'),
      issueIdentity: issueNumber === null ? null : { kind: 'number', value: issueNumber },
      remoteState: binding.remoteState,
      mergedAt,
      mergeCommitSha
    },
    provenance
  });
}

function parseFactValue(value: unknown): PrDeliveryFact | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', 'pr_delivery_fact must contain a JSON string');
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new ActiveTaskMigrationError('MIGRATION_FACT_INVALID', 'pr_delivery_fact is not valid JSON'); }
  return migrateLegacyFact(parsed);
}

function parseOptionalIssueIdentity(value: unknown): ResourceIdentity | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_INVALID', 'platform_issue_identity must contain a JSON string');
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_INVALID', 'platform_issue_identity is not valid JSON'); }
  return parseResourceIdentity(parsed, 'platform_issue_identity');
}

function oldIssueNumber(value: unknown): number | null {
  if (value === undefined || value === '') return null;
  if (typeof value === 'number') return positiveNumber(value, 'issue_number');
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) return positiveNumber(Number(value), 'issue_number');
  throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_INVALID', 'issue_number must be a positive integer');
}

async function issueIdentityFor(
  taskId: string,
  metadata: Record<string, string | number | boolean | null>,
  fact: PrDeliveryFact | null,
  provider: MigrationProvider
): Promise<ResourceIdentity | null> {
  const current = parseOptionalIssueIdentity(metadata.platform_issue_identity);
  const old = oldIssueNumber(metadata.issue_number);
  const fromFact = fact?.state === 'bound' ? fact.binding.issueIdentity : null;
  if (current && old !== null && (current.kind !== 'number' || current.value !== old)) {
    throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_CONFLICT', `task ${taskId} has conflicting Issue identities`);
  }
  if (old !== null && fromFact && (fromFact.kind !== 'number' || fromFact.value !== old)) {
    throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_CONFLICT', `task ${taskId} has conflicting Issue identities`);
  }
  if (current && fromFact && !resourceIdentityEquals(current, fromFact)) {
    throw new ActiveTaskMigrationError('MIGRATION_IDENTITY_CONFLICT', `task ${taskId} has conflicting PR and Issue identities`);
  }
  const result = current ?? (old === null ? fromFact : { kind: 'number', value: old });
  if (result && !(await provider.verifyIssueIdentity({ taskId, identity: result, fact }))) {
    throw new ActiveTaskMigrationError('MIGRATION_PROVIDER_IDENTITY_REJECTED', `provider rejected Issue identity for ${taskId}`);
  }
  return result;
}

function activeInventory(repoRoot: string): { taskId: string; taskPath: string }[] {
  const activeRoot = path.join(repoRoot, '.agents', 'workspace', 'active');
  if (!fs.existsSync(activeRoot)) return [];
  if (fs.lstatSync(activeRoot).isSymbolicLink()) throw new ActiveTaskMigrationError('MIGRATION_SCOPE_INVALID', 'active workspace must not be a symlink');
  return fs.readdirSync(activeRoot).sort().flatMap((taskId) => {
    if (!ACTIVE_TASK_ID.test(taskId)) return [];
    const taskDir = path.join(activeRoot, taskId);
    const taskPath = path.join(taskDir, 'task.md');
    const stat = fs.lstatSync(taskDir);
    const taskFile = fs.existsSync(taskPath) ? fs.lstatSync(taskPath) : null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !taskFile?.isFile() || taskFile.isSymbolicLink()) {
      throw new ActiveTaskMigrationError('MIGRATION_SCOPE_INVALID', `active task ${taskId} is not a regular task directory`);
    }
    return [{ taskId, taskPath }];
  });
}

function inventoryDigest(items: readonly { taskId: string; taskPath: string }[]): string {
  return digest(JSON.stringify(items.map((item) => ({ taskId: item.taskId, taskPath: item.taskPath }))));
}

function writeManifest(file: string, manifest: MigrationManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeDurableFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, replace: true });
}

function readExistingManifest(file: string): MigrationManifest | null {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as MigrationManifest; }
  catch { throw new ActiveTaskMigrationError('MIGRATION_MANIFEST_INVALID', 'migration manifest is not valid JSON'); }
}

function validateCompletedManifest(
  manifest: MigrationManifest,
  repoRoot: string,
  options: ActiveTaskMigrationOptions
): void {
  if (
    manifest.version !== 1
    || manifest.authority !== 'direct-host'
    || manifest.root !== repoRoot
    || manifest.repository !== options.repository
    || manifest.provider !== options.provider.name
    || manifest.scope !== 'active'
    || typeof manifest.inventoryDigest !== 'string'
    || JSON.stringify(manifest.transitionBuild) !== JSON.stringify(transitionBuildAttestation())
  ) throw new ActiveTaskMigrationError('MIGRATION_MANIFEST_SCOPE_INVALID', 'completed migration manifest does not match the requested scope');
}

function validateOptions(repoRoot: string, options: ActiveTaskMigrationOptions): void {
  if (options.authority.mode !== 'direct-host') throw new ActiveTaskMigrationError('MIGRATION_AUTHORITY_REQUIRED', 'active migration requires direct-host authority');
  if (fs.realpathSync.native(options.authority.repositoryRoot) !== repoRoot
    || options.authority.repository !== options.repository
    || options.authority.provider !== options.provider.name
    || !options.authority.authenticated) {
    throw new ActiveTaskMigrationError('MIGRATION_AUTHORITY_INVALID', 'migration authority does not match the repository and provider context');
  }
  if (!options.repository.trim()) throw new ActiveTaskMigrationError('MIGRATION_REPOSITORY_REQUIRED', 'active migration requires a repository identity');
  if (!options.provider || !options.provider.name.trim()
    || !options.provider.capabilities.authenticated
    || !(options.provider.capabilities.triage || options.provider.capabilities.push || options.provider.capabilities.admin)
    || typeof options.provider.verifyIssueIdentity !== 'function'
    || typeof options.provider.verifyPullRequestFact !== 'function') {
    throw new ActiveTaskMigrationError('MIGRATION_PROVIDER_UNAVAILABLE', 'active migration requires an authenticated provider with verified repository access');
  }
  try {
    primaryIdentityKind(options.provider.identity, 'issue');
    primaryIdentityKind(options.provider.identity, 'pull-request');
  } catch (error) {
    throw new ActiveTaskMigrationError('MIGRATION_PROVIDER_IDENTITY_INVALID', error instanceof Error ? error.message : String(error));
  }
  if (JSON.stringify(options.authority.transitionBuild) !== JSON.stringify(transitionBuildAttestation())) {
    throw new ActiveTaskMigrationError('MIGRATION_TRANSITION_BUILD_INVALID', 'migration requires the current transition build and complete writer enrollment');
  }
}

async function runMigration(repoRoot: string, options: ActiveTaskMigrationOptions, manifestPath: string): Promise<ActiveTaskMigrationResult> {
  const existing = readExistingManifest(manifestPath);
  if (existing?.status === 'completed') {
    validateCompletedManifest(existing, fs.realpathSync.native(repoRoot), options);
    return { status: 'no-op', changed: 0, inventoryDigest: existing.inventoryDigest, manifestPath };
  }
  if (existing) throw new ActiveTaskMigrationError('MIGRATION_INCOMPLETE', 'an incomplete migration manifest must be reviewed before retrying');

  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = migrationTimestamp(now);
  const items = activeInventory(repoRoot);
  const scopeDigest = inventoryDigest(items);
  const prepared: MigrationManifest = {
    version: 1, status: 'prepared', authority: 'direct-host', repository: options.repository,
    provider: options.provider.name, root: fs.realpathSync.native(repoRoot), scope: 'active',
    inventoryDigest: scopeDigest, transitionBuild: options.authority.transitionBuild,
    startedAt, updatedAt: startedAt, items: []
  };
  try {
    for (const item of items) {
      const beforeContent = fs.readFileSync(item.taskPath, 'utf8');
      const metadata = parseTypedTaskFrontmatter(beforeContent);
      const fact = parseFactValue(metadata.pr_delivery_fact);
      if (fact?.state === 'bound' && fact.identity.repository !== options.repository) {
        throw new ActiveTaskMigrationError('MIGRATION_REPOSITORY_CONFLICT', `PR repository for ${item.taskId} does not match migration repository`);
      }
      if (fact && !(await options.provider.verifyPullRequestFact({ taskId: item.taskId, fact }))) {
        throw new ActiveTaskMigrationError('MIGRATION_PROVIDER_FACT_REJECTED', `provider rejected PR fact for ${item.taskId}`);
      }
      const issueIdentity = await issueIdentityFor(item.taskId, metadata, fact, options.provider);
      const set: Record<string, string> = {};
      if (fact) set.pr_delivery_fact = encodePrDeliveryFact(fact);
      if (issueIdentity) set.platform_issue_identity = serializeResourceIdentity(issueIdentity);
      const remove = issueIdentity && Object.hasOwn(metadata, 'issue_number') ? ['issue_number'] : [];
      const targetContent = updateTaskFrontmatter(beforeContent, set, remove);
      prepared.items.push({
        taskId: item.taskId,
        taskPath: item.taskPath,
        beforeDigest: digest(beforeContent),
        targetDigest: digest(targetContent),
        postDigest: null,
        beforeContent
      });
    }
    writeManifest(manifestPath, prepared);
    for (const item of prepared.items) {
      const current = fs.readFileSync(item.taskPath, 'utf8');
      if (digest(current) !== item.beforeDigest) {
        throw new ActiveTaskMigrationError('MIGRATION_CAS_CONFLICT', `task ${item.taskId} changed after migration preparation`);
      }
      const target = updateTaskFrontmatter(
        current,
        await (async () => {
          const metadata = parseTypedTaskFrontmatter(current);
          const fact = parseFactValue(metadata.pr_delivery_fact);
          const issueIdentity = await issueIdentityFor(item.taskId, metadata, fact, options.provider);
          const set: Record<string, string> = {};
          if (fact) set.pr_delivery_fact = encodePrDeliveryFact(fact);
          if (issueIdentity) set.platform_issue_identity = serializeResourceIdentity(issueIdentity);
          return set;
        })(),
        Object.hasOwn(parseTypedTaskFrontmatter(current), 'issue_number') ? ['issue_number'] : []
      );
      const mode = fs.statSync(item.taskPath).mode & 0o777;
      writeDurableFile(item.taskPath, target, { mode, replace: true });
      const post = fs.readFileSync(item.taskPath, 'utf8');
      if (digest(post) !== item.targetDigest) throw new ActiveTaskMigrationError('MIGRATION_POST_VERIFY_FAILED', `task ${item.taskId} failed post-write validation`);
      item.postDigest = digest(post);
    }
    const finalItems = activeInventory(repoRoot);
    if (inventoryDigest(finalItems) !== scopeDigest) throw new ActiveTaskMigrationError('MIGRATION_SCOPE_DRIFT', 'active task inventory changed during migration');
    for (const item of prepared.items) {
      const metadata = parseTypedTaskFrontmatter(fs.readFileSync(item.taskPath, 'utf8'));
      if (Object.hasOwn(metadata, 'issue_number')) throw new ActiveTaskMigrationError('MIGRATION_LEGACY_FIELD_REMAINED', `task ${item.taskId} still has issue_number`);
      parseOptionalIssueIdentity(metadata.platform_issue_identity);
      const fact = parseFactValue(metadata.pr_delivery_fact);
      if (fact && fact.version !== 2) throw new ActiveTaskMigrationError('MIGRATION_FACT_REMAINED_LEGACY', `task ${item.taskId} still has a legacy PR fact`);
      if (digest(fs.readFileSync(item.taskPath, 'utf8')) !== item.targetDigest) throw new ActiveTaskMigrationError('MIGRATION_FINAL_VERIFY_FAILED', `task ${item.taskId} failed final content validation`);
    }
    const completed: MigrationManifest = { ...prepared, status: 'completed', updatedAt: migrationTimestamp(now) };
    writeManifest(manifestPath, completed);
    return { status: 'completed', changed: prepared.items.filter((item) => item.beforeDigest !== item.targetDigest).length, inventoryDigest: scopeDigest, manifestPath };
  } catch (error) {
    const failure = error instanceof ActiveTaskMigrationError
      ? error
      : new ActiveTaskMigrationError('MIGRATION_FAILED', error instanceof Error ? error.message : String(error));
    const failed: MigrationManifest = { ...prepared, status: 'failed', updatedAt: migrationTimestamp(now), error: { code: failure.code, message: failure.message } };
    try { writeManifest(manifestPath, failed); } catch { /* preserve the primary migration failure */ }
    throw failure;
  }
}

async function migrateActiveTaskMetadata(repoRoot: string, options: ActiveTaskMigrationOptions): Promise<ActiveTaskMigrationResult> {
  const canonicalRoot = fs.realpathSync.native(repoRoot);
  validateOptions(canonicalRoot, options);
  const manifestPath = options.manifestPath ?? path.join(canonicalRoot, '.agents', 'workspace', 'migrations', MANIFEST_NAME);
  return await withTransitionMigrationLock(
    canonicalRoot,
    options.ownerName ?? 'active-task-migration',
    () => runMigration(canonicalRoot, options, manifestPath),
    { lockRoot: options.lockRoot }
  );
}

export { ActiveTaskMigrationError, migrateActiveTaskMetadata };
export type { ActiveTaskMigrationOptions, ActiveTaskMigrationResult, MigrationManifest, MigrationProvider, MigrationItem };
