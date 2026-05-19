// @ts-nocheck
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import { prepareDockerfile } from '../dockerfile.ts';
import { sandboxImageConfigLabel, sandboxLabel } from '../constants.ts';
import { detectEngine, ensureDocker } from '../engine.ts';
import { runEngine, runOkEngine, runSafeEngine, runVerboseEngine } from '../shell.ts';
import { resolveTools, toolNpmPackagesArg } from '../tools.ts';
import { toEnginePath } from '../engines/wsl2-paths.ts';
import { resolveBuildUid } from '../engines/native.ts';

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
  { engine, runFn = runEngine, runSafeFn = runSafeEngine, env = process.env } = {}
) {
  const { uid: hostUid, gid: hostGid } = resolveBuildUid({
    engine,
    runFn,
    runSafeFn,
    env
  });

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

function removeImageIfPresent(imageName, engine) {
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
  const engine = detectEngine(config);

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
