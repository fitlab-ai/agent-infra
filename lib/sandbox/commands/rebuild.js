import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { prepareDockerfile } from '../dockerfile.js';
import { sandboxImageConfigLabel, sandboxLabel } from '../constants.js';
import { detectEngine, ensureDocker } from '../engine.js';
import { runEngine, runOkEngine, runVerboseEngine } from '../shell.js';
import { resolveTools, toolNpmPackagesArg } from '../tools.js';
import { toEnginePath } from '../windows-paths.js';

const USAGE = `Usage: ai sandbox rebuild [--quiet]`;

function buildSignature(preparedDockerfile, tools) {
  return createHash('sha256')
    .update(JSON.stringify({
      dockerfile: preparedDockerfile.signature,
      tools: tools.map((tool) => tool.npmPackage)
    }))
    .digest('hex')
    .slice(0, 12);
}

export function buildArgs(
  config,
  tools,
  dockerfilePath,
  imageSignature,
  { engine = detectEngine(), runFn = runEngine } = {}
) {
  const hostUid = runFn(engine, 'id', ['-u']);
  const hostGid = runFn(engine, 'id', ['-g']);

  return [
    'build',
    '-t',
    config.imageName,
    '--build-arg',
    `HOST_UID=${hostUid}`,
    '--build-arg',
    `HOST_GID=${hostGid}`,
    '--build-arg',
    `AI_TOOL_PACKAGES=${toolNpmPackagesArg(tools)}`,
    '--label',
    sandboxLabel(config),
    '--label',
    `${sandboxImageConfigLabel(config)}=${imageSignature}`,
    '-f',
    toEnginePath(engine, dockerfilePath),
    toEnginePath(engine, config.repoRoot)
  ];
}

function removeImageIfPresent(imageName, engine = detectEngine()) {
  if (runOkEngine(engine, 'docker', ['image', 'inspect', imageName])) {
    runEngine(engine, 'docker', ['rmi', imageName]);
  }
}

export async function rebuild(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = loadConfig();
  const tools = resolveTools(config);
  const preparedDockerfile = prepareDockerfile(config);
  const imageSignature = buildSignature(preparedDockerfile, tools);
  const quiet = values.quiet ?? false;
  const engine = detectEngine();

  await ensureDocker(config);
  p.intro(pc.cyan('Rebuilding sandbox image'));

  try {
    if (quiet) {
      const spinner = p.spinner();
      spinner.start(`Removing old image ${config.imageName}...`);
      removeImageIfPresent(config.imageName, engine);
      spinner.stop('Old image removed');
      spinner.start('Building image...');
      runEngine(engine, 'docker', buildArgs(config, tools, preparedDockerfile.path, imageSignature, { engine }), {
        cwd: config.repoRoot
      });
      spinner.stop(pc.green('Sandbox image rebuilt'));
    } else {
      p.log.step(`Removing old image ${config.imageName}`);
      removeImageIfPresent(config.imageName, engine);
      p.log.step('Building image');
      runVerboseEngine(
        engine,
        'docker',
        buildArgs(config, tools, preparedDockerfile.path, imageSignature, { engine }),
        { cwd: config.repoRoot }
      );
      p.log.success(pc.green('Sandbox image rebuilt'));
    }
  } finally {
    preparedDockerfile.cleanup();
  }
}
