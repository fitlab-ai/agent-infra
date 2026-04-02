import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RUNTIMES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'runtimes'
);

function listRuntimeFragments() {
  return fs.readdirSync(RUNTIMES_DIR)
    .filter((file) => file.endsWith('.dockerfile'))
    .map((file) => file.replace(/\.dockerfile$/, ''));
}

export function availableRuntimes() {
  return listRuntimeFragments()
    .filter((name) => name !== 'base' && name !== 'ai-tools')
    .sort();
}

function dockerfileContent(config) {
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
    'base.dockerfile',
    ...config.runtimes.map((runtime) => `${runtime}.dockerfile`),
    'ai-tools.dockerfile'
  ];

  const content = fragments
    .map((fragment) => fs.readFileSync(path.join(RUNTIMES_DIR, fragment), 'utf8').trimEnd())
    .join('\n\n');

  return `${content}\n`;
}

export function dockerfileSignature(config) {
  return createHash('sha256')
    .update(dockerfileContent(config))
    .digest('hex')
    .slice(0, 12);
}

export function prepareDockerfile(config) {
  if (config.dockerfile) {
    const customPath = path.resolve(config.repoRoot, config.dockerfile);
    if (!fs.existsSync(customPath)) {
      throw new Error(`Custom Dockerfile not found: ${customPath}`);
    }

    return {
      path: customPath,
      signature: dockerfileSignature(config),
      cleanup() {}
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${config.project}-sandbox-`));
  const tempPath = path.join(tempDir, 'Dockerfile');
  fs.writeFileSync(tempPath, dockerfileContent(config), 'utf8');

  return {
    path: tempPath,
    signature: dockerfileSignature(config),
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

export function composeDockerfile(config) {
  const content = dockerfileContent(config);

  const tempPath = path.join(os.tmpdir(), `${config.project}-sandbox.Dockerfile`);
  fs.writeFileSync(tempPath, content, 'utf8');
  return tempPath;
}
