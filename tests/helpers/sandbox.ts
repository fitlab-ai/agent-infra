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
      "const path = require('node:path');",
      `const project = ${JSON.stringify(project)};`,
      `const sandboxConfig = ${JSON.stringify(sandbox)};`,
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
      "function parseMountSpec(spec) {",
      "  const parts = spec.split(':');",
      "  const last = parts.at(-1) || '';",
      "  let options = [];",
      "  if (['ro', 'rw', 'z', 'Z'].every((option) => last.split(',').every((value) => ['ro', 'rw', 'z', 'Z'].includes(value)))) {",
      "    options = parts.pop().split(',');",
      "  }",
      "  const destination = parts.pop() || '';",
      "  return { source: parts.join(':'), destination, options };",
      "}",
      "function loggedCalls() {",
      "  return fs.existsSync(process.env.DOCKER_LOG_PATH)",
      "    ? fs.readFileSync(process.env.DOCKER_LOG_PATH, 'utf8').trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line))",
      "    : [];",
      "}",
      "function inspectLabels() {",
      "  const runCall = loggedCalls().map((call) => call[0] === '--context' ? call.slice(2) : call).reverse().find((call) => call[0] === 'run');",
      "  const labels = {};",
      "  if (runCall) {",
      "    for (let index = 0; index < runCall.length; index += 1) {",
      "      if (runCall[index] !== '--label' || !runCall[index + 1]) continue;",
      "      const raw = String(runCall[index + 1]);",
      "      const separator = raw.indexOf('=');",
      "      labels[separator < 0 ? raw : raw.slice(0, separator)] = separator < 0 ? '' : raw.slice(separator + 1);",
      "    }",
      "  }",
      "  if (Object.keys(labels).length > 0) return labels;",
      "  const row = dockerStdoutForPs.trim().split('\\n')[0] || '';",
      "  const columns = row.split('\\t');",
      "  const branchKey = `${project}.sandbox.branch`;",
      "  const labelColumn = columns[2] || '';",
      "  const labelledBranch = labelColumn.split(',').find((label) => label.startsWith(`${branchKey}=`));",
      "  if (labelledBranch) return { [branchKey]: labelledBranch.slice(branchKey.length + 1) };",
      "  if (labelColumn && !labelColumn.includes('=')) return { [branchKey]: labelColumn };",
      "  const prefix = `${project}-dev-`;",
      "  const name = columns[0] || '';",
      "  return name.startsWith(prefix) ? { [branchKey]: name.slice(prefix.length).replace(/\\.\\./g, '/') } : {};",
      "}",
      "function inspectMounts() {",
      "  const calls = loggedCalls();",
      "  const runCall = calls.map((call) => call[0] === '--context' ? call.slice(2) : call).reverse().find((call) => call[0] === 'run');",
      "  if (!runCall) {",
      "    const branch = inspectLabels()[`${project}.sandbox.branch`] || '';",
      "    const branchDir = branch.replace(/\\//g, '..');",
      "    const home = process.env.HOME || process.env.USERPROFILE || '';",
      "    const defaults = [",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'worktrees', project, branchDir), Destination: '/workspace', RW: true },",
      "      { Type: 'bind', Source: path.join(process.cwd(), '.agents', 'workspace'), Destination: '/workspace/.agents/workspace', RW: true },",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'share', project, 'common'), Destination: '/share/common', RW: true },",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'share', project, 'branches', branchDir), Destination: '/share/branch', RW: true },",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'config', project, branchDir), Destination: '/home/devuser/.host-shell-config', RW: false },",
      "      { Type: 'tmpfs', Source: '', Destination: '/home/devuser/.codex', RW: true }",
      "    ];",
      "    const selectedTools = Array.isArray(sandboxConfig.tools)",
      "      ? sandboxConfig.tools",
      "      : ['agent-infra', 'claude-code', 'codex', 'gemini-cli', 'opencode'];",
      "    const builtinLiveMounts = {",
      "      'claude-code': [path.join(home, '.agent-infra', 'credentials', project, 'claude-code', '.credentials.json'), '/home/devuser/.claude/.credentials.json'],",
      "      codex: [path.join(home, '.codex', 'auth.json'), '/home/devuser/.codex/auth.json'],",
      "      'gemini-cli': [path.join(home, '.gemini', 'oauth_creds.json'), '/home/devuser/.gemini/oauth_creds.json'],",
      "      opencode: [path.join(home, '.local', 'share', 'opencode', 'auth.json'), '/home/devuser/.local/share/opencode/auth.json']",
      "    };",
      "    for (const toolId of selectedTools) {",
      "      const live = builtinLiveMounts[toolId];",
      "      if (live && fs.existsSync(live[0])) defaults.push({ Type: 'bind', Source: live[0], Destination: live[1], RW: true });",
      "    }",
      "    for (const mount of defaults.filter((mount) => mount.Type === 'bind' && !fs.existsSync(mount.Source))) fs.mkdirSync(mount.Source, { recursive: true });",
      "    return defaults;",
      "  }",
      "  const mounts = [];",
      "  for (let index = 0; index < runCall.length; index += 1) {",
      "    if (runCall[index] === '--tmpfs' && runCall[index + 1]) {",
      "      mounts.push({ Type: 'tmpfs', Source: '', Destination: String(runCall[index + 1]).split(':')[0], RW: true });",
      "    }",
      "    if (runCall[index] === '-v' && runCall[index + 1]) {",
      "      const spec = String(runCall[index + 1]);",
      "      const parsed = parseMountSpec(spec);",
      "      mounts.push({ Type: 'bind', Source: parsed.source, Destination: parsed.destination, RW: !parsed.options.includes('ro') });",
      "    }",
      "  }",
      "  return mounts;",
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
      "if (args[0] === 'inspect') {",
      "  const payload = process.env.DOCKER_INSPECT_JSON",
      "    ? JSON.parse(process.env.DOCKER_INSPECT_JSON)",
      "    : [{ Id: 'fixture-container-id', State: { Running: true }, Config: { Labels: inspectLabels() }, Mounts: inspectMounts() }];",
      "  process.stdout.write(`${JSON.stringify(payload)}\\n`);",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'build' && process.env.DOCKER_EXIT_FOR_BUILD) {",
      "  process.exit(Number(process.env.DOCKER_EXIT_FOR_BUILD));",
      "}",
      "if (args[0] === 'buildx' && args[1] === 'inspect' && process.env.DOCKER_EXIT_FOR_BUILDX_INSPECT) {",
      "  process.exit(Number(process.env.DOCKER_EXIT_FOR_BUILDX_INSPECT));",
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
