import process from 'node:process';
import spawn from 'cross-spawn';

import semver from 'semver';

type RunResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type RunOptions = { cwd?: string; input?: string };
type Runner = (args: string[], options: RunOptions) => RunResult;
type RequestOptions = RunOptions & { method?: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE' };
type GitHubError = { code: string; message: string };
type ClientResult<T> = { ok: true; value: T } | { ok: false; error: GitHubError };
type GitHubRequestFailure = GitHubError & { requestRetryable: boolean };
type ResponseMetadata = {
  status: number;
  requestUrl: string;
  date?: string;
  links: string[];
};
type JsonResponse<T> = { value: T; metadata: ResponseMetadata };

type GitHubClient = {
  version(options?: RunOptions): ClientResult<string>;
  json<T = unknown>(args: string[], options?: RequestOptions): ClientResult<T>;
  jsonWithMetadata?<T = unknown>(args: string[], options?: RequestOptions): ClientResult<JsonResponse<T>>;
  text(args: string[], options?: RequestOptions): ClientResult<string>;
};

type ClientOptions = {
  runner?: Runner;
  retryDelaysMs?: number[];
  sleep?: (delayMs: number) => void;
};

// closingIssuesReferences (introduced in gh 2.72.0) is the highest-versioned gh feature
// the platform layer depends on; see github-release-notes.ts:102.
const MINIMUM_GITHUB_CLI_VERSION = '2.72.0';
const GITHUB_CLI_MAX_BUFFER = 64 * 1024 * 1024;
const ERROR_DETAIL_LIMIT = 4096;

function redactDiagnostic(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 [REDACTED_TOKEN]')
    .replace(/([?&](?:access_token|token|client_secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
}

function boundedFailureDetail(result: RunResult): string {
  const diagnostic = redactDiagnostic(`${result.stderr}\n${result.error?.message || ''}`).trim() || redactDiagnostic(result.stdout.trim());
  return diagnostic.length <= ERROR_DETAIL_LIMIT
    ? diagnostic
    : `${diagnostic.slice(0, ERROR_DETAIL_LIMIT)}… [truncated]`;
}

function requestDiagnostics(args: string[], request: RequestOptions, attempt: number, errorMessage: string): string {
  if (process.env.AGENT_INFRA_GH_DIAGNOSTICS !== '1' && !/rate.?limit/iu.test(errorMessage)) return '';

  const apiIndex = args.indexOf('api');
  const endpoint = apiIndex < 0
    ? args.slice(0, 2).filter((arg) => !arg.startsWith('-')).join(' ')
    : args.slice(apiIndex + 1).find((arg) => !arg.startsWith('-') && !arg.includes('=')) || 'unknown';
  const safeEndpoint = endpoint.startsWith('http')
    ? (() => {
      try {
        const url = new URL(endpoint);
        return `${url.host}${url.pathname}`;
      } catch {
        return 'unknown';
      }
    })()
    : endpoint.split('?')[0] || 'unknown';
  const methodIndex = args.findIndex((arg) => arg === '-X' || arg === '--method');
  const methodFromArgs = methodIndex >= 0 ? args[methodIndex + 1] : undefined;
  const method = methodFromArgs || request.method || (safeEndpoint === 'graphql' ? 'POST' : 'GET');
  const tokenEnvironment = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
    .filter((name) => Boolean(process.env[name]));
  const configDirOverride = Boolean(process.env.GH_CONFIG_DIR);

  return ` [gh-diagnostic endpoint=${safeEndpoint} method=${method} attempt=${attempt} tokenEnv=${tokenEnvironment.join(',') || 'none'} ghConfigDirOverride=${configDirOverride}]`;
}

function defaultRunner(args: string[], options: RunOptions): RunResult {
  const command = process.env.AGENT_INFRA_GH_BIN || 'gh';
  let prefix: string[] = [];
  try {
    prefix = JSON.parse(process.env.AGENT_INFRA_GH_ARGS_JSON || '[]') as string[];
  } catch {
    prefix = [];
  }
  const result = spawn.sync(command, [...prefix, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    input: options.input,
    maxBuffer: GITHUB_CLI_MAX_BUFFER,
    shell: false
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error
  };
}

function retryDelaysFromEnvironment(): number[] {
  const raw = process.env.AGENT_INFRA_PLATFORM_RETRY_DELAYS_MS;
  if (!raw) return [3000, 10000];
  return raw.split(',').map(Number).filter((value) => Number.isFinite(value) && value >= 0);
}

function defaultSleep(delayMs: number): void {
  if (delayMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function classifyGitHubFailure(result: RunResult): GitHubRequestFailure {
  const errorCode = result.error && 'code' in result.error ? (result.error as NodeJS.ErrnoException).code : undefined;
  if (errorCode === 'ENOBUFS') {
    return {
      code: 'PLATFORM_OUTPUT_TOO_LARGE',
      message: 'GitHub CLI output exceeded the configured limit',
      requestRetryable: false
    };
  }
  const detail = boundedFailureDetail(result);
  const lower = detail.toLowerCase();
  if (/\b401\b|bad credentials|authentication required|not logged into/.test(lower)) {
    return { code: 'AUTH_REQUIRED', message: detail || 'GitHub authentication is required', requestRetryable: false };
  }
  if (/\b429\b|rate limit|secondary rate|\b5\d\d\b|timeout|timed out|econnreset|enotfound|dns|tls|socket|network/.test(lower)) {
    return { code: 'NETWORK_TRANSIENT', message: detail || 'GitHub request failed temporarily', requestRetryable: true };
  }
  if (/\b403\b|resource not accessible|permission denied/.test(lower)) {
    return { code: 'PERMISSION_DENIED', message: detail || 'GitHub permission denied', requestRetryable: false };
  }
  if (/\b404\b/.test(lower)) {
    return { code: 'RESOURCE_NOT_FOUND', message: detail || 'GitHub resource not found', requestRetryable: false };
  }
  if (/\b422\b|validation failed/.test(lower)) {
    return { code: 'PLATFORM_REQUEST_INVALID', message: detail || 'GitHub rejected the request', requestRetryable: false };
  }
  if (errorCode === 'ENOENT') {
    return { code: 'PLATFORM_DEPENDENCY_MISSING', message: detail || 'GitHub CLI is unavailable', requestRetryable: false };
  }
  return { code: 'PLATFORM_REQUEST_FAILED', message: detail || 'GitHub request failed', requestRetryable: false };
}

function clientError(error: GitHubError): GitHubError {
  return { code: error.code, message: error.message };
}

function responseUrl(args: string[]): string {
  const endpoint = args.find((arg, index) => index > 0 && !arg.startsWith('-')) || '';
  return endpoint.startsWith('http') ? endpoint : `https://api.github.com/${endpoint.replace(/^\//, '')}`;
}

function parseIncludedResponse<T>(stdout: string, args: string[]): JsonResponse<T> | null {
  const statusBlocks = [...stdout.matchAll(/^HTTP\/[^\r\n]+/gim)];
  const headerStart = statusBlocks.at(-1)?.index;
  if (headerStart === undefined) return null;
  const response = stdout.slice(headerStart);
  const separator = response.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) return null;
  const header = response.slice(0, separator.index);
  const body = response.slice(separator.index + separator[0].length);
  const status = header.match(/^HTTP\/[^ ]+\s+(\d{3})/mi)?.[1];
  if (!status) return null;
  const date = header.match(/^Date:\s*(.+)$/mi)?.[1]?.trim();
  const links = [...header.matchAll(/^Link:\s*(.+)$/gim)].flatMap((match) => match[1]!.split(',').map((value) => value.trim()));
  try {
    return {
      value: JSON.parse(body || 'null') as T,
      metadata: {
        status: Number(status),
        requestUrl: responseUrl(args),
        ...(date ? { date } : {}),
        links
      }
    };
  } catch {
    return null;
  }
}

function createGitHubClient(options: ClientOptions = {}): GitHubClient {
  const runner = options.runner || defaultRunner;
  const delays = options.retryDelaysMs || retryDelaysFromEnvironment();
  const sleep = options.sleep || defaultSleep;

  function run(args: string[], request: RequestOptions = {}): ClientResult<string> {
    const method = request.method || 'GET';
    const retryableMethod = method === 'GET' || method === 'PATCH' || method === 'PUT';
    let attempt = 0;
    while (true) {
      const result = runner(args, request);
      if (result.status === 0) return { ok: true, value: result.stdout };
      const error = classifyGitHubFailure(result);
      const requestDetail = requestDiagnostics(args, request, attempt + 1, error.message);
      const contextualError = requestDetail
        ? { ...error, message: `${error.message}${requestDetail}` }
        : error;
      if (!retryableMethod || !error.requestRetryable) return { ok: false, error: clientError(contextualError) };
      if (attempt >= delays.length) {
        return {
          ok: false,
          error: error.code === 'NETWORK_TRANSIENT'
            ? { ...clientError(contextualError), code: 'NETWORK_RETRY_EXHAUSTED', message: `${contextualError.message} (retry exhausted)` }
            : clientError(contextualError)
        };
      }
      sleep(delays[attempt]!);
      attempt += 1;
    }
  }

  return {
    version(request = {}) {
      const result = runner(['--version'], request);
      if (result.status !== 0) return { ok: false, error: clientError(classifyGitHubFailure(result)) };
      const version = result.stdout.match(/^gh version (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m)?.[1];
      if (!version || !semver.valid(version)) {
        return {
          ok: false,
          error: { code: 'GH_CLI_VERSION_INVALID', message: 'GitHub CLI returned an invalid version' }
        };
      }
      return { ok: true, value: version };
    },
    text(args, request = {}) {
      const result = run(args, request);
      return result.ok ? { ok: true, value: result.value.trim() } : result;
    },
    json<T>(args: string[], request: RequestOptions = {}): ClientResult<T> {
      const result = run(args, request);
      if (!result.ok) return result;
      try {
        return { ok: true, value: JSON.parse(result.value || 'null') as T };
      } catch {
        return {
          ok: false,
          error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'GitHub returned invalid JSON' }
        };
      }
    },
    jsonWithMetadata<T>(args: string[], request: RequestOptions = {}): ClientResult<JsonResponse<T>> {
      const includeArgs = args[0] === 'api' && args[1] !== '--include'
        ? [args[0], '--include', ...args.slice(1)]
        : args;
      const result = run(includeArgs, request);
      if (!result.ok) return result;
      const parsed = parseIncludedResponse<T>(result.value, args);
      if (!parsed) {
        return {
          ok: false,
          error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'GitHub response metadata or JSON is invalid' }
        };
      }
      return { ok: true, value: parsed };
    }
  };
}

export { createGitHubClient, MINIMUM_GITHUB_CLI_VERSION, parseIncludedResponse };
export type { ClientResult, GitHubClient, JsonResponse, RequestOptions, ResponseMetadata, RunOptions, RunResult, Runner };
