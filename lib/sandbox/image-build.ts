import { createHash } from 'node:crypto';
import { detectEngine } from './engine.ts';
import { resolveBuildUid } from './engines/native.ts';
import { toEnginePath } from './engines/wsl2-paths.ts';
import { sandboxImageConfigLabel, sandboxImageRefreshLabel, sandboxLabel } from './constants.ts';
import { runEngine, runSafeEngine } from './shell.ts';
import {
  imageSignatureFields,
  toolNpmPackagesArg,
  toolShellInstallScriptBase64
} from './tools.ts';
import type { SandboxTool } from './tools.ts';

type PreparedDockerfileSignature = {
  signature: unknown;
};
type BuildImageConfig = {
  project: string;
  imageName: string;
  repoRoot: string;
  engine?: string | null;
};
type EngineRunFn = (engine: string, cmd: string, args: string[], opts?: { cwd?: string }) => string;
type EngineRunSafeFn = EngineRunFn;

export function buildImageSignature(preparedDockerfile: PreparedDockerfileSignature, tools: SandboxTool[]): string {
  return createHash('sha256')
    .update(JSON.stringify({
      dockerfile: preparedDockerfile.signature,
      tools: imageSignatureFields(tools)
    }))
    .digest('hex')
    .slice(0, 12);
}

export function buildSandboxImageArgs(
  config: BuildImageConfig,
  tools: SandboxTool[],
  dockerfilePath: string,
  imageSignature: string,
  {
    engine,
    runFn = runEngine,
    runSafeFn = runSafeEngine,
    env = process.env,
    refresh = false,
    lastRefresh
  }: {
    engine?: string;
    runFn?: EngineRunFn;
    runSafeFn?: EngineRunSafeFn;
    env?: NodeJS.ProcessEnv;
    refresh?: boolean;
    lastRefresh?: number;
  } = {}
): string[] {
  const selectedEngine = engine ?? detectEngine({ engine: config.engine });
  const { uid: hostUid, gid: hostGid } = resolveBuildUid({
    engine: selectedEngine,
    runFn,
    runSafeFn,
    env
  });

  const args = [
    'build',
    '-t',
    config.imageName,
    '--build-arg',
    `HOST_UID=${hostUid}`,
    '--build-arg',
    `HOST_GID=${hostGid}`,
    '--build-arg',
    `AI_TOOL_PACKAGES=${toolNpmPackagesArg(tools)}`,
    '--build-arg',
    `AI_TOOLS_SHELL_INSTALL_B64=${toolShellInstallScriptBase64(tools)}`,
    '--label',
    sandboxLabel(config),
    '--label',
    `${sandboxImageConfigLabel(config)}=${imageSignature}`
  ];

  if (lastRefresh !== undefined) {
    args.push('--label', `${sandboxImageRefreshLabel(config)}=${lastRefresh}`);
  }

  args.push(
    '-f',
    toEnginePath(selectedEngine, dockerfilePath),
    toEnginePath(selectedEngine, config.repoRoot)
  );

  if (refresh) {
    args.splice(1, 0, '--no-cache', '--pull');
  }

  return args;
}

export function parseRefreshTimestamp(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseImageLabels(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

export function isRefreshDisabled(env: NodeJS.ProcessEnv, noRefreshFlag: boolean): boolean {
  if (noRefreshFlag) {
    return true;
  }

  const value = env.AI_SANDBOX_NO_REFRESH?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function isRefreshDue(lastRefresh: number, now: number, intervalDays: number): boolean {
  if (intervalDays <= 0 || lastRefresh > now) {
    return false;
  }

  return now - lastRefresh >= intervalDays * 24 * 60 * 60 * 1000;
}
