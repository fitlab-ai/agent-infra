import fs from "node:fs";
import path from "node:path";
import { initIsolatedGitRepo } from "./git.ts";

type SandboxFixtureOptions = {
  project?: string;
  org?: string;
  sandbox?: Record<string, unknown>;
  dockerStdoutForPs?: string;
};
type SandboxFixture = {
  repoDir: string;
  binDir: string;
  logPath: string;
  readDockerCalls(): string[][];
};

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
    dockerStdoutForPs = ""
  }: SandboxFixtureOptions = {}
): SandboxFixture {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "docker-log.jsonl");
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
      "const args = process.argv.slice(2);",
      "function log() {",
      "  fs.appendFileSync(process.env.DOCKER_LOG_PATH, JSON.stringify(args) + '\\n');",
      "}",
      "log();",
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
      "  if (process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_IMAGE_INSPECT));",
      "  }",
      "  process.exit(1);",
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
    readDockerCalls() {
      if (!fs.existsSync(logPath)) {
        return [];
      }
      return fs.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    }
  };
}

export {
  writeNodeCommandShim,
  writeSandboxEngineFixture
};
