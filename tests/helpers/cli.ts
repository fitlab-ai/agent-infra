import path from "node:path";
import { filePath } from "./paths.ts";

const CLI_PATH = filePath("dist/bin/cli.js");

function cliArgs(...args: string[]): string[] {
  return [CLI_PATH, ...args];
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

export {
  CLI_PATH,
  cliArgs,
  envWithPrependedPath,
  pathWithPrependedBin
};
