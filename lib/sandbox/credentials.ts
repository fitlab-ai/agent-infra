import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hostJoin } from './engines/wsl2-paths.ts';

type ExecFn = (file: string, args: string[], options?: Record<string, unknown>) => string | Buffer | void;
type ReadFn = (targetPath: string) => string;
type ExistsFn = (targetPath: string) => boolean;
type EnvFn = () => NodeJS.ProcessEnv;

type SecurityClassification = 'OK' | 'LOCKED' | 'NOT_FOUND' | 'OTHER';

type SecurityResult =
  | { ok: true; stdout: string; stderr: ''; classification: 'OK' }
  | { ok: false; stdout: ''; stderr: string; classification: Exclude<SecurityClassification, 'OK'> };

type CredentialStatus = 'OK'
  | 'MISSING'
  | 'STALE_ACCESS'
  | 'KEYCHAIN_LOCKED'
  | 'KEYCHAIN_ERROR'
  | 'KEYCHAIN_WRITE_FAILED';

type CredentialInspection =
  | { status: 'OK'; blob: string; expiresAt: unknown }
  | { status: Exclude<CredentialStatus, 'OK' | 'KEYCHAIN_WRITE_FAILED'>; blob?: undefined; expiresAt?: unknown; detail?: string };

type CredentialEndpoint = CredentialInspection & {
  name: string;
  project?: string;
};

type OkCredentialEndpoint = CredentialEndpoint & {
  status: 'OK';
  blob: string;
};
type ExpiringOkCredentialEndpoint = OkCredentialEndpoint & {
  expiresAt: number;
};

type Warning = {
  source?: string;
  classification?: string;
  message?: string;
};

type WriteResult =
  | { ok: true; classification?: undefined; error?: undefined }
  | { ok: false; classification: Exclude<SecurityClassification, 'OK'>; error: string };

type InspectOptions = {
  readFn?: ReadFn;
  existsFn?: ExistsFn;
  envFn?: EnvFn;
};

type WriteHostOptions = {
  execFn?: ExecFn;
  mkdirFn?: typeof fs.mkdirSync;
  chmodFn?: typeof fs.chmodSync;
  writeFileFn?: typeof fs.writeFileSync;
  renameFn?: typeof fs.renameSync;
  rmFn?: typeof fs.rmSync;
  randomFn?: () => string;
  envFn?: EnvFn;
};

type ReconcileOptions = InspectOptions & {
  execFn?: ExecFn;
  writeFn?: (home: string, project: string, blob: string) => void;
  writeHostFn?: (home: string, blob: string, options?: WriteHostOptions) => WriteResult;
  discoverFn?: (home: string) => string[];
  projects?: string[] | null;
  singleProject?: string | null;
  inspection?: CredentialInspection | null;
};
type ReconcileResult = {
  status: CredentialStatus;
  authoritative: string | null;
  expiresAt: unknown;
  hostWritten: boolean;
  filesWritten: string[];
  fileErrors: Array<{ project: string; error: string }>;
  warnings: Warning[];
  detail?: string | null;
};

type ResolvedTool = {
  tool: {
    id: string;
  };
};

type CredentialPayload = {
  claudeAiOauth?: CredentialPayload;
  scopes?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
};

const LOCKED_PATTERN = /errSecInteractionNotAllowed|User interaction is not allowed/i;
const NOT_FOUND_PATTERN = /errSecItemNotFound|specified item could not be found/i;
const REDACTION_PATTERNS = [
  { pattern: /\{[^{}]*"claudeAiOauth"[\s\S]*?\}\s*\}/g, replacement: '[REDACTED credentials blob]' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED claude token]' },
  { pattern: /gh[psoru]_[A-Za-z0-9]{30,}/g, replacement: '[REDACTED github token]' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, replacement: 'Bearer [REDACTED]' }
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function redactCommandError(text: unknown): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return REDACTION_PATTERNS.reduce(
    (result, { pattern, replacement }) => result.replace(pattern, replacement),
    text
  );
}

export const redactSecurityOutput = redactCommandError;

function extractStderrSafely(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error
    ? error.stderr
    : undefined;
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString('utf8');
  }
  if (typeof stderr === 'string') {
    return stderr;
  }
  return '';
}

