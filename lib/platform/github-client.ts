import process from 'node:process';
import spawn from 'cross-spawn';

import semver from 'semver';

import type { PlatformError } from './types.ts';

type RunResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type RunOptions = { cwd?: string; input?: string };
type Runner = (args: string[], options: RunOptions) => RunResult;
type RequestOptions = RunOptions & { method?: 'GET' | 'PATCH' | 'POST' | 'DELETE' };
type ClientResult<T> = { ok: true; value: T } | { ok: false; error: PlatformError };

type GitHubClient = {
  version(options?: RunOptions): ClientResult<string>;
  json<T = unknown>(args: string[], options?: RequestOptions): ClientResult<T>;
  text(args: string[], options?: RequestOptions): ClientResult<string>;
};

type ClientOptions = {
  runner?: Runner;
  retryDelaysMs?: number[];
  sleep?: (delayMs: number) => void;
};

const MINIMUM_GITHUB_CLI_VERSION = '2.16.0';
const GITHUB_CLI_MAX_BUFFER = 64 * 1024 * 1024;
const ERROR_DETAIL_LIMIT = 4096;

function boundedFailureDetail(result: RunResult): string {
  const diagnostic = `${result.stderr}\n${result.error?.message || ''}`.trim() || result.stdout.trim();
  return diagnostic.length <= ERROR_DETAIL_LIMIT
    ? diagnostic
    : `${diagnostic.slice(0, ERROR_DETAIL_LIMIT)}… [truncated]`;
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

function classifyGitHubFailure(result: RunResult): PlatformError {
  const errorCode = result.error && 'code' in result.error ? (result.error as NodeJS.ErrnoException).code : undefined;
  if (errorCode === 'ENOBUFS') {
    return {
      code: 'PLATFORM_OUTPUT_TOO_LARGE',
      message: 'GitHub CLI output exceeded the configured limit',
      retryable: false
    };
  }
  const detail = boundedFailureDetail(result);
  const lower = detail.toLowerCase();
  if (/\b401\b|bad credentials|authentication required|not logged into/.test(lower)) {
    return { code: 'AUTH_REQUIRED', message: detail || 'GitHub authentication is required', retryable: false };
  }
  if (/\b429\b|rate limit|secondary rate|\b5\d\d\b|timeout|timed out|econnreset|enotfound|dns|tls|socket|network/.test(lower)) {
    return { code: 'NETWORK_TRANSIENT', message: detail || 'GitHub request failed temporarily', retryable: true };
  }
  if (/\b403\b|resource not accessible|permission denied/.test(lower)) {
    return { code: 'PERMISSION_DENIED', message: detail || 'GitHub permission denied', retryable: false };
  }
  if (/\b404\b/.test(lower)) {
    return { code: 'RESOURCE_NOT_FOUND', message: detail || 'GitHub resource not found', retryable: false };
  }
  if (/\b422\b|validation failed/.test(lower)) {
    return { code: 'PLATFORM_REQUEST_INVALID', message: detail || 'GitHub rejected the request', retryable: false };
  }
  if (errorCode === 'ENOENT') {
    return { code: 'PLATFORM_DEPENDENCY_MISSING', message: detail || 'GitHub CLI is unavailable', retryable: false };
  }
  return { code: 'PLATFORM_REQUEST_FAILED', message: detail || 'GitHub request failed', retryable: false };
}

function createGitHubClient(options: ClientOptions = {}): GitHubClient {
  const runner = options.runner || defaultRunner;
  const delays = options.retryDelaysMs || retryDelaysFromEnvironment();
  const sleep = options.sleep || defaultSleep;

  function run(args: string[], request: RequestOptions = {}): ClientResult<string> {
    const method = request.method || 'GET';
    const retryableMethod = method === 'GET' || method === 'PATCH';
    let attempt = 0;
    while (true) {
      const result = runner(args, request);
      if (result.status === 0) return { ok: true, value: result.stdout };
      const error = classifyGitHubFailure(result);
      if (!retryableMethod || !error.retryable) return { ok: false, error };
      if (attempt >= delays.length) {
        return {
          ok: false,
          error: error.code === 'NETWORK_TRANSIENT'
            ? { ...error, code: 'NETWORK_RETRY_EXHAUSTED', message: `${error.message} (retry exhausted)` }
            : error
        };
      }
      sleep(delays[attempt]!);
      attempt += 1;
    }
  }

  return {
    version(request = {}) {
      const result = runner(['--version'], request);
      if (result.status !== 0) return { ok: false, error: classifyGitHubFailure(result) };
      const version = result.stdout.match(/^gh version (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m)?.[1];
      if (!version || !semver.valid(version)) {
        return {
          ok: false,
          error: { code: 'GH_CLI_VERSION_INVALID', message: 'GitHub CLI returned an invalid version', retryable: false }
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
          error: { code: 'INVALID_PLATFORM_RESPONSE', message: 'GitHub returned invalid JSON', retryable: true }
        };
      }
    }
  };
}

export { classifyGitHubFailure, createGitHubClient, MINIMUM_GITHUB_CLI_VERSION };
export type { ClientResult, GitHubClient, RequestOptions, RunOptions, RunResult, Runner };
