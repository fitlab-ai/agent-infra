import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import { platformResult } from './types.ts';
import { providerError, providerOperationContext, providerStatus, unsupportedProviderOperation } from './provider-bridge.ts';

type ReleaseSnapshot = { tag: string; published: boolean; draft: boolean; url: string | null };
type ReleaseOptions = { cwd?: string; client?: PlatformClient };

function flattenPages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]).filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
}

async function inspectPlatformRelease(tag: string, options: ReleaseOptions = {}) {
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!context.platform.repository) return { ...platformResult(context.status), platform: context.platform, release: null, workflows: [], error: context.error };
  if (loaded.ok) {
    const inspected = loaded.value.provider.releases?.inspect
      ? await loaded.value.provider.releases.inspect({ context: providerOperationContext(loaded.value), tag })
      : unsupportedProviderOperation(loaded.value.provider, 'releases.inspect');
    if (!inspected.ok) {
      if (inspected.error.code === 'RESOURCE_NOT_FOUND') return { ...platformResult('no-op'), platform: context.platform, release: null, workflows: [], error: null };
      return { ...platformResult(providerStatus(inspected.error)), platform: context.platform, release: null, workflows: [], error: providerError(inspected.error, 'PLATFORM_PROVIDER_OPERATION_FAILED') };
    }
    return {
      ...platformResult('no-op'),
      platform: context.platform,
      release: { tag: inspected.value.tag, published: !inspected.value.draft, draft: inspected.value.draft, url: inspected.value.displayUrl || null },
      workflows: inspected.value.workflows || [],
      error: null
    };
  }
  return { ...platformResult('failed'), platform: context.platform, release: null, workflows: [], error: context.error };
}

async function upsertPlatformRelease(input: { tag: string; title?: string; notesFile?: string }, options: ReleaseOptions = {}) {
  const inspected = await inspectPlatformRelease(input.tag, options);
  if (inspected.release?.published) return { ...inspected, status: 'no-op' as const, changed: false, operations: [] };
  if (inspected.status === 'blocked' || inspected.status === 'failed') return { ...inspected, changed: false, operations: [] };
  if (!inspected.platform.repository) return { ...inspected, status: 'no-op' as const, changed: false, operations: [] };
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client });
  if (loaded.ok) {
    let notes: { text: string; sha256: string; byteLength: number } | undefined;
    if (input.notesFile) {
      try {
        const bytes = fs.readFileSync(input.notesFile);
        notes = { text: bytes.toString('utf8'), sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, byteLength: bytes.byteLength };
      } catch {
        return { ...inspected, status: 'failed' as const, changed: false, operations: [{ name: 'create-release', status: 'failed' }], error: { code: 'RELEASE_NOTES_FILE_UNREADABLE', message: 'notes-file could not be read', retryable: false } };
      }
    }
    const created = loaded.value.provider.releases?.create
      ? await loaded.value.provider.releases.create({
        context: providerOperationContext(loaded.value),
        tag: input.tag,
        title: input.title ?? input.tag,
        ...(notes ? { notes } : {}),
        mutation: { idempotencyKey: `release:create:${input.tag}` }
      })
      : unsupportedProviderOperation(loaded.value.provider, 'releases.create');
    if (!created.ok) return { ...inspected, status: providerStatus(created.error), changed: false, operations: [{ name: 'create-release', status: 'failed' }], error: providerError(created.error, 'PLATFORM_PROVIDER_OPERATION_FAILED') };
    return { ...inspected, status: 'applied' as const, changed: created.value.changed, operations: [{ name: 'create-release', status: 'applied' }], error: null };
  }
  return { ...inspected, status: 'failed' as const, changed: false, operations: [{ name: 'create-release', status: 'failed' }], error: { code: 'PLATFORM_PROVIDER_LOAD_FAILED', message: 'Selected provider failed to load', retryable: false } };
}

async function reconcileReleaseMilestones(version: string, options: ReleaseOptions = {}) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return { status: 'failed' as const, changed: false, operations: [], error: { code: 'RELEASE_VERSION_INVALID', message: `Invalid version '${version}'` } };
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!context.platform.repository) return { ...platformResult(context.status), changed: false, operations: [], error: context.error };
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3]);
  const nextPatch = `${major}.${minor}.${patch + 1}`;
  const currentLine = `${major}.${minor}.x`;
  const ensure = [
    { title: nextPatch, description: `Issues that we want to release in v${nextPatch}.` },
    { title: currentLine, description: `Issues that we want to resolve in ${major}.${minor} line.` }
  ];
  if (patch === 0) {
    const nextMinor = `${major}.${minor + 1}.0`;
    const nextLine = `${major}.${minor + 1}.x`;
    ensure.push(
      { title: nextMinor, description: `Issues that we want to release in v${nextMinor}.` },
      { title: nextLine, description: `Issues that we want to resolve in ${major}.${minor + 1} line.` }
    );
  }
  if (loaded.ok) {
    const reconciled = loaded.value.provider.releases?.reconcileMilestones
      ? await loaded.value.provider.releases.reconcileMilestones({
        context: providerOperationContext(loaded.value),
        version,
        desired: [
          { key: version, title: version, description: `Issues that we want to resolve in v${version}.`, state: 'closed' },
          ...ensure.map((item) => ({ key: item.title, title: item.title, description: item.description, state: 'open' as const }))
        ],
        mutation: { idempotencyKey: `milestones:reconcile:${version}` }
      })
      : unsupportedProviderOperation(loaded.value.provider, 'releases.reconcileMilestones');
    if (!reconciled.ok) return { status: providerStatus(reconciled.error), changed: false, operations: [], error: providerError(reconciled.error, 'PLATFORM_PROVIDER_OPERATION_FAILED') };
    return {
      status: reconciled.value.changed ? 'applied' as const : 'no-op' as const,
      changed: reconciled.value.changed,
      operations: [
        ...reconciled.value.closed.map((title) => ({ name: 'close-milestone', title, status: 'applied' as const })),
        ...reconciled.value.created.map((title) => ({ name: 'ensure-milestone', title, status: 'applied' as const }))
      ],
      error: null
    };
  }
  return { status: 'failed' as const, changed: false, operations: [], error: { code: 'PLATFORM_CAPABILITY_UNSUPPORTED', message: 'Release milestone reconciliation is unavailable', retryable: false } };
}

export { inspectPlatformRelease, reconcileReleaseMilestones, upsertPlatformRelease };