function classifySecurityFailure(text: string): Exclude<SecurityClassification, 'OK'> {
  if (LOCKED_PATTERN.test(text)) {
    return 'LOCKED';
  }
  if (NOT_FOUND_PATTERN.test(text)) {
    return 'NOT_FOUND';
  }
  return 'OTHER';
}

function runSecurity(args: string[], options: Record<string, unknown> = {}, execFn: ExecFn = execFileSync): SecurityResult {
  try {
    const stdout = execFn('security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    const text = typeof stdout === 'string'
      ? stdout
      : (Buffer.isBuffer(stdout) ? stdout.toString('utf8') : '');
    return { ok: true, stdout: text, stderr: '', classification: 'OK' };
  } catch (error) {
    const stderr = redactCommandError(extractStderrSafely(error));
    return {
      ok: false,
      stdout: '',
      stderr,
      classification: classifySecurityFailure(stderr)
    };
  }
}

export function buildLockedGuidance(): string {
  return [
    'macOS keychain is locked (errSecInteractionNotAllowed).',
    'Options to recover:',
    '  1. Unlock the keychain on the host:',
    '       security unlock-keychain ~/Library/Keychains/login.keychain-db',
    '     Then re-run "ai sandbox refresh".',
    '  2. Bypass the keychain via an environment variable (recommended for SSH / CI):',
    '     macOS stores Claude Code credentials in the keychain by default, so',
    '     the env-override file must be seeded once before use.',
    '     On a session where the keychain is unlocked, run:',
    '       security unlock-keychain ~/Library/Keychains/login.keychain-db',
    '       umask 077 && mkdir -p "$HOME/.agent-infra" && \\',
    '         security find-generic-password -s "Claude Code-credentials" -w \\',
    '         > "$HOME/.agent-infra/claude-credentials.json"',
    '       chmod 600 "$HOME/.agent-infra/claude-credentials.json"',
    '     Then on the SSH / CI side:',
    '       export AGENT_INFRA_CLAUDE_CREDENTIALS_FILE="$HOME/.agent-infra/claude-credentials.json"',
    '       ai sandbox refresh',
    '     Subsequent reads/writes use that file instead of the keychain.'
  ].join('\n');
}

export function claudeCredentialsEnvOverride(env: NodeJS.ProcessEnv = process.env): { path: string; source: string } | null {
  const raw = env?.AGENT_INFRA_CLAUDE_CREDENTIALS_FILE;
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  return { path: raw, source: 'AGENT_INFRA_CLAUDE_CREDENTIALS_FILE' };
}

export function validateClaudeCredentialsEnvOverride(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env?.AGENT_INFRA_CLAUDE_CREDENTIALS_FILE;
  if (raw === undefined || raw === '') {
    return;
  }
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) {
    throw new Error(
      'Invalid AGENT_INFRA_CLAUDE_CREDENTIALS_FILE value. Expected an absolute file path.'
    );
  }
}

// Reconcile treats the freshest valid endpoint as authoritative so sandbox
// token rotations can flow back to the host credential store.
function validateClaudeCredentialsBlob(raw: unknown, blob: string | null = null): CredentialInspection {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { status: 'MISSING' };
  }

  let parsed: CredentialPayload;
  try {
    parsed = JSON.parse(trimmed) as CredentialPayload;
  } catch {
    return { status: 'STALE_ACCESS' };
  }

  const payload = parsed?.claudeAiOauth ?? parsed;
  const scopes = Array.isArray(payload?.scopes) ? payload.scopes : [];
  const hasRequiredScopes = scopes.includes('user:profile')
    && scopes.includes('user:sessions:claude_code');
  if (!payload?.accessToken || !payload?.refreshToken || !hasRequiredScopes) {
    return { status: 'STALE_ACCESS' };
  }

  return {
    status: 'OK',
    blob: blob ?? trimmed,
    expiresAt: typeof payload?.expiresAt === 'number' ? payload.expiresAt : null
  };
}

