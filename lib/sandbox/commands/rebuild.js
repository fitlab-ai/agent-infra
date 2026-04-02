import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { prepareDockerfile } from '../dockerfile.js';
import { sandboxImageConfigLabel, sandboxLabel } from '../constants.js';
import { ensureDocker } from '../engine.js';
import { run, runOk, runVerbose } from '../shell.js';
import { resolveTools, toolNpmPackagesArg } from '../tools.js';

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

function buildArgs(config, tools, dockerfilePath, imageSignature) {
  const hostUid = run('id', ['-u']);
  const hostGid = run('id', ['-g']);

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
    dockerfilePath,
    config.repoRoot
  ];
}

function removeImageIfPresent(imageName) {
  if (runOk('docker', ['image', 'inspect', imageName])) {
    run('docker', ['rmi', imageName]);
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

  await ensureDocker(config);
  p.intro(pc.cyan('Rebuilding sandbox image'));

  try {
    if (quiet) {
      const spinner = p.spinner();
      spinner.start(`Removing old image ${config.imageName}...`);
      removeImageIfPresent(config.imageName);
      spinner.stop('Old image removed');
      spinner.start('Building image...');
      run('docker', buildArgs(config, tools, preparedDockerfile.path, imageSignature), { cwd: config.repoRoot });
      spinner.stop(pc.green('Sandbox image rebuilt'));
    } else {
      p.log.step(`Removing old image ${config.imageName}`);
      removeImageIfPresent(config.imageName);
      p.log.step('Building image');
      runVerbose(
        'docker',
        buildArgs(config, tools, preparedDockerfile.path, imageSignature),
        { cwd: config.repoRoot }
      );
      p.log.success(pc.green('Sandbox image rebuilt'));
    }
  } finally {
    preparedDockerfile.cleanup();
  }
}
