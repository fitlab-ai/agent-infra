#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const sourcePath = path.join(rootDir, 'src', 'sync-templates.js');
const targetPaths = [
  path.join(
    rootDir,
    'templates',
    '.agents',
    'skills',
    'update-agent-infra',
    'scripts',
    'sync-templates.js'
  ),
  path.join(
    rootDir,
    '.agents',
    'skills',
    'update-agent-infra',
    'scripts',
    'sync-templates.js'
  )
];

const DEFAULTS_EXPR = /const DEFAULTS = JSON\.parse\(\s*fs\.readFileSync\(new URL\('..\/lib\/defaults\.json', import\.meta\.url\), 'utf8'\)\s*\);/m;
const AGENT_CLIENT_MANIFEST_EXPR = /const AGENT_CLIENT_MANIFEST = JSON\.parse\('__AGENT_CLIENT_MANIFEST__'\);/m;

function requireSingleExpression(source, expression, name) {
  const matches = source.match(new RegExp(expression.source, 'gm')) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${name} expression in src/sync-templates.js`);
  }
}

function validateManifest(manifest, registry) {
  const roundTripped = JSON.parse(JSON.stringify(manifest));
  if (JSON.stringify(roundTripped) !== JSON.stringify(manifest)) {
    throw new Error('Agent Client manifest is not JSON-safe');
  }
  if (!Array.isArray(manifest) || manifest.length !== Object.keys(registry).length) {
    throw new Error('Agent Client manifest is incomplete');
  }

  const ids = manifest.map((entry) => entry?.id);
  if (
    new Set(ids).size !== ids.length
    || JSON.stringify(ids) !== JSON.stringify(Object.keys(registry))
  ) {
    throw new Error('Agent Client manifest IDs do not match the Registry');
  }
  for (const entry of manifest) {
    if (
      typeof entry.id !== 'string'
      || typeof entry.displayName !== 'string'
      || entry.displayName.trim() === ''
      || !Array.isArray(entry.ownedPathPrefixes)
      || entry.ownedPathPrefixes.some((prefix) => typeof prefix !== 'string')
      || Object.keys(entry).sort().join(',') !== 'displayName,id,ownedPathPrefixes'
    ) {
      throw new Error(`Invalid Agent Client manifest entry '${String(entry?.id)}'`);
    }
  }
}

function compileRegistry() {
  const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [tscPath, '-p', path.join(rootDir, 'tsconfig.json')],
    { cwd: rootDir, stdio: 'inherit' }
  );
}

async function buildInlineContent() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const defaults = JSON.parse(fs.readFileSync(path.join(rootDir, 'lib', 'defaults.json'), 'utf8'));
  const registryModule = await import(
    pathToFileURL(path.join(rootDir, 'dist', 'lib', 'agent-clients', 'registry.js')).href
  );
  const manifest = registryModule.createAgentClientManifest();

  requireSingleExpression(source, DEFAULTS_EXPR, 'DEFAULTS');
  requireSingleExpression(source, AGENT_CLIENT_MANIFEST_EXPR, 'AGENT_CLIENT_MANIFEST');
  validateManifest(manifest, registryModule.AGENT_CLIENT_REGISTRY);

  return source
    .replace(DEFAULTS_EXPR, `const DEFAULTS = ${JSON.stringify(defaults, null, 2)};`)
    .replace(
      AGENT_CLIENT_MANIFEST_EXPR,
      `const AGENT_CLIENT_MANIFEST = ${JSON.stringify(manifest, null, 2)};`
    )
    .replace(
      "from '../.agents/scripts/lib/agent-infra-package.js'",
      "from '../../../scripts/lib/agent-infra-package.js'"
    );
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) compileRegistry();
  const nextContent = await buildInlineContent();

  if (checkOnly) {
    for (const targetPath of targetPaths) {
      const currentContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
      if (currentContent !== nextContent) {
        process.stderr.write(
          `Inline build output is out of date for ${path.relative(rootDir, targetPath)}. Run: node scripts/build-inline.js\n`
        );
        process.exitCode = 1;
        return;
      }
    }

    process.stdout.write('Inline build output is up to date.\n');
    return;
  }

  for (const targetPath of targetPaths) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, nextContent, 'utf8');
    process.stdout.write(`Updated ${path.relative(rootDir, targetPath)}\n`);
  }
}

await main();
