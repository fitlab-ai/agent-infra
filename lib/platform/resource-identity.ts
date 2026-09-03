type ResourceIdentityKind = 'id' | 'number' | 'key';
type ResourceIdentity = {
  kind?: ResourceIdentityKind;
  value?: string | number;
  /** @deprecated Internal callers must use kind/value; removed from serialized identities. */
  id?: string;
  /** @deprecated Internal callers must use kind/value; removed from serialized identities. */
  number?: number;
  /** @deprecated Internal callers must use kind/value; removed from serialized identities. */
  key?: string;
};
type CanonicalResourceIdentity =
  | { kind: 'id'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'key'; value: string };

type PlatformResourceKind = 'issue' | 'pull-request' | 'comment' | 'release';
type ProviderIdentityDeclaration = Partial<Record<PlatformResourceKind, ResourceIdentityKind>>;

function identityError(message: string): Error & { code: string } {
  return Object.assign(new Error(`PLATFORM_IDENTITY_INVALID: ${message}`), {
    code: 'PLATFORM_IDENTITY_INVALID'
  });
}

function isResourceIdentity(value: unknown): value is CanonicalResourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2 || typeof candidate.kind !== 'string') return false;
  if (candidate.kind === 'number') {
    return Number.isSafeInteger(candidate.value) && (candidate.value as number) > 0;
  }
  return (candidate.kind === 'id' || candidate.kind === 'key')
    && typeof candidate.value === 'string'
    && candidate.value.length > 0
    && candidate.value.trim() === candidate.value;
}

function parseResourceIdentity(value: unknown, label = 'identity'): CanonicalResourceIdentity {
  if (!isResourceIdentity(value)) throw identityError(`${label} must contain exactly one valid kind/value pair`);
  return value;
}

function serializeResourceIdentity(identity: ResourceIdentity): string {
  return JSON.stringify(parseResourceIdentity(identity));
}

function resourceIdentityEquals(left: unknown, right: unknown): boolean {
  return isResourceIdentity(left) && isResourceIdentity(right)
    && left.kind === right.kind && left.value === right.value;
}

function primaryIdentityKind(
  declaration: ProviderIdentityDeclaration | undefined,
  resourceKind: PlatformResourceKind
): ResourceIdentityKind {
  const kind = declaration?.[resourceKind];
  if (kind !== 'id' && kind !== 'number' && kind !== 'key') {
    throw identityError(`provider does not declare a primary identity for ${resourceKind}`);
  }
  return kind;
}

function parseResourceToken(
  token: string,
  resourceKind: PlatformResourceKind,
  declaration: ProviderIdentityDeclaration | undefined
): ResourceIdentity {
  if (typeof token !== 'string' || token.length === 0) throw identityError('resource token must be a non-empty string');
  const kind = primaryIdentityKind(declaration, resourceKind);
  if (kind === 'number') {
    if (!/^[1-9]\d*$/u.test(token)) throw identityError(`${resourceKind} token must be a positive safe integer`);
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value <= 0) throw identityError(`${resourceKind} token must be a positive safe integer`);
    return { kind, value };
  }
  const value = token.trim();
  if (!value) throw identityError(`${resourceKind} token must not be empty`);
  return { kind, value };
}

function identityFromRemoteValue(
  value: unknown,
  resourceKind: PlatformResourceKind,
  declaration: ProviderIdentityDeclaration | undefined
): ResourceIdentity {
  const kind = primaryIdentityKind(declaration, resourceKind);
  if (isResourceIdentity(value)) {
    if (value.kind !== kind) throw identityError(`${resourceKind} response identity kind does not match provider declaration`);
    return value;
  }
  if (kind === 'number') {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { kind, value };
    if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) return parseResourceToken(value, resourceKind, declaration);
    throw identityError(`${resourceKind} response does not contain a valid number identity`);
  }
  if (typeof value !== 'string' || !value.trim()) throw identityError(`${resourceKind} response does not contain a valid string identity`);
  return { kind, value: value.trim() };
}

function resourceIdentityNumber(identity: ResourceIdentity | null | undefined): number | null {
  return identity?.kind === 'number' && typeof identity.value === 'number' ? identity.value : identity?.number ?? null;
}

function resourceIdentityString(identity: ResourceIdentity | null | undefined): string | null {
  return identity && (identity.kind === 'id' || identity.kind === 'key') && typeof identity.value === 'string'
    ? identity.value : identity?.id ?? identity?.key ?? null;
}

function reviewMarker(identity: ResourceIdentity): string {
  const parsed = parseResourceIdentity(identity);
  if (parsed.kind === 'number') return `pr${parsed.value}`;
  const encoded = Buffer.from(serializeResourceIdentity(parsed), 'utf8').toString('base64url');
  return `pr:${encoded}`;
}

export {
  identityFromRemoteValue,
  isResourceIdentity,
  parseResourceIdentity,
  parseResourceToken,
  primaryIdentityKind,
  resourceIdentityEquals,
  resourceIdentityNumber,
  resourceIdentityString,
  reviewMarker,
  serializeResourceIdentity
};
export type { CanonicalResourceIdentity, PlatformResourceKind, ProviderIdentityDeclaration, ResourceIdentity, ResourceIdentityKind };
