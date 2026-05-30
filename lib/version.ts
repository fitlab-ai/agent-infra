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

export { VERSION };
