import { existsSync, readFileSync } from 'node:fs';
import semver from 'semver';

const packageJsonUrl = [
  new URL('../package.json', import.meta.url),
  new URL('../../package.json', import.meta.url),
].find((url) => existsSync(url));

if (!packageJsonUrl) {
  throw new Error('Unable to locate package.json for agent-infra version');
}

const { version } = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
const VERSION = `v${version}`;
const AGENT_INFRA_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LEGACY_COMPATIBILITY_CUTOFF_VERSION = '1.0.0';

function isValidAgentInfraVersion(value: unknown): value is string {
  return typeof value === 'string' && AGENT_INFRA_VERSION_PATTERN.test(value);
}

function isLegacyCompatibilityEnabled(runtimeVersion = VERSION): boolean {
  const normalized = runtimeVersion.startsWith('v') ? runtimeVersion.slice(1) : runtimeVersion;
  const parsed = semver.valid(normalized);
  return parsed !== null && semver.lt(parsed, LEGACY_COMPATIBILITY_CUTOFF_VERSION);
}

function legacyCompatibilityError(resource: string, runtimeVersion = VERSION): Error & { code: string } {
  return Object.assign(new Error(
    `PLATFORM_IDENTITY_LEGACY_UNSUPPORTED: ${resource} requires migration to the current schema before v${LEGACY_COMPATIBILITY_CUTOFF_VERSION} runtime ${runtimeVersion}`
  ), { code: 'PLATFORM_IDENTITY_LEGACY_UNSUPPORTED' });
}

export { LEGACY_COMPATIBILITY_CUTOFF_VERSION, VERSION, isLegacyCompatibilityEnabled, isValidAgentInfraVersion, legacyCompatibilityError };
