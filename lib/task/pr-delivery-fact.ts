import type { ResourceIdentity } from '../platform/resource-identity.ts';
import { isLegacyCompatibilityEnabled, legacyCompatibilityError, VERSION } from '../version.ts';
import {
  isResourceIdentity,
  parseResourceIdentity,
  resourceIdentityNumber,
  serializeResourceIdentity
} from '../platform/resource-identity.ts';

const PR_DELIVERY_FACT_KEY = 'pr_delivery_fact';

type PrDeliveryIdentity = {
  resource: ResourceIdentity;
  repository: string;
  url: string;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
};

type LegacyPrDeliveryIdentity = {
  repository: string;
  number: number;
  nodeId: string;
  url: string;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
};
type CurrentPrDeliveryIdentityInput = {
  resource: ResourceIdentity;
  repository: string;
  url: string;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
};
type PrDeliveryIdentityInput = CurrentPrDeliveryIdentityInput;

type PrDeliveryBindingSource = 'created' | 'reused' | 'explicit-bind' | 'external-unique' | 'external-explicit';
type PrDeliveryProvenance = 'create-post' | 'reuse' | 'explicit-bind' | 'external-unique' | 'external-explicit';

type PrDeliveryFact =
  | { version: 2; state: 'unbound'; reason: 'initial' }
  | { version: 2; state: 'skipped'; reason: 'explicit'; decidedAt: string }
  | {
      version: 2;
      state: 'bound';
      identity: PrDeliveryIdentity;
      binding: {
        status: 'verified';
        source: PrDeliveryBindingSource;
        verifiedAt: string;
        issueIdentity: ResourceIdentity | null;
        remoteState: 'open' | 'closed';
        mergedAt: string | null;
        mergeCommitSha: string | null;
      };
      provenance: { establishedBy: PrDeliveryProvenance };
    };

type CreationOutcome =
  | { kind: 'planned'; action: 'create' | 'reuse'; createdByCurrentOperation: false }
  | { kind: 'not-created'; reason: 'precondition-failed' | 'post-rejected'; createdByCurrentOperation: false }
  | { kind: 'created'; createdByCurrentOperation: true }
  | { kind: 'reused'; createdByCurrentOperation: false }
  | { kind: 'no-op'; createdByCurrentOperation: false }
  | { kind: 'unknown'; errorCode: 'PR_CREATE_OUTCOME_UNKNOWN' };

type PrDeliveryFactReadResult =
  | { status: 'valid'; fact: PrDeliveryFact }
  | { status: 'missing'; fact: null }
  | { status: 'invalid'; fact: null; error: Error };

function factError(message: string): Error & { code: string } {
  return Object.assign(new Error(`PR_DELIVERY_FACT_INVALID: ${message}`), { code: 'PR_DELIVERY_FACT_INVALID' });
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw factError(`${label} has an invalid field set`);
}
function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.trim() !== value) throw factError(`${label} must be a string`);
  return value;
}
function nullableText(value: unknown, label: string): string | null { return value === null ? null : text(value, label); }
function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) throw factError(`${label} must be a valid timestamp`);
  return new Date(result).toISOString();
}
function positiveNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw factError(`${label} must be a positive integer`);
  return value as number;
}
function parseRef(value: unknown, label: string): { repository: string; ref: string; sha: string } {
  if (!isRecord(value)) throw factError(`${label} must be an object`);
  exactKeys(value, ['repository', 'ref', 'sha'], label);
  return { repository: text(value.repository, `${label}.repository`), ref: text(value.ref, `${label}.ref`), sha: text(value.sha, `${label}.sha`) };
}

function canonicalIdentity(value: unknown): PrDeliveryIdentity {
  if (!isRecord(value)) throw factError('identity must be an object');
  exactKeys(value, ['resource', 'repository', 'url', 'head', 'base'], 'identity');
  return {
    resource: parseResourceIdentity(value.resource, 'identity.resource'),
    repository: text(value.repository, 'identity.repository'),
    url: text(value.url, 'identity.url'),
    head: parseRef(value.head, 'identity.head'),
    base: parseRef(value.base, 'identity.base')
  };
}

