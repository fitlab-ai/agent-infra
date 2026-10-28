import { resolvePlatformProviderContext } from './context.ts';
import type { PlatformClient } from './context.ts';
import { platformResult } from './types.ts';
import { providerError, providerOperationContext, providerStatus, unsupportedProviderOperation } from './provider-bridge.ts';

type ReleaseOptions = { cwd?: string; client?: PlatformClient };

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

export { inspectPlatformRelease, reconcileReleaseMilestones };
