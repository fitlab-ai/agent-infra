import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { removeDirRecursive } from '../remove-dir.ts';

const RUNTIMES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'runtimes'
);
const AGENT_CLIENT_RUNTIMES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'agent-clients',
  'adapters',
  'runtimes'
);

type DockerfileImageContribution = Readonly<{
  dockerfileFragments: readonly string[];
  dotfilesExclusions: readonly string[];
}>;

const EMPTY_IMAGE_CONTRIBUTION: DockerfileImageContribution = Object.freeze({
  dockerfileFragments: Object.freeze([]),
  dotfilesExclusions: Object.freeze([])
});

type DockerfileConfig = {
  repoRoot: string;
  project: string;
  dockerfile: string | null;
  runtimes: string[];
};

function listRuntimeFragments(): string[] {
  return fs.readdirSync(RUNTIMES_DIR)
    .filter((file) => file.endsWith('.dockerfile'))
    .map((file) => file.replace(/\.dockerfile$/, ''));
}

export function availableRuntimes(): string[] {
  return listRuntimeFragments()
    .filter((name) => name !== 'base' && name !== 'ai-tools')
    .sort();
}

function exclusionsFragment(exclusions: readonly string[]): string {
  return [
    "RUN mkdir -p /etc/agent-infra && cat > /etc/agent-infra/dotfiles-exclusions <<'EXCLUSIONS'",
    ...exclusions,
    'EXCLUSIONS'
  ].join('\n');
}

function adapterFragmentPath(fragment: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fragment)) {
    throw new Error(`Invalid Agent Client Dockerfile fragment: ${fragment}`);
  }
  const fragmentPath = path.join(AGENT_CLIENT_RUNTIMES_DIR, `${fragment}.dockerfile`);
  if (!fs.existsSync(fragmentPath)) {
    throw new Error(`Unknown Agent Client Dockerfile fragment: ${fragment}`);
  }
  return fragmentPath;
}

function dockerfileContent(
  config: DockerfileConfig,
  image: DockerfileImageContribution = EMPTY_IMAGE_CONTRIBUTION
): string {
  if (config.dockerfile) {
    const customPath = path.resolve(config.repoRoot, config.dockerfile);
    if (!fs.existsSync(customPath)) {
      throw new Error(`Custom Dockerfile not found: ${customPath}`);
    }
    return fs.readFileSync(customPath, 'utf8');
  }

  const validRuntimes = new Set(availableRuntimes());
  for (const runtime of config.runtimes) {
    if (!validRuntimes.has(runtime)) {
      throw new Error(
        `Unknown runtime: ${runtime}. Available runtimes: ${[...validRuntimes].join(', ')}`
      );
    }
  }

  const fragments = [
    fs.readFileSync(path.join(RUNTIMES_DIR, 'base.dockerfile'), 'utf8').trimEnd(),
    exclusionsFragment(image.dotfilesExclusions),
    ...image.dockerfileFragments.map((fragment) =>
      fs.readFileSync(adapterFragmentPath(fragment), 'utf8').trimEnd()
    ),
    ...config.runtimes.map((runtime) =>
      fs.readFileSync(path.join(RUNTIMES_DIR, `${runtime}.dockerfile`), 'utf8').trimEnd()
    ),
    fs.readFileSync(path.join(RUNTIMES_DIR, 'ai-tools.dockerfile'), 'utf8').trimEnd()
  ];

  const content = fragments
    .join('\n\n');

  return `${content}\n`;
}

export function dockerfileSignature(
  config: DockerfileConfig,
  image: DockerfileImageContribution = EMPTY_IMAGE_CONTRIBUTION
): string {
  return createHash('sha256')
    .update(dockerfileContent(config, image))
    .digest('hex')
    .slice(0, 12);
}

export function prepareDockerfile(
  config: DockerfileConfig,
  image: DockerfileImageContribution = EMPTY_IMAGE_CONTRIBUTION
): { path: string; signature: string; cleanup: () => void } {
  if (config.dockerfile) {
    const customPath = path.resolve(config.repoRoot, config.dockerfile);
    if (!fs.existsSync(customPath)) {
      throw new Error(`Custom Dockerfile not found: ${customPath}`);
    }

    return {
      path: customPath,
      signature: dockerfileSignature(config, image),
      cleanup() {}
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${config.project}-sandbox-`));
  const tempPath = path.join(tempDir, 'Dockerfile');
  fs.writeFileSync(tempPath, dockerfileContent(config, image), 'utf8');

  return {
    path: tempPath,
    signature: dockerfileSignature(config, image),
    cleanup() {
      removeDirRecursive(tempDir);
    }
  };
}

export function composeDockerfile(
  config: DockerfileConfig,
  image: DockerfileImageContribution = EMPTY_IMAGE_CONTRIBUTION
): string {
  const content = dockerfileContent(config, image);

  const tempPath = path.join(os.tmpdir(), `${config.project}-sandbox.Dockerfile`);
  fs.writeFileSync(tempPath, content, 'utf8');
  return tempPath;
}
