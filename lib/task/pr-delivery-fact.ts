const PR_DELIVERY_FACT_KEY = 'pr_delivery_fact';

type PrDeliveryIdentity = {
  repository: string;
  number: number;
  nodeId: string;
  url: string;
  head: { repository: string; ref: string; sha: string };
  base: { repository: string; ref: string; sha: string };
};

type PrDeliveryBindingSource =
  | 'created'
  | 'reused'
  | 'explicit-bind'
  | 'external-unique'
  | 'external-explicit'
  | 'legacy-migrated';

type PrDeliveryProvenance =
  | 'create-post'
  | 'reuse'
  | 'explicit-bind'
  | 'external-unique'
  | 'external-explicit'
  | 'legacy-migrated';

type PrDeliveryFact =
  | { version: 1; state: 'unbound'; reason: 'initial' | 'migrated' }
  | { version: 1; state: 'skipped'; reason: 'explicit'; decidedAt: string }
  | {
      version: 1;
      state: 'bound';
      identity: PrDeliveryIdentity;
      binding: {
        status: 'verified';
        source: PrDeliveryBindingSource;
        verifiedAt: string;
        issueNumber: number | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw factError(`${label} has an invalid field set`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw factError(`${label} must be a non-empty string`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function positiveNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw factError(`${label} must be a positive integer`);
  return value as number;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  const result = nullableText(value, label);
  if (result !== null && Number.isNaN(Date.parse(result))) throw factError(`${label} must be a valid timestamp`);
  return result;
}

function parseIdentity(value: unknown): PrDeliveryIdentity {
  if (!isRecord(value)) throw factError('identity must be an object');
  exactKeys(value, ['repository', 'number', 'nodeId', 'url', 'head', 'base'], 'identity');
  const head = parseRef(value.head, 'head');
  const base = parseRef(value.base, 'base');
  return {
    repository: text(value.repository, 'identity.repository'),
    number: positiveNumber(value.number, 'identity.number'),
    nodeId: text(value.nodeId, 'identity.nodeId'),
    url: text(value.url, 'identity.url'),
    head,
    base
  };
}

function parseRef(value: unknown, label: string): { repository: string; ref: string; sha: string } {
  if (!isRecord(value)) throw factError(`${label} must be an object`);
  exactKeys(value, ['repository', 'ref', 'sha'], label);
  return {
    repository: text(value.repository, `${label}.repository`),
    ref: text(value.ref, `${label}.ref`),
    sha: text(value.sha, `${label}.sha`)
  };
}

function parseFact(value: unknown): PrDeliveryFact {
  if (!isRecord(value)) throw factError('fact must be an object');
  if (value.version !== 1 || typeof value.state !== 'string') throw factError('version or state is invalid');
  if (value.state === 'unbound') {
    exactKeys(value, ['version', 'state', 'reason'], 'unbound fact');
    if (value.reason !== 'initial' && value.reason !== 'migrated') throw factError('unbound reason is invalid');
    return { version: 1, state: 'unbound', reason: value.reason };
  }
  if (value.state === 'skipped') {
    exactKeys(value, ['version', 'state', 'reason', 'decidedAt'], 'skipped fact');
    if (value.reason !== 'explicit') throw factError('skipped reason is invalid');
    const decidedAt = text(value.decidedAt, 'skipped.decidedAt');
    if (Number.isNaN(Date.parse(decidedAt))) throw factError('skipped.decidedAt must be a valid timestamp');
    return { version: 1, state: 'skipped', reason: 'explicit', decidedAt };
  }
  if (value.state !== 'bound') throw factError('state is invalid');
  exactKeys(value, ['version', 'state', 'identity', 'binding', 'provenance'], 'bound fact');
  if (!isRecord(value.binding)) throw factError('binding must be an object');
  exactKeys(value.binding, ['status', 'source', 'verifiedAt', 'issueNumber', 'remoteState', 'mergedAt', 'mergeCommitSha'], 'binding');
  if (value.binding.status !== 'verified') throw factError('binding status is invalid');
  const sources: readonly PrDeliveryBindingSource[] = ['created', 'reused', 'explicit-bind', 'external-unique', 'external-explicit', 'legacy-migrated'];
  if (!sources.includes(value.binding.source as PrDeliveryBindingSource)) throw factError('binding source is invalid');
  const verifiedAt = text(value.binding.verifiedAt, 'binding.verifiedAt');
  if (Number.isNaN(Date.parse(verifiedAt))) throw factError('binding.verifiedAt must be a valid timestamp');
  const issueNumber = value.binding.issueNumber === null ? null : positiveNumber(value.binding.issueNumber, 'binding.issueNumber');
  if (value.binding.remoteState !== 'open' && value.binding.remoteState !== 'closed') throw factError('binding.remoteState is invalid');
  const mergedAt = optionalTimestamp(value.binding.mergedAt, 'binding.mergedAt');
  const mergeCommitSha = nullableText(value.binding.mergeCommitSha, 'binding.mergeCommitSha');
  if (Boolean(mergedAt) !== Boolean(mergeCommitSha)) throw factError('mergedAt and mergeCommitSha must be paired');
  if (!isRecord(value.provenance)) throw factError('provenance must be an object');
  exactKeys(value.provenance, ['establishedBy'], 'provenance');
  const provenance: readonly PrDeliveryProvenance[] = ['create-post', 'reuse', 'explicit-bind', 'external-unique', 'external-explicit', 'legacy-migrated'];
  if (!provenance.includes(value.provenance.establishedBy as PrDeliveryProvenance)) throw factError('provenance.establishedBy is invalid');
  return {
    version: 1,
    state: 'bound',
    identity: parseIdentity(value.identity),
    binding: {
      status: 'verified',
      source: value.binding.source as PrDeliveryBindingSource,
      verifiedAt,
      issueNumber,
      remoteState: value.binding.remoteState,
      mergedAt,
      mergeCommitSha
    },
    provenance: { establishedBy: value.provenance.establishedBy as PrDeliveryProvenance }
  };
}

function decodePrDeliveryFact(value: unknown): PrDeliveryFact {
  if (typeof value === 'string') {
    try { return parseFact(JSON.parse(value)); }
    catch (error) { throw error instanceof Error && error.message.startsWith('PR_DELIVERY_FACT_INVALID:') ? error : factError('value is not valid JSON'); }
  }
  return parseFact(value);
}

function encodePrDeliveryFact(fact: PrDeliveryFact): string {
  return JSON.stringify(parseFact(fact));
}

function readPrDeliveryFact(metadata: Record<string, unknown>): PrDeliveryFactReadResult {
  if (!Object.hasOwn(metadata, PR_DELIVERY_FACT_KEY) || metadata[PR_DELIVERY_FACT_KEY] === '') return { status: 'missing', fact: null };
  try { return { status: 'valid', fact: decodePrDeliveryFact(metadata[PR_DELIVERY_FACT_KEY]) }; }
  catch (error) { return { status: 'invalid', fact: null, error: error instanceof Error ? error : factError(String(error)) }; }
}

function buildUnboundFact(reason: 'initial' | 'migrated' = 'initial'): PrDeliveryFact {
  return { version: 1, state: 'unbound', reason };
}

function buildSkippedFact(decidedAt: string): PrDeliveryFact {
  return parseFact({ version: 1, state: 'skipped', reason: 'explicit', decidedAt });
}

function provenanceForSource(source: PrDeliveryBindingSource): PrDeliveryProvenance {
  return source === 'created' ? 'create-post' : source === 'reused' ? 'reuse' : source;
}

function buildBoundFact(input: {
  identity: PrDeliveryIdentity;
  source: PrDeliveryBindingSource;
  verifiedAt: string;
  issueNumber?: number | null;
  remoteState: 'open' | 'closed';
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}): PrDeliveryFact {
  return parseFact({
    version: 1,
    state: 'bound',
    identity: input.identity,
    binding: {
      status: 'verified',
      source: input.source,
      verifiedAt: input.verifiedAt,
      issueNumber: input.issueNumber ?? null,
      remoteState: input.remoteState,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null
    },
    provenance: { establishedBy: provenanceForSource(input.source) }
  });
}

function factFrontmatterMutation(fact: PrDeliveryFact): { set: { [PR_DELIVERY_FACT_KEY]: string } } {
  return { set: { [PR_DELIVERY_FACT_KEY]: encodePrDeliveryFact(fact) } };
}

function identityFromPullRequest(pullRequest: PrDeliveryIdentity): PrDeliveryIdentity {
  return parseIdentity(pullRequest);
}

export {
  PR_DELIVERY_FACT_KEY,
  buildBoundFact,
  buildSkippedFact,
  buildUnboundFact,
  decodePrDeliveryFact,
  encodePrDeliveryFact,
  factFrontmatterMutation,
  identityFromPullRequest,
  readPrDeliveryFact
};
export type {
  CreationOutcome,
  PrDeliveryBindingSource,
  PrDeliveryFact,
  PrDeliveryFactReadResult,
  PrDeliveryIdentity,
  PrDeliveryProvenance
};
