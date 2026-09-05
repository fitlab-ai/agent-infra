import { createHash } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import { commandForEngine, runProbe } from '../shell.ts';
import { getAdapter } from './index.ts';

export type SandboxAuthorityEvidenceV1 = Readonly<{
  version: 1;
  provider: string;
  lockDomain: string;
  routeKind: 'default' | 'context' | 'endpoint' | 'wsl2';
  routeSelector: Readonly<Record<string, string>>;
  normalizedEndpoint: string;
  endpointFingerprint: string;
  daemonIdentity: Readonly<{
    kind: 'docker-server-id';
    fingerprint: string;
  }>;
  apiVersion: Readonly<{ major: number; minor: number }>;
  authorityFingerprint: string;
}>;

export type AuthorityProbe = (cmd: string, args: string[], options?: { timeout?: number }) => SpawnSyncReturns<string | Buffer>;

export type AuthorityCaptureOptions = Readonly<{
  probe?: AuthorityProbe;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  lockDomain?: string;
}>;

export type AuthorityVerification = Readonly<{
  state: 'verified' | 'unknown' | 'conflict';
  reason?: string;
}>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function text(value: string | Buffer | null | undefined): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? '';
}

function safeEndpoint(value: string): string {
  if (!value) return 'docker-default';
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return value
      .replace(/\/\/[^/@]+@/u, '//<redacted>@')
      .replace(/[?&](?:token|password|secret|key)=[^&]*/giu, '');
  }
}

function lockDomainFor(engine: string, endpoint: string): string {
  return digest(`${process.platform}\0${process.arch}\0${engine}\0${endpoint}`);
}

function routeFor(engine: string, env: NodeJS.ProcessEnv): Readonly<{
  kind: SandboxAuthorityEvidenceV1['routeKind'];
  selector: Readonly<Record<string, string>>;
  endpoint: string;
}> {
  if (engine === 'wsl2') {
    return {
      kind: 'wsl2',
      selector: { distro: env.WSL_DISTRO_NAME ?? 'default' },
      endpoint: safeEndpoint(env.DOCKER_HOST ?? '')
    };
  }
  const context = getAdapter(engine).dockerContext;
  if (context) {
    return { kind: 'context', selector: { context }, endpoint: `docker-context://${context}` };
  }
  if (env.DOCKER_HOST) {
    return { kind: 'endpoint', selector: { source: 'DOCKER_HOST' }, endpoint: safeEndpoint(env.DOCKER_HOST) };
  }
  return { kind: 'default', selector: { source: 'docker-default' }, endpoint: 'docker-default' };
}

export function authorityVersionArgs(): string[] {
  return ['version', '--format', '{{json .Server}}'];
}

export function captureSandboxAuthority(
  engine: string,
  options: AuthorityCaptureOptions = {}
): SandboxAuthorityEvidenceV1 {
  const env = options.env ?? process.env;
  const route = routeFor(engine, env);
  const command = commandForEngine(engine, 'docker', authorityVersionArgs());
  let response: SpawnSyncReturns<string | Buffer>;
  try {
    response = (options.probe ?? runProbe)(
      command.cmd,
      command.args,
      options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }
    );
  } catch {
    throw new Error('SANDBOX_AUTHORITY_CAPTURE_FAILED');
  }
  if (response.status !== 0) throw new Error('SANDBOX_AUTHORITY_CAPTURE_FAILED');
  let server: unknown;
  try {
    server = JSON.parse(text(response.stdout).trim());
  } catch {
    throw new Error('SANDBOX_AUTHORITY_CAPTURE_FAILED');
  }
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new Error('SANDBOX_AUTHORITY_CAPTURE_FAILED');
  }
  const record = server as Record<string, unknown>;
  const serverId = typeof record.ID === 'string' ? record.ID : '';
  const api = typeof record.APIVersion === 'string' ? /^(\d+)\.(\d+)$/u.exec(record.APIVersion) : null;
  if (!serverId || !api) throw new Error('SANDBOX_AUTHORITY_CAPTURE_FAILED');
  const normalizedEndpoint = route.endpoint;
  const evidenceWithoutFingerprint = {
    version: 1 as const,
    provider: engine,
    lockDomain: options.lockDomain ?? lockDomainFor(engine, normalizedEndpoint),
    routeKind: route.kind,
    routeSelector: route.selector,
    normalizedEndpoint,
    endpointFingerprint: digest(normalizedEndpoint),
    daemonIdentity: { kind: 'docker-server-id' as const, fingerprint: digest(serverId) },
    apiVersion: { major: Number(api[1]), minor: Number(api[2]) }
  };
  return {
    ...evidenceWithoutFingerprint,
    authorityFingerprint: digest(canonical(evidenceWithoutFingerprint))
  };
}

export function verifySandboxAuthority(
  expected: SandboxAuthorityEvidenceV1 | null | undefined,
  actual: SandboxAuthorityEvidenceV1 | null
): AuthorityVerification {
  if (!expected) return { state: 'unknown', reason: 'SANDBOX_AUTHORITY_EVIDENCE_MISSING' };
  if (!actual) return { state: 'unknown', reason: 'SANDBOX_AUTHORITY_UNAVAILABLE' };
  if (expected.authorityFingerprint !== actual.authorityFingerprint
    || expected.lockDomain !== actual.lockDomain
    || expected.routeKind !== actual.routeKind
    || expected.endpointFingerprint !== actual.endpointFingerprint
    || expected.daemonIdentity.fingerprint !== actual.daemonIdentity.fingerprint) {
    return { state: 'conflict', reason: 'SANDBOX_AUTHORITY_DRIFT' };
  }
  return { state: 'verified' };
}

export function isSandboxAuthorityEvidence(value: unknown): value is SandboxAuthorityEvidenceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  const selector = evidence.routeSelector as Record<string, unknown> | null;
  const daemon = evidence.daemonIdentity as Record<string, unknown> | null;
  const api = evidence.apiVersion as Record<string, unknown> | null;
  return evidence.version === 1
    && typeof evidence.provider === 'string'
    && /^[a-f0-9]{64}$/u.test(evidence.lockDomain as string)
    && ['default', 'context', 'endpoint', 'wsl2'].includes(evidence.routeKind as string)
    && !!selector && typeof selector === 'object' && !Array.isArray(selector)
    && Object.values(selector).every((entry) => typeof entry === 'string')
    && typeof evidence.normalizedEndpoint === 'string'
    && /^[a-f0-9]{64}$/u.test(evidence.endpointFingerprint as string)
    && !!daemon && daemon.kind === 'docker-server-id'
    && /^[a-f0-9]{64}$/u.test(daemon.fingerprint as string)
    && !!api && Number.isSafeInteger(api.major) && (api.major as number) >= 0
    && Number.isSafeInteger(api.minor) && (api.minor as number) >= 0
    && /^[a-f0-9]{64}$/u.test(evidence.authorityFingerprint as string);
}