function decodeLegacyIdentity(value: unknown): PrDeliveryIdentity {
  if (!isRecord(value)) throw factError('legacy identity must be an object');
  // TODO(compat): Remove the v1 identity decoder before the first stable v1.0.0 release.
  exactKeys(value, ['repository', 'number', 'nodeId', 'url', 'head', 'base'], 'legacy identity');
  const legacy = {
    number: positiveNumber(value.number, 'legacy identity.number'),
    repository: text(value.repository, 'identity.repository'),
    nodeId: text(value.nodeId, 'legacy identity.nodeId'),
    url: text(value.url, 'identity.url'),
    head: parseRef(value.head, 'identity.head'),
    base: parseRef(value.base, 'identity.base')
  } satisfies LegacyPrDeliveryIdentity;
  return {
    resource: { kind: 'number', value: legacy.number },
    repository: legacy.repository,
    url: legacy.url,
    head: legacy.head,
    base: legacy.base
  };
}

function provenanceForSource(source: PrDeliveryBindingSource): PrDeliveryProvenance { return source === 'created' ? 'create-post' : source === 'reused' ? 'reuse' : source; }

function parseFact(value: unknown, runtimeVersion = VERSION): PrDeliveryFact {
  if (!isRecord(value)) throw factError('fact must be an object');
  if ((value.version !== 1 && value.version !== 2) || typeof value.state !== 'string') throw factError('version or state is invalid');
  if (value.version === 1 && !isLegacyCompatibilityEnabled(runtimeVersion)) {
    throw legacyCompatibilityError('v1 PR delivery fact', runtimeVersion);
  }
  if (value.state === 'unbound') {
    exactKeys(value, ['version', 'state', 'reason'], 'unbound fact');
    if (value.reason !== 'initial') throw factError('unbound reason is invalid');
    return { version: 2, state: 'unbound', reason: 'initial' };
  }
  if (value.state === 'skipped') {
    exactKeys(value, ['version', 'state', 'reason', 'decidedAt'], 'skipped fact');
    if (value.reason !== 'explicit') throw factError('skipped reason is invalid');
    return { version: 2, state: 'skipped', reason: 'explicit', decidedAt: timestamp(value.decidedAt, 'skipped.decidedAt') };
  }
  if (value.state !== 'bound') throw factError('state is invalid');
  if (value.version === 1) {
    // TODO(compat): Remove this v1-to-v2 shape conversion before the first stable v1.0.0 release.
    exactKeys(value, ['version', 'state', 'identity', 'binding', 'provenance'], 'legacy bound fact');
    if (!isRecord(value.binding) || !isRecord(value.provenance)) throw factError('legacy binding or provenance is invalid');
    exactKeys(value.binding, ['status', 'source', 'verifiedAt', 'issueNumber', 'remoteState', 'mergedAt', 'mergeCommitSha'], 'legacy binding');
    const issueNumber = value.binding.issueNumber === null ? null : positiveNumber(value.binding.issueNumber, 'legacy binding.issueNumber');
    return parseFact({
      version: 2,
      state: 'bound',
      identity: decodeLegacyIdentity(value.identity),
      binding: {
        status: 'verified', source: value.binding.source, verifiedAt: timestamp(value.binding.verifiedAt, 'binding.verifiedAt'),
        issueIdentity: issueNumber === null ? null : { kind: 'number', value: issueNumber }, remoteState: value.binding.remoteState,
        mergedAt: value.binding.mergedAt === null ? null : timestamp(value.binding.mergedAt, 'binding.mergedAt'), mergeCommitSha: nullableText(value.binding.mergeCommitSha, 'binding.mergeCommitSha')
      },
      provenance: value.provenance
    }, runtimeVersion);
  }
  exactKeys(value, ['version', 'state', 'identity', 'binding', 'provenance'], 'bound fact');
  if (!isRecord(value.binding) || !isRecord(value.provenance)) throw factError('binding or provenance is invalid');
  exactKeys(value.binding, ['status', 'source', 'verifiedAt', 'issueIdentity', 'remoteState', 'mergedAt', 'mergeCommitSha'], 'binding');
  if (value.binding.status !== 'verified') throw factError('binding status is invalid');
  const sources: readonly PrDeliveryBindingSource[] = ['created', 'reused', 'explicit-bind', 'external-unique', 'external-explicit'];
  if (!sources.includes(value.binding.source as PrDeliveryBindingSource)) throw factError('binding source is invalid');
  const issueIdentity = value.binding.issueIdentity === null ? null : parseResourceIdentity(value.binding.issueIdentity, 'binding.issueIdentity');
  if (value.binding.remoteState !== 'open' && value.binding.remoteState !== 'closed') throw factError('binding.remoteState is invalid');
  const mergedAt = value.binding.mergedAt === null ? null : timestamp(value.binding.mergedAt, 'binding.mergedAt');
  const mergeCommitSha = nullableText(value.binding.mergeCommitSha, 'binding.mergeCommitSha');
  if (Boolean(mergedAt) !== Boolean(mergeCommitSha)) throw factError('mergedAt and mergeCommitSha must be paired');
  exactKeys(value.provenance, ['establishedBy'], 'provenance');
  const provenances: readonly PrDeliveryProvenance[] = ['create-post', 'reuse', 'explicit-bind', 'external-unique', 'external-explicit'];
  if (!provenances.includes(value.provenance.establishedBy as PrDeliveryProvenance)) throw factError('provenance.establishedBy is invalid');
  if (value.provenance.establishedBy !== provenanceForSource(value.binding.source as PrDeliveryBindingSource)) throw factError('binding.source and provenance.establishedBy do not match');
  return {
    version: 2, state: 'bound', identity: canonicalIdentity(value.identity),
    binding: { status: 'verified', source: value.binding.source as PrDeliveryBindingSource, verifiedAt: timestamp(value.binding.verifiedAt, 'binding.verifiedAt'), issueIdentity, remoteState: value.binding.remoteState, mergedAt, mergeCommitSha },
    provenance: { establishedBy: value.provenance.establishedBy as PrDeliveryProvenance }
  };
}

