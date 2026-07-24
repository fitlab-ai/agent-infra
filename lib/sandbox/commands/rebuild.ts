import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadConfig } from '../config.ts';
import type { SandboxConfig } from '../config.ts';
import { prepareDockerfile } from '../dockerfile.ts';
import { sandboxImageRefreshLabel } from '../constants.ts';
import { detectEngine, ensureDocker } from '../engine.ts';
import { runEngine, runOkEngine, runSafeEngine, runVerboseEngine } from '../shell.ts';
import { pruneSandboxDanglingImages } from '../image-prune.ts';
import { resolveTools } from '../tools.ts';
import type { SandboxTool } from '../tools.ts';
import {
  buildImageSignature,
  buildSandboxImageArgs,
  parseImageLabels,
  parseRefreshTimestamp
} from '../image-build.ts';
import {
  assertBuildProxyCompatibility,
  buildProxyFailureHint,
  prepareBuildProxy,
  redactBuildProxyValues
} from '../build-proxy.ts';

const USAGE = `Usage: ai sandbox rebuild [--quiet] [--refresh] [--inherit-build-proxy|-B]`;

type EngineRunFn = (engine: string, cmd: string, args: string[], opts?: { cwd?: string }) => string;
type EngineRunSafeFn = EngineRunFn;

export function buildArgs(
  config: SandboxConfig,
  tools: SandboxTool[],
  dockerfilePath: string,
  imageSignature: string,
  {
    engine,
    runFn = runEngine,
    runSafeFn = runSafeEngine,
    env = process.env,
    refresh = false,
    lastRefresh,
    buildProxyArgs = []
  }: {
    engine?: string;
    runFn?: EngineRunFn;
    runSafeFn?: EngineRunSafeFn;
    env?: NodeJS.ProcessEnv;
    refresh?: boolean;
    lastRefresh?: number;
    buildProxyArgs?: string[];
  } = {}
): string[] {
  return buildSandboxImageArgs(config, tools, dockerfilePath, imageSignature, {
    engine: engine ?? detectEngine(config),
    runFn,
    runSafeFn,
    env,
    refresh,
    lastRefresh,
    buildProxyArgs
  });
}

function readExistingLastRefresh(config: SandboxConfig, engine: string): number {
  if (!runOkEngine(engine, 'docker', ['image', 'inspect', config.imageName])) {
    return 0;
  }

  const labels = parseImageLabels(runSafeEngine(engine, 'docker', [
    'image',
    'inspect',
    '--format',
    '{{ json .Config.Labels }}',
    config.imageName
  ]));

  return parseRefreshTimestamp(labels[sandboxImageRefreshLabel(config)] ?? '');
}

export async function rebuild(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      refresh: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      'inherit-build-proxy': { type: 'boolean', short: 'B' },
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
  const imageSignature = buildImageSignature(preparedDockerfile, tools);
  const quiet = values.quiet ?? false;
  const refresh = values.refresh ?? false;
  const engine = detectEngine(config);

  await ensureDocker(config, undefined);
  if (values['inherit-build-proxy'] && config.dockerfile) {
    throw new Error('Build proxy inheritance is unavailable with a custom sandbox Dockerfile.');
  }
  const buildProxy = prepareBuildProxy(values['inherit-build-proxy'] ?? false, process.env, engine);
  if (values['inherit-build-proxy']) assertBuildProxyCompatibility(engine);
  const lastRefresh = refresh ? Date.now() : readExistingLastRefresh(config, engine);
  p.intro(pc.cyan('Rebuilding sandbox image'));

  try {
    if (quiet) {
      const spinner = p.spinner();
      spinner.start('Building image...');
      runEngine(engine, 'docker', buildArgs(config, tools, preparedDockerfile.path, imageSignature, {
        engine,
        refresh,
        lastRefresh,
        buildProxyArgs: buildProxy.args
      }), {
        cwd: config.repoRoot,
        env: buildProxy.env
      });
      spinner.stop(pc.green('Sandbox image rebuilt'));
    } else {
      p.log.step('Building image');
      runVerboseEngine(
        engine,
        'docker',
        buildArgs(config, tools, preparedDockerfile.path, imageSignature, {
          engine,
          refresh,
          lastRefresh,
          buildProxyArgs: buildProxy.args
        }),
        { cwd: config.repoRoot, env: buildProxy.env }
      );
      p.log.success(pc.green('Sandbox image rebuilt'));
    }
    pruneSandboxDanglingImages(config, engine);
  } catch (error) {
    const message = redactBuildProxyValues(error instanceof Error ? error.message : String(error), buildProxy.redactionValues);
    const hint = values['inherit-build-proxy'] ? `\n${buildProxyFailureHint(engine)}` : '';
    throw new Error(`${message}${hint}`);
  } finally {
    preparedDockerfile.cleanup();
  }
}
