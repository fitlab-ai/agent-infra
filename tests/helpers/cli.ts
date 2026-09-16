import path from "node:path";
import { sandboxControlSafeEnv as withoutSandboxControlAuthority } from "../../lib/sandbox/control/server.ts";
import { filePath } from "./paths.ts";

const CLI_PATH = filePath("dist/bin/cli.js");
const INTERNAL_CLI_PATH = filePath("dist/bin/internal-cli.js");

function cliArgs(...args: string[]): string[] {
  return [CLI_PATH, ...args];
}

function internalCliArgs(...args: string[]): string[] {
  return [INTERNAL_CLI_PATH, ...args];
}

function pathWithPrependedBin(binDir: string, envPath: string = process.env.PATH || ""): string {
  return [binDir, envPath].filter(Boolean).join(path.delimiter);
}

function envWithPrependedPath(env: NodeJS.ProcessEnv, binDir: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const nextPath = pathWithPrependedBin(binDir, env[pathKey] || "");
  return {
    ...env,
    [pathKey]: nextPath,
    PATH: nextPath
  };
}

/**
 * Child CLI fixtures model a direct host even when the test runner itself is
 * hosted in a task sandbox. The preload is test-only; production continues to
 * use the native fixed-mount probe.
 */
function sandboxControlSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe = withoutSandboxControlAuthority(env);
  const isolation = `--require=${filePath("scripts/test-status-mount-isolation.cjs")}`;
  const nodeOptions = [safe.NODE_OPTIONS, isolation].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index).join(" ");
  return { ...safe, NODE_OPTIONS: nodeOptions };
}

export {
  CLI_PATH,
  INTERNAL_CLI_PATH,
  cliArgs,
  internalCliArgs,
  envWithPrependedPath,
  pathWithPrependedBin,
  sandboxControlSafeEnv
};