export function readClaudeCredentialsFile(
  filePath: string,
  readFn: ReadFn = (targetPath) => fs.readFileSync(targetPath, 'utf8'),
  existsFn: ExistsFn = fs.existsSync
): CredentialInspection {
  if (!existsFn(filePath)) {
    return { status: 'MISSING' };
  }

  try {
    const raw = readFn(filePath);
    return validateClaudeCredentialsBlob(raw, raw);
  } catch {
    return { status: 'STALE_ACCESS' };
  }
}

export function inspectClaudeKeychainStatus(
  home: string,
  execFn: ExecFn = execFileSync,
  options: InspectOptions = {}
): CredentialInspection {
  const {
    readFn,
    existsFn,
    envFn = () => process.env
  } = options;
  const override = claudeCredentialsEnvOverride(envFn());
  if (override) {
    return readClaudeCredentialsFile(override.path, readFn, existsFn);
  }

  if (process.platform === 'darwin') {
    const result = runSecurity([
      'find-generic-password',
      '-a',
      path.basename(home),
      '-s',
      'Claude Code-credentials',
      '-w'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    }, execFn);
    if (result.ok) {
      return validateClaudeCredentialsBlob(result.stdout);
    }
    if (result.classification === 'NOT_FOUND') {
      return { status: 'MISSING' };
    }
    if (result.classification === 'LOCKED') {
      return { status: 'KEYCHAIN_LOCKED', detail: result.stderr };
    }
    return { status: 'KEYCHAIN_ERROR', detail: result.stderr };
  }

  const credentialsPath = path.join(home, '.claude', '.credentials.json');
  return readClaudeCredentialsFile(credentialsPath, readFn, existsFn);
}

export function inspectClaudeMountFile(home: string, project: string, options: InspectOptions = {}): CredentialInspection {
  return readClaudeCredentialsFile(
    claudeCredentialsPath(home, project),
    options.readFn,
    options.existsFn
  );
}

export function extractClaudeCredentialsBlob(home: string, execFn: ExecFn = execFileSync): string | null {
  const inspection = inspectClaudeKeychainStatus(home, execFn);
  return inspection.status === 'OK' ? inspection.blob : null;
}

export function claudeCredentialsDir(home: string, project: string): string {
  return hostJoin(home, '.agent-infra', 'credentials', project, 'claude-code');
}

export function claudeCredentialsPath(home: string, project: string): string {
  return hostJoin(claudeCredentialsDir(home, project), '.credentials.json');
}

