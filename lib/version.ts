import { existsSync, readFileSync } from 'node:fs';

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

function isValidAgentInfraVersion(value: unknown): value is string {
  return typeof value === 'string' && AGENT_INFRA_VERSION_PATTERN.test(value);
}

export { VERSION, isValidAgentInfraVersion };
