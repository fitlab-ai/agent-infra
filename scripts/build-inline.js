#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DEFAULTS_EXPR = [
  'const DEFAULTS = JSON.parse(',
  "  fs.readFileSync(new URL('../lib/defaults.json', import.meta.url), 'utf8')",
  ');'
].join('\n');

const VERSION_EXPR = [
  "const INSTALLER_VERSION = 'v' + JSON.parse(",
  "  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')",
  ').version;'
].join('\n');

function buildInlineContent() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const defaults = JSON.parse(fs.readFileSync(path.join(rootDir, 'lib', 'defaults.json'), 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;

  if (!source.includes(DEFAULTS_EXPR)) {
    throw new Error('Could not find DEFAULTS expression in src/sync-templates.js');
  }
  if (!source.includes(VERSION_EXPR)) {
    throw new Error('Could not find INSTALLER_VERSION expression in src/sync-templates.js');
  }

  return source
    .replace(DEFAULTS_EXPR, `const DEFAULTS = ${JSON.stringify(defaults, null, 2)};`)
    .replace(VERSION_EXPR, `const INSTALLER_VERSION = ${JSON.stringify(`v${version}`)};`);
}

function main() {
  const nextContent = buildInlineContent();
  const checkOnly = process.argv.includes('--check');

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

main();
