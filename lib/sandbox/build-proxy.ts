import semver from 'semver';
import { engineDisplayName } from './engine.ts';
import { runSafeEngine } from './shell.ts';

export const BUILD_PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;
export const MIN_BUILD_PROXY_DOCKER_VERSION = '20.10.0';
export const MIN_BUILD_PROXY_BUILDKIT_VERSION = '0.9.0';

export type BuildProxyPlan = {
  args: string[];
  env: NodeJS.ProcessEnv;
  redactionValues: string[];
};

type EngineRunSafeFn = (engine: string, cmd: string, args: string[]) => string;

export function prepareBuildProxy(
  enabled: boolean,
  hostEnv: NodeJS.ProcessEnv,
  engine: string
): BuildProxyPlan {
  const env = { ...hostEnv };
  if (!enabled) {
    return { args: [], env, redactionValues: [] };
  }

  const entries = BUILD_PROXY_ENV_KEYS.flatMap((key) => {
    const value = hostEnv[key]?.trim();
    return value ? [[key, value] as const] : [];
  });
  if (entries.length === 0) {
    throw new Error(
      `No non-empty build proxy variables are set. Configure one of: ${BUILD_PROXY_ENV_KEYS.join(', ')}.`
    );
  }

  for (const [key, value] of entries) env[key] = value;
  if (engine === 'wsl2') {
    const existing = (env.WSLENV ?? '').split(':').filter(Boolean);
    env.WSLENV = [...new Set([...existing, ...entries.map(([key]) => key)])].join(':');
  }

  return {
    args: entries.flatMap(([key]) => ['--build-arg', key]),
    env,
    redactionValues: entries.map(([, value]) => value)
  };
}

function parsedVersion(raw: string): string | null {
  return semver.coerce(raw.trim())?.version ?? null;
}

export function assertBuildProxyCompatibility(
  engine: string,
  runSafeEngineFn: EngineRunSafeFn = runSafeEngine
): void {
  const dockerRaw = runSafeEngineFn(engine, 'docker', ['version', '--format', '{{.Server.Version}}']);
  const dockerVersion = parsedVersion(dockerRaw);
  if (!dockerVersion || !semver.gte(dockerVersion, MIN_BUILD_PROXY_DOCKER_VERSION)) {
    throw new Error(
      `Build proxy requires Docker Engine ${MIN_BUILD_PROXY_DOCKER_VERSION} or newer; `
      + `observed ${dockerVersion ?? 'an unparseable version'}.`
    );
  }

  const buildxRaw = runSafeEngineFn(engine, 'docker', ['buildx', 'inspect', '--bootstrap']);
  const versions = [...buildxRaw.matchAll(/BuildKit:\s*v?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/gi)]
    .map((match) => parsedVersion(match[1] ?? ''))
    .filter((version): version is string => version !== null);
  if (versions.length === 0) {
    throw new Error(
      `Build proxy requires BuildKit ${MIN_BUILD_PROXY_BUILDKIT_VERSION} or newer, `
      + 'but the active builder version could not be determined.'
    );
  }
  const oldVersion = versions.find((version) => !semver.gte(version, MIN_BUILD_PROXY_BUILDKIT_VERSION));
  if (oldVersion) {
    throw new Error(
      `Build proxy observed BuildKit ${oldVersion}; version ${MIN_BUILD_PROXY_BUILDKIT_VERSION} or newer is required.`
    );
  }
}

export function redactBuildProxyValues(text: string, values: readonly string[]): string {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .reduce((result, value) => result.replaceAll(value, '[REDACTED_BUILD_PROXY]'), text);
}

export function buildProxyFailureHint(engine: string): string {
  return `Build-step proxy inheritance is enabled for ${engineDisplayName(engine)}. `
    + 'Image pulls and Dockerfile FROM resolution use the Docker daemon or builder proxy configuration.';
}
