#!/usr/bin/env node

import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { migrateActiveTaskMetadata } from '../lib/task/one-time-active-migration.ts';
import { resolvePlatformProviderContext } from '../lib/platform/context.ts';
import { providerOperationContext } from '../lib/platform/provider-bridge.ts';
import { resourceIdentityEquals } from '../lib/platform/resource-identity.ts';
import { transitionBuildAttestation } from '../lib/task/task-execution-lock.ts';
import type { PrDeliveryFact } from '../lib/task/pr-delivery-fact.ts';
import type { ResourceIdentity } from '../lib/platform/resource-identity.ts';

function usage(): void {
  process.stderr.write(
    'Usage: node --experimental-strip-types scripts/migrate-active-task-metadata.ts --repository <owner/repository> --provider <name> [--repo-root <path>]\n'
  );
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const repository = option(args, '--repository');
const providerName = option(args, '--provider');

async function main(): Promise<void> {
  if (!repository || !providerName) {
    usage();
    process.exitCode = 1;
    return;
  }
  const repoRoot = path.resolve(option(args, '--repo-root') ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  const loaded = await resolvePlatformProviderContext({ cwd: repoRoot, platformType: providerName });
  if (!loaded.ok) throw Object.assign(new Error(loaded.context.error?.message ?? 'Platform provider context could not be resolved'), {
    code: loaded.context.error?.code ?? 'MIGRATION_PROVIDER_CONTEXT_UNAVAILABLE'
  });
  const { provider, snapshot, repositoryRoot } = loaded.value;
  if (path.resolve(repositoryRoot) !== repoRoot || snapshot.scope.id !== repository || loaded.value.providerType !== providerName) {
    throw Object.assign(new Error('repository root, provider, and platform scope do not match the migration request'), {
      code: 'MIGRATION_AUTHORITY_INVALID'
    });
  }
  if (!snapshot.authenticated || !snapshot.capabilities.authenticated
    || !(snapshot.capabilities.triage || snapshot.capabilities.push || snapshot.capabilities.admin)
    || !provider.issues?.inspect || !provider.changeRequests?.inspect) {
    throw Object.assign(new Error('selected provider lacks authenticated read and repository access'), {
      code: 'MIGRATION_PROVIDER_UNAVAILABLE'
    });
  }
  const context = providerOperationContext(loaded.value);
  const migrationProvider = {
    name: providerName,
    identity: {
      issue: provider.identity?.issue,
      'pull-request': provider.identity?.['pull-request']
    },
    capabilities: snapshot.capabilities,
    verifyIssueIdentity: async ({ identity }: { taskId: string; identity: ResourceIdentity; fact: PrDeliveryFact | null }) => {
      const inspected = await provider.issues!.inspect({ context, target: identity });
      return inspected.ok && resourceIdentityEquals(inspected.value.identity, identity);
    },
    verifyPullRequestFact: async ({ fact }: { taskId: string; fact: PrDeliveryFact }) => {
      if (fact.state !== 'bound') return true;
      const inspected = await provider.changeRequests!.inspect({ context, target: fact.identity.resource });
      if (!inspected.ok) return false;
      const remote = inspected.value;
      return resourceIdentityEquals(remote.identity, fact.identity.resource)
        && remote.head?.repository === fact.identity.head.repository
        && remote.head?.ref === fact.identity.head.ref
        && remote.head?.sha === fact.identity.head.sha
        && remote.base?.repository === fact.identity.base.repository
        && remote.base?.ref === fact.identity.base.ref
        && remote.base?.sha === fact.identity.base.sha
        && (remote.state === 'closed' ? 'closed' : 'open') === fact.binding.remoteState
        && (remote.mergedAt ?? null) === fact.binding.mergedAt
        && (remote.mergeCommitSha ?? null) === fact.binding.mergeCommitSha;
    }
  };
  const build = transitionBuildAttestation();
  const result = await migrateActiveTaskMetadata(repoRoot, {
    authority: {
      mode: 'direct-host',
      repositoryRoot,
      repository,
      provider: providerName,
      authenticated: snapshot.authenticated,
      transitionBuild: build
    },
    repository,
    provider: migrationProvider
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: {
    code: typeof error === 'object' && error && 'code' in error ? String(error.code) : 'MIGRATION_FAILED',
    message: error instanceof Error ? error.message : String(error)
  } })}\n`);
  process.exitCode = 1;
});
