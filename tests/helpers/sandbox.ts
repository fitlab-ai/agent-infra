import fs from "node:fs";
import path from "node:path";
import { initIsolatedGitRepo } from "./git.ts";

type SandboxFixtureOptions = {
  project?: string;
  org?: string;
  sandbox?: Record<string, unknown>;
  dockerStdoutForPs?: string;
  dockerLabelsForInspect?: Record<string, string>;
};
type SandboxFixture = {
  repoDir: string;
  binDir: string;
  logPath: string;
  envFileLogPath: string;
  readDockerCalls(): string[][];
  readRawDockerCalls(): string[][];
  readCapturedEnvFiles(): string[];
};

function dockerCommandArgs(args: string[]): string[] {
  return args[0] === "--context" && args.length >= 2 ? args.slice(2) : args;
}

function writeNodeCommandShim(commandPath: string, scriptPath: string): string {
  fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(
      `${commandPath}.cmd`,
      `@ECHO OFF\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8"
    );
    return `${commandPath}.cmd`;
  }

  fs.writeFileSync(
    commandPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    "utf8"
  );
  fs.chmodSync(commandPath, 0o755);
  return commandPath;
}

function writeSandboxEngineFixture(
  tmpDir: string,
  {
    project = "demo",
    org = "fitlab-ai",
    sandbox = {},
    dockerStdoutForPs = "",
    dockerLabelsForInspect = {}
  }: SandboxFixtureOptions = {}
): SandboxFixture {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "docker-log.jsonl");
  const envFileLogPath = path.join(tmpDir, "docker-env-files.jsonl");
  const dockerJsPath = path.join(binDir, "docker.js");
  const idJsPath = path.join(binDir, "id.js");
  const whichJsPath = path.join(binDir, "which.js");
  const ghJsPath = path.join(binDir, "gh.js");

  fs.mkdirSync(path.join(repoDir, ".agents"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  initIsolatedGitRepo(repoDir);
  // Pick an engine that is (a) valid on every platform via validateSandboxEngine
  // and (b) different from PLATFORM_DEFAULTS[os], so the fixture actually proves
  // that .agents/.airc.json's sandbox.engine reaches detectEngine on each platform
  // (Linux default=native, darwin default=colima, win32 default=wsl2; docker-desktop
  // satisfies both constraints). On Windows this is what catches the wsl2 fallback
  // regression — `commandForEngine('docker-desktop', 'docker', …)` returns the
  // bare `docker` invocation, whereas the buggy fallback wraps it in `wsl.exe --`.
  fs.writeFileSync(
    path.join(repoDir, ".agents", ".airc.json"),
    `${JSON.stringify({
      project,
      org,
      sandbox: {
        ...sandbox,
        engine: "docker-desktop"
      }
    }, null, 2)}\n`,
    "utf8"
  );

  fs.writeFileSync(
    dockerJsPath,
    [
      "const fs = require('node:fs');",
      `const dockerStdoutForPs = ${JSON.stringify(dockerStdoutForPs)};`,
      `const dockerLabelsForInspect = ${JSON.stringify(dockerLabelsForInspect)};`,
      "const rawArgs = process.argv.slice(2);",
      "const args = rawArgs[0] === '--context' && rawArgs.length >= 2 ? rawArgs.slice(2) : rawArgs;",
      "function log() {",
      "  fs.appendFileSync(process.env.DOCKER_LOG_PATH, JSON.stringify(rawArgs) + '\\n');",
      "}",
      "function captureEnvFile() {",
      "  if (!process.env.DOCKER_ENV_FILE_LOG_PATH || args[0] !== 'run') return;",
      "  const index = args.indexOf('--env-file');",
      "  if (index < 0 || !args[index + 1]) return;",
      "  const envPath = args[index + 1];",
      "  let content = '';",
      "  try { content = fs.readFileSync(envPath, 'utf8'); } catch (error) { content = `__READ_ERROR__:${error.message}`; }",
      "  fs.appendFileSync(process.env.DOCKER_ENV_FILE_LOG_PATH, JSON.stringify({ path: envPath, content }) + '\\n');",
      "}",
      "log();",
      "captureEnvFile();",
      "if (args[0] === 'ps') {",
      "  if (dockerStdoutForPs) {",
      "    process.stdout.write(dockerStdoutForPs.endsWith('\\n') ? dockerStdoutForPs : `${dockerStdoutForPs}\\n`);",
      "  }",
      "  if (process.env.DOCKER_EXIT_FOR_PS) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_PS));",
      "  }",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'image' && args[1] === 'inspect') {",
      "  if (process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT && Number(process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT) !== 0) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT));",
      "  }",
      "  const formatIndex = args.indexOf('--format');",
      "  const formatArgs = formatIndex >= 0 ? args.slice(formatIndex + 1, -1) : [];",
      "  const formatValue = formatArgs.join(' ').replace(/^['\\\"]|['\\\"]$/g, '');",
      "  if (formatIndex >= 0 && formatValue === '{{ json .Config.Labels }}') {",
      "    const labels = process.env.DOCKER_LABELS_FOR_IMAGE_INSPECT ? JSON.parse(process.env.DOCKER_LABELS_FOR_IMAGE_INSPECT) : dockerLabelsForInspect;",
      "    process.stdout.write(`${JSON.stringify(labels)}\\n`);",
      "    process.exit(0);",
      "  }",
      "  if (process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT));",
      "  }",
      "  process.exit(1);",
      "}",
      "if (args[0] === 'build' && process.env.DOCKER_EXIT_FOR_BUILD) {",
      "  process.exit(Number(process.env.DOCKER_EXIT_FOR_BUILD));",
      "}",
      "if (args[0] === 'rmi') {",
      "  if (process.env.DOCKER_EXIT_FOR_RMI) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_RMI));",
      "  }",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'version') {",
      "  process.stdout.write('24.0.0\\n');",
      "}",
      "if (args[0] === 'run' && process.env.DOCKER_EXIT_FOR_RUN) {",
      "  process.exit(Number(process.env.DOCKER_EXIT_FOR_RUN));",
      "}",
      "if (args[0] === 'info' && process.env.DOCKER_EXIT_FOR_INFO) {",
      "  process.exit(Number(process.env.DOCKER_EXIT_FOR_INFO));",
      "}",
      "if (args[0] === 'start' && process.env.DOCKER_EXIT_FOR_START) {",
      "  process.exit(Number(process.env.DOCKER_EXIT_FOR_START));",
      "}",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );
  writeNodeCommandShim(path.join(binDir, "docker"), dockerJsPath);

  fs.writeFileSync(
    idJsPath,
    [
      "const args = process.argv.slice(2);",
      "if (args[0] === '-u' || args[0] === '-g') {",
      "  process.stdout.write('1000\\n');",
      "  process.exit(0);",
      "}",
      "process.exit(1);"
    ].join("\n"),
    "utf8"
  );
  writeNodeCommandShim(path.join(binDir, "id"), idJsPath);

  fs.writeFileSync(ghJsPath, "process.exit(0);\n", "utf8");
  writeNodeCommandShim(path.join(binDir, "gh"), ghJsPath);

  fs.writeFileSync(
    whichJsPath,
    [
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'docker') {",
      "  process.stdout.write(path.join(__dirname, process.platform === 'win32' ? 'docker.cmd' : 'docker') + '\\n');",
      "  process.exit(0);",
      "}",
      "process.exit(1);"
    ].join("\n"),
    "utf8"
  );
  writeNodeCommandShim(path.join(binDir, "which"), whichJsPath);

  return {
    repoDir,
    binDir,
    logPath,
    envFileLogPath,
    readDockerCalls() {
      if (!fs.existsSync(logPath)) {
        return [];
      }
      return fs.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => dockerCommandArgs(JSON.parse(line) as string[]));
    },
    readRawDockerCalls() {
      if (!fs.existsSync(logPath)) {
        return [];
      }
      return fs.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    readCapturedEnvFiles() {
      if (!fs.existsSync(envFileLogPath)) {
        return [];
      }
      return fs.readFileSync(envFileLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { content: string }).content);
    }
  };
}

export {
  writeNodeCommandShim,
  writeSandboxEngineFixture
};
