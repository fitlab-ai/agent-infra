import { createHash } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import { runProbe } from '../shell.ts';
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
  route?: SandboxAuthorityEvidenceV1;
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
    const hasUnreplayableParts = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const normalized = parsed.toString().replace(/\/$/u, '');
    return hasUnreplayableParts
      ? `${normalized}#<redacted>`
      : normalized;
  } catch {
    const normalized = value
      .replace(/\/\/[^/@]+@/u, '//<redacted>@')
      .replace(/[?&](?:token|password|secret|key)=[^&]*/giu, '');
    return /[@?#]/u.test(value) ? `${normalized.replace(/[?#].*$/u, '')}#<redacted>` : normalized;
  }
}

function lockDomainFor(engine: string, endpoint: string): string {
  return digest(`${process.platform}\0${process.arch}\0${engine}\0${endpoint}`);
}

type SandboxAuthorityRoute = Readonly<{
  kind: SandboxAuthorityEvidenceV1['routeKind'];
  selector: Readonly<Record<string, string>>;
  endpoint: string;
  command: (args: string[]) => { cmd: string; args: string[] };
}>;

function contextRoute(context: string): SandboxAuthorityRoute {
  return {
    kind: 'context',
    selector: { context },
    endpoint: `docker-context://${context}`,
    command: (args) => ({ cmd: 'docker', args: ['--context', context, ...args] })
  };
}

function endpointRoute(endpoint: string, rawEndpoint: string, unreplayable?: string): SandboxAuthorityRoute {
  return {
    kind: 'endpoint',
    selector: {
      source: 'DOCKER_HOST',
      endpoint,
      ...(unreplayable ? { unreplayable } : {})
    },
    endpoint,
    command: (args) => ({ cmd: 'docker', args: ['--host', rawEndpoint, ...args] })
  };
}

function tlsEnvironmentReason(env: NodeJS.ProcessEnv): string | undefined {
  return env.DOCKER_TLS_VERIFY || env.DOCKER_CERT_PATH || env.DOCKER_TLS
    ? 'tls-environment'
    : undefined;
}

function routeFor(engine: string, env: NodeJS.ProcessEnv): SandboxAuthorityRoute {
  const context = getAdapter(engine).dockerContext;
  if (context) {
    return contextRoute(context);
  }
  if (env.DOCKER_CONTEXT) {
    return contextRoute(env.DOCKER_CONTEXT);
  }
  if (env.DOCKER_HOST) {
    return endpointRoute(safeEndpoint(env.DOCKER_HOST), env.DOCKER_HOST, tlsEnvironmentReason(env));
  }
  return contextRoute('default');
}

function validRouteName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.@/-]*$/u.test(value);
}

function resolveWslDistro(probe: AuthorityProbe, timeoutMs?: number, explicit?: string): string {
  if (explicit) {
    if (!validRouteName(explicit)) throw new Error('SANDBOX_AUTHORITY_ROUTE_CAPTURE_FAILED');
    return explicit;
  }
  const result = probe(
    'wsl.exe',
    ['--list', '--verbose'],
    timeoutMs === undefined ? {} : { timeout: timeoutMs }
  );
  if (result.status !== 0) throw new Error('SANDBOX_AUTHORITY_ROUTE_CAPTURE_FAILED');
  const output = text(result.stdout).replace(/\0/gu, '').replace(/\r/gu, '');
  const defaultLine = output.split('\n').find((line) => /^\s*\*\s+/u.test(line));
  const distro = defaultLine?.replace(/^\s*\*\s+/u, '').replace(/\s+(?:Running|Stopped)\s+\d+\s*$/iu, '').trim();
  if (!distro || !validRouteName(distro)) throw new Error('SANDBOX_AUTHORITY_ROUTE_CAPTURE_FAILED');
  return distro;
}

function wslRoute(
  distro: string,
  context: string | undefined,
  env: NodeJS.ProcessEnv
): SandboxAuthorityRoute {
  const endpoint = env.DOCKER_HOST
    ? safeEndpoint(env.DOCKER_HOST)
    : `wsl://${distro}/${context ?? 'default'}`;
  const unreplayable = tlsEnvironmentReason(env)
    ?? (endpoint.includes('<redacted>') ? 'ambient-endpoint-secret' : undefined);
  return {
    kind: 'wsl2',
    selector: {
      distro,
      ...(context ? { context } : {}),
      ...(unreplayable ? { unreplayable } : {}),
      ...(env.DOCKER_HOST ? { endpoint } : {})
    },
    endpoint,
    command: (args) => ({
      cmd: 'wsl.exe',
      args: [
        '--distribution', distro,
        '--exec', 'docker',
        ...(context ? ['--context', context] : []),
        ...(env.DOCKER_HOST ? ['--host', env.DOCKER_HOST] : []),
        ...args
      ]
    })
  };
}