export function writeClaudeCredentialsFile(home: string, project: string, blob: string): void {
  const dir = claudeCredentialsDir(home, project);
  const filePath = claudeCredentialsPath(home, project);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(filePath, blob, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function discoverProjects(home: string): string[] {
  const credentialsRoot = hostJoin(home, '.agent-infra', 'credentials');
  if (!fs.existsSync(credentialsRoot)) {
    return [];
  }

  return fs.readdirSync(credentialsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((project) => fs.existsSync(claudeCredentialsPath(home, project)));
}

export function writeClaudeCredentialsToHost(home: string, blob: string, options: WriteHostOptions = {}): WriteResult {
  const {
    execFn = execFileSync,
    mkdirFn = fs.mkdirSync,
    chmodFn = fs.chmodSync,
    writeFileFn = fs.writeFileSync,
    renameFn = fs.renameSync,
    rmFn = fs.rmSync,
    randomFn = () => randomBytes(6).toString('hex'),
    envFn = () => process.env
  } = options;
  const override = claudeCredentialsEnvOverride(envFn());

  if (!override && process.platform === 'darwin') {
    const result = runSecurity([
      'add-generic-password',
      '-U',
      '-a',
      path.basename(home),
      '-s',
      'Claude Code-credentials',
      '-w',
      blob
    ], {
      stdio: ['ignore', 'ignore', 'pipe']
    }, execFn);
    if (result.ok) {
      return { ok: true };
    }
    if (result.classification === 'LOCKED') {
      return { ok: false, classification: 'LOCKED', error: buildLockedGuidance() };
    }
    return {
      ok: false,
      classification: result.classification,
      error: `security command failed: ${result.stderr || 'unknown error'}`
    };
  }

  const targetPath = override?.path ?? path.join(home, '.claude', '.credentials.json');
  const dir = path.dirname(targetPath);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomFn()}`;

  try {
    mkdirFn(dir, { recursive: true, mode: 0o700 });
    chmodFn(dir, 0o700);
    writeFileFn(tmpPath, blob, { mode: 0o600 });
    chmodFn(tmpPath, 0o600);
    renameFn(tmpPath, targetPath);
    return { ok: true };
  } catch (error) {
    try {
      rmFn(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    return {
      ok: false,
      classification: 'OTHER',
      error: redactCommandError(errorMessage(error))
    };
  }
}

export function formatCredentialWarnings(warnings: Array<string | Warning> = []): string {
  return warnings
    .map((warning) => (typeof warning === 'string' ? warning : warning?.message))
    .filter(Boolean)
    .join('; ');
}

function endpointNameForFile(project: string): string {
  return `file:${project}`;
}

function chooseAuthoritativeEndpoint(endpoints: CredentialEndpoint[]): OkCredentialEndpoint | null {
  const okEndpoints = endpoints.filter((endpoint): endpoint is OkCredentialEndpoint => endpoint.status === 'OK');
  if (okEndpoints.length === 0) {
    return null;
  }

  const hostEndpoint = okEndpoints.find((endpoint) => endpoint.name === 'host');
  if (hostEndpoint && typeof hostEndpoint.expiresAt !== 'number') {
    return hostEndpoint;
  }

  const withExpiresAt = okEndpoints.filter(
    (endpoint): endpoint is ExpiringOkCredentialEndpoint => typeof endpoint.expiresAt === 'number'
  );
  if (withExpiresAt.length > 0) {
    return withExpiresAt.reduce((best, endpoint) => (
      endpoint.expiresAt > best.expiresAt ? endpoint : best
    ));
  }

  return okEndpoints.find((endpoint) => endpoint.name === 'host') ?? okEndpoints[0] ?? null;
}

function shouldWriteEndpoint(authoritative: OkCredentialEndpoint, target: CredentialEndpoint): boolean {
  if (target.status !== 'OK') {
    return true;
  }

  if (typeof authoritative.expiresAt === 'number' && typeof target.expiresAt === 'number') {
    return authoritative.expiresAt > target.expiresAt;
  }

  // Both endpoints are OK but expiresAt is not comparable (one or both non-numeric,
  // or values are equal at the same millisecond). Stay conservative and refuse to
  // write — a real rotation will produce a strictly larger expiresAt next time.
  // This guards against leaner host blobs (e.g. stored without subscriptionType)
  // overwriting a richer mount blob solely on the basis of byte differences.
  return false;
}

export function reconcileClaudeCredentials(home: string, options: ReconcileOptions = {}): ReconcileResult {
  const {
    execFn = execFileSync,
    writeFn = writeClaudeCredentialsFile,
    writeHostFn = writeClaudeCredentialsToHost,
    readFn,
    existsFn,
    discoverFn = discoverProjects,
    projects = null,
    singleProject = null,
    inspection = null,
    envFn = () => process.env
  } = options;

  const effectiveProjects = singleProject
    ? [singleProject]
    : (projects ?? discoverFn(home));
  const hostInspection = inspection ?? inspectClaudeKeychainStatus(home, execFn, { readFn, existsFn, envFn });
  const hostEndpoint = { name: 'host', ...hostInspection };
  const fileEndpoints = effectiveProjects.map((project) => ({
    name: endpointNameForFile(project),
    project,
    ...inspectClaudeMountFile(home, project, { readFn, existsFn })
  }));
  const endpoints = [hostEndpoint, ...fileEndpoints];
  const authoritative = chooseAuthoritativeEndpoint(endpoints);

  if (!authoritative) {
    const hasStaleEndpoint = endpoints.some((endpoint) => endpoint.status === 'STALE_ACCESS');
    const unavailableStatus = ['KEYCHAIN_LOCKED', 'KEYCHAIN_ERROR'].includes(hostEndpoint.status)
      ? hostEndpoint.status
      : null;
    return {
      status: unavailableStatus ?? (hasStaleEndpoint ? 'STALE_ACCESS' : 'MISSING'),
      authoritative: null,
      expiresAt: null,
      hostWritten: false,
      filesWritten: [],
      fileErrors: [],
      warnings: [],
      detail: 'detail' in hostEndpoint ? hostEndpoint.detail ?? null : null
    };
  }

  const warnings: Warning[] = [];
  const filesWritten: string[] = [];
  const fileErrors: Array<{ project: string; error: string }> = [];
  let hostWritten = false;
  let hostWriteFailed = false;

  if (authoritative.name !== 'host' && shouldWriteEndpoint(authoritative, hostEndpoint)) {
    const result = writeHostFn(home, authoritative.blob, { execFn, envFn });
    if (result?.ok) {
      hostWritten = true;
    } else {
      hostWriteFailed = true;
      warnings.push({
        source: 'host-keychain',
        classification: result?.classification ?? 'OTHER',
        message: result?.error ?? 'unknown error'
      });
    }
  }

  for (const endpoint of fileEndpoints) {
    if (endpoint.name === authoritative.name || !shouldWriteEndpoint(authoritative, endpoint)) {
      continue;
    }

    try {
      writeFn(home, endpoint.project, authoritative.blob);
      filesWritten.push(endpoint.project);
    } catch (error) {
      fileErrors.push({ project: endpoint.project, error: errorMessage(error) });
    }
  }

  return {
    status: hostWriteFailed ? 'KEYCHAIN_WRITE_FAILED' : 'OK',
    authoritative: authoritative.name,
    expiresAt: authoritative.expiresAt ?? null,
    hostWritten,
    filesWritten,
    fileErrors,
    warnings
  };
}

export function syncClaudeCredentialsFromKeychain(home: string, project: string, options: ReconcileOptions = {}) {
  const result = reconcileClaudeCredentials(home, {
    ...options,
    singleProject: project
  });
  if (result.status !== 'OK' && result.status !== 'KEYCHAIN_WRITE_FAILED') {
    return {
      status: result.status,
      written: false
    };
  }

  return {
    status: result.status === 'KEYCHAIN_WRITE_FAILED' ? 'OK' : result.status,
    written: result.filesWritten.includes(project),
    expiresAt: result.expiresAt
  };
}

export function formatRemaining(expiresAt: unknown): string {
  if (typeof expiresAt !== 'number') {
    return 'unknown';
  }

  const ms = expiresAt - Date.now();
  if (ms <= 0) {
    return 'EXPIRED';
  }

  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function assertClaudeCredentialsAvailable(
  home: string,
  project: string,
  resolvedTools: ResolvedTool[],
  extractFn: (home: string) => string | null = extractClaudeCredentialsBlob,
  writeFn: (home: string, project: string, blob: string) => void = writeClaudeCredentialsFile,
  inspectFn: (home: string) => CredentialInspection = inspectClaudeKeychainStatus
): void {
  const claudeCodeEntry = resolvedTools.find(({ tool }) => tool.id === 'claude-code');
  if (!claudeCodeEntry) {
    return;
  }

  let blob: string | null = null;
  const hasCustomInspectFn = inspectFn !== inspectClaudeKeychainStatus;
  const hasCustomExtractFn = extractFn !== extractClaudeCredentialsBlob;
  if (hasCustomInspectFn || !hasCustomExtractFn) {
    const inspection = inspectFn(home);
    if (inspection.status === 'KEYCHAIN_LOCKED') {
      throw new Error([
        'Claude Code credentials are stored in the macOS keychain, but the keychain is locked.',
        '',
        buildLockedGuidance()
      ].join('\n'));
    }
    blob = inspection.status === 'OK' ? inspection.blob : null;
  } else {
    blob = extractFn(home);
  }

  if (!blob) {
    throw new Error([
      'Claude Code credentials not found on host.',
      '',
      'The sandbox needs your Claude Code OAuth credentials so the container can use Claude Code.',
      '',
      'To fix:',
      '  1. On the host, run "claude" once and complete the OAuth login flow.',
      '  2. Verify with "claude /status" that you see your subscription.',
      '  3. Re-run "ai sandbox create".',
      '',
      'Alternatively, if you do not need Claude Code in this sandbox,',
      'remove "claude-code" from the "sandbox.tools" array in .agents/.airc.json.'
    ].join('\n'));
  }

  writeFn(home, project, blob);
}