function decodePrDeliveryFact(value: unknown, runtimeVersion = VERSION): PrDeliveryFact {
  if (typeof value === 'string') {
    try { return parseFact(JSON.parse(value), runtimeVersion); }
    catch (error) { throw error instanceof Error && error.message.startsWith('PR_DELIVERY_FACT_INVALID:') ? error : factError('value is not valid JSON'); }
  }
  return parseFact(value, runtimeVersion);
}
function encodePrDeliveryFact(fact: PrDeliveryFact): string { return JSON.stringify(parseFact(fact)); }
function readPrDeliveryFact(metadata: Record<string, unknown>, runtimeVersion = VERSION): PrDeliveryFactReadResult {
  if (!Object.hasOwn(metadata, PR_DELIVERY_FACT_KEY) || metadata[PR_DELIVERY_FACT_KEY] === '') return { status: 'missing', fact: null };
  try { return { status: 'valid', fact: decodePrDeliveryFact(metadata[PR_DELIVERY_FACT_KEY], runtimeVersion) }; }
  catch (error) { return { status: 'invalid', fact: null, error: error instanceof Error ? error : factError(String(error)) }; }
}
function buildUnboundFact(): PrDeliveryFact { return { version: 2, state: 'unbound', reason: 'initial' }; }
function buildSkippedFact(decidedAt: string): PrDeliveryFact { return parseFact({ version: 2, state: 'skipped', reason: 'explicit', decidedAt }); }

function buildBoundFact(input: {
  identity: CurrentPrDeliveryIdentityInput;
  source: PrDeliveryBindingSource;
  verifiedAt: string;
  issueIdentity?: ResourceIdentity | null;
  remoteState: 'open' | 'closed';
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}): PrDeliveryFact {
  return parseFact({ version: 2, state: 'bound', identity: input.identity, binding: {
    status: 'verified', source: input.source, verifiedAt: input.verifiedAt,
    issueIdentity: input.issueIdentity === undefined ? null : input.issueIdentity,
    remoteState: input.remoteState, mergedAt: input.mergedAt ?? null, mergeCommitSha: input.mergeCommitSha ?? null
  }, provenance: { establishedBy: provenanceForSource(input.source) } });
}
function factFrontmatterMutation(fact: PrDeliveryFact): { set: { [PR_DELIVERY_FACT_KEY]: string } } { return { set: { [PR_DELIVERY_FACT_KEY]: encodePrDeliveryFact(fact) } }; }
function identityFromPullRequest(pullRequest: PrDeliveryIdentityInput): PrDeliveryIdentity {
  return canonicalIdentity(pullRequest);
}

export { PR_DELIVERY_FACT_KEY, buildBoundFact, buildSkippedFact, buildUnboundFact, decodePrDeliveryFact, encodePrDeliveryFact, factFrontmatterMutation, identityFromPullRequest, readPrDeliveryFact, serializeResourceIdentity };
export type { CreationOutcome, PrDeliveryBindingSource, PrDeliveryFact, PrDeliveryFactReadResult, PrDeliveryIdentity, PrDeliveryIdentityInput, PrDeliveryProvenance };