function currentWslRoute(
  env: NodeJS.ProcessEnv,
  probe: AuthorityProbe,
  timeoutMs?: number
): SandboxAuthorityRoute {
  const distro = resolveWslDistro(probe, timeoutMs, env.WSL_DISTRO_NAME);
  let context = env.DOCKER_CONTEXT;
  if (!context && !env.DOCKER_HOST) {
    const result = probe(
      'wsl.exe',
      ['--distribution', distro, '--exec', 'docker', 'context', 'show'],
      timeoutMs === undefined ? {} : { timeout: timeoutMs }
    );
    context = text(result.stdout).trim();
    if (result.status !== 0 || !validRouteName(context)) {
      throw new Error('SANDBOX_AUTHORITY_ROUTE_CAPTURE_FAILED');
    }
  }
  return wslRoute(distro, context, env);
}

function routeFromEvidence(evidence: SandboxAuthorityEvidenceV1): SandboxAuthorityRoute {
  return {
    kind: evidence.routeKind,
    selector: evidence.routeSelector,
    endpoint: evidence.normalizedEndpoint,
    command: (args) => commandForSandboxAuthority(evidence, 'docker', args)
  };
}

function currentContextRoute(
  engine: string,
  env: NodeJS.ProcessEnv,
  probe: AuthorityProbe,
  timeoutMs?: number
): SandboxAuthorityRoute {
  const configured = routeFor(engine, env);
  if (configured.kind !== 'context' || configured.selector.context !== 'default') return configured;
  if (env.DOCKER_CONTEXT || env.DOCKER_HOST || getAdapter(engine).dockerContext) return configured;
  const result = probe('docker', ['context', 'show'], timeoutMs === undefined ? {} : { timeout: timeoutMs });
  const context = text(result.stdout).trim();
  if (result.status !== 0 || !/^[A-Za-z0-9][A-Za-z0-9_.@/-]*$/u.test(context)) {
    throw new Error('SANDBOX_AUTHORITY_ROUTE_CAPTURE_FAILED');
  }
  return contextRoute(context);
}

/** Build a command using only the route persisted with the sandbox authority. */
export function commandForSandboxAuthority(
  evidence: SandboxAuthorityEvidenceV1,
  cmd: string,
  args: string[] = []
): { cmd: string; args: string[] } {
  if (cmd !== 'docker') {
    throw new Error('SANDBOX_AUTHORITY_ROUTE_UNSUPPORTED');
  }
  if (evidence.routeKind === 'context') {
    const context = evidence.routeSelector.context;
    if (!context) throw new Error('SANDBOX_AUTHORITY_ROUTE_INVALID');
    return { cmd, args: ['--context', context, ...args] };
  }
  if (evidence.routeKind === 'endpoint') {
    const endpoint = evidence.routeSelector.endpoint;
    if (!endpoint || endpoint.includes('<redacted>') || evidence.routeSelector.unreplayable) {
      throw new Error('SANDBOX_AUTHORITY_ROUTE_UNREPLAYABLE');
    }
    return { cmd, args: ['--host', endpoint, ...args] };
  }
  if (evidence.routeKind === 'wsl2') {
    const distro = evidence.routeSelector.distro;
    const context = evidence.routeSelector.context;
    const endpoint = evidence.routeSelector.endpoint;
    if (!distro || evidence.routeSelector.unreplayable || endpoint?.includes('<redacted>')) {
      throw new Error('SANDBOX_AUTHORITY_ROUTE_UNREPLAYABLE');
    }
    return {
      cmd: 'wsl.exe',
      args: [
        '--distribution', distro,
        '--exec', cmd,
        ...(context ? ['--context', context] : []),
        ...(endpoint && !endpoint.startsWith('wsl://') ? ['--host', endpoint] : []),
        ...args
      ]
    };
  }
  return { cmd, args: ['--context', 'default', ...args] };
}

export function authorityVersionArgs(): string[] {
  return ['version', '--format', '{{json .Server}}'];
}

export function captureSandboxAuthority(
  engine: string,
  options: AuthorityCaptureOptions = {}
): SandboxAuthorityEvidenceV1 {
  const env = options.env ?? process.env;
  const probe = options.probe ?? runProbe;
  const route = options.route
    ? routeFromEvidence(options.route)
    : engine === 'wsl2'
      ? currentWslRoute(env, probe, options.timeoutMs)
      : currentContextRoute(engine, env, probe, options.timeoutMs);
  const command = options.route
    ? commandForSandboxAuthority(options.route, 'docker', authorityVersionArgs())
    : route.command(authorityVersionArgs());
  let response: SpawnSyncReturns<string | Buffer>;
  try {
    response = probe(
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
    lockDomain: options.lockDomain ?? options.route?.lockDomain ?? lockDomainFor(engine, normalizedEndpoint),
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
