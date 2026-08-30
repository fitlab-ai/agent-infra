import fs from "node:fs";
import path from "node:path";
import { initIsolatedGitRepo } from "./git.ts";
import { createSandboxCapabilityPlan } from "../../lib/sandbox/agent-client-reconciler.ts";
import { listAgentClientAdapters } from "../../lib/agent-clients/registry.ts";
import { AGENT_CLIENT_IDS } from "../../lib/agent-clients/types.ts";
import type { AgentClientState } from "../../lib/agent-clients/types.ts";
import { parseCustomTools } from "../../lib/sandbox/tools.ts";

type SandboxFixtureOptions = {
  project?: string;
  org?: string;
  sandbox?: Record<string, unknown>;
  agentClients?: unknown;
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

function sandboxRow(name: string, branch: string, project = "demo"): string {
  return `${name}\tUp 1 minute\t${project}.sandbox.branch=${branch},${project}.sandbox=true`;
}

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
    agentClients,
    dockerStdoutForPs = "",
    dockerLabelsForInspect = {}
  }: SandboxFixtureOptions = {}
): SandboxFixture {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "docker-log.jsonl");
  const envFileLogPath = path.join(tmpDir, "docker-env-files.jsonl");
  const dockerStatePath = path.join(tmpDir, "docker-state.txt");
  const dockerJsPath = path.join(binDir, "docker.js");
  const idJsPath = path.join(binDir, "id.js");
  const whichJsPath = path.join(binDir, "which.js");
  const ghJsPath = path.join(binDir, "gh.js");
  const fixtureHome = "__AGENT_INFRA_FIXTURE_HOME__";
  const agentClientFixtures = listAgentClientAdapters().map((adapter) => {
    const tool = adapter.sandbox.createTool({ home: fixtureHome, project });
    return {
      id: adapter.id,
      containerMount: tool.containerMount,
      hostLiveMounts: tool.hostLiveMounts ?? [],
      tmpfs: tool.tmpfs ?? null
    };
  });

  fs.mkdirSync(path.join(repoDir, ".agents"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(dockerStatePath, dockerStdoutForPs, "utf8");
  initIsolatedGitRepo(repoDir);
  const configuredSandbox = Array.isArray(sandbox.tools)
    ? {
      ...sandbox,
      tools: sandbox.tools.filter((tool) =>
        typeof tool === "string" && !AGENT_CLIENT_IDS.some((id) => id === tool))
    }
    : sandbox;
  const selectedClientIds = new Set(
    Array.isArray(sandbox.tools)
      ? sandbox.tools.filter((tool): tool is string =>
        typeof tool === "string" && AGENT_CLIENT_IDS.some((id) => id === tool))
      : []
  );
  const configuredAgentClients = agentClients ?? AGENT_CLIENT_IDS.map((id) => ({
    id,
    enabled: true,
    installInSandbox: selectedClientIds.size === 0 || selectedClientIds.has(id)
  }));
  const configuredAgentClientState = Object.fromEntries(
    (configuredAgentClients as Array<{ id: string; enabled: boolean; installInSandbox: boolean }>).map((entry) => [
      entry.id,
      { enabled: entry.enabled, installInSandbox: entry.installInSandbox }
    ])
  ) as AgentClientState;
  const configuredToolIds = Array.isArray(configuredSandbox.tools)
    ? configuredSandbox.tools.filter((tool): tool is string => typeof tool === "string")
    : ["agent-infra"];
  const configuredCustomTools = parseCustomTools(configuredSandbox.customTools, { home: "/home/devuser" });
  const runtimeCapabilitySignature = createSandboxCapabilityPlan({
    home: "/home/devuser",
    project,
    tools: configuredToolIds,
    customTools: configuredCustomTools,
    agentClientState: configuredAgentClientState
  }).runtimeSignature;
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
      agentClients: configuredAgentClients,
      sandbox: {
        ...configuredSandbox,
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
      "const crypto = require('node:crypto');",
      `const project = ${JSON.stringify(project)};`,
      `const sandboxConfig = ${JSON.stringify(sandbox)};`,
      `const dockerStdoutForPs = ${JSON.stringify(dockerStdoutForPs)};`,
      `const dockerStatePath = ${JSON.stringify(dockerStatePath)};`,
      `const removedContainersPath = ${JSON.stringify(`${dockerStatePath}.removed`)};`,
      `const dockerLabelsForInspect = ${JSON.stringify(dockerLabelsForInspect)};`,
      `const fixtureHome = ${JSON.stringify(fixtureHome)};`,
      `const agentClientFixtures = ${JSON.stringify(agentClientFixtures)};`,
      `const runtimeCapabilitySignature = ${JSON.stringify(runtimeCapabilitySignature)};`,
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
      "function dockerRows() {",
      "  try { return fs.readFileSync(dockerStatePath, 'utf8').trim().split('\\n').filter(Boolean); } catch { return []; }",
      "}",
      "function removedContainers() {",
      "  try { return new Set(fs.readFileSync(removedContainersPath, 'utf8').split('\\n').filter(Boolean)); } catch { return new Set(); }",
      "}",
      "function rememberRemoved(container) {",
      "  if (container) fs.appendFileSync(removedContainersPath, `${container}\\n`);",
      "}",
      "function setContainerStatus(name, status) {",
      "  const rows = dockerRows().map((row) => {",
      "    const columns = row.split('\\t');",
      "    return columns[0] === name ? [columns[0], status, ...columns.slice(2)].join('\\t') : row;",
      "  });",
      "  fs.writeFileSync(dockerStatePath, rows.join('\\n'), 'utf8');",
      "}",
      "function inspectLabels(containerName = '') {",
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
      "  if (Object.keys(labels).length > 0) return { ...labels, [`agent-infra.sandbox.runtime-capability.${project}`]: runtimeCapabilitySignature };",
      "  const row = dockerRows().find((candidate) => candidate.split('\\t')[0] === containerName) || dockerRows()[0] || '';",
      "  const columns = row.split('\\t');",
      "  const branchKey = `${project}.sandbox.branch`;",
      "  const labelColumn = columns[2] || '';",
      "  const columnLabels = Object.fromEntries(labelColumn.split(',').flatMap((label) => { const separator = label.indexOf('='); return separator < 0 ? [] : [[label.slice(0, separator), label.slice(separator + 1)]]; }));",
      "  const labelledBranch = columnLabels[branchKey];",
      "  const branchOnly = { [`${project}.sandbox.workspace-mode`]: 'branch-only' };",
      "  if (labelledBranch) return { ...branchOnly, ...columnLabels, [`agent-infra.sandbox.runtime-capability.${project}`]: runtimeCapabilitySignature };",
      "  if (labelColumn && !labelColumn.includes('=')) return { [branchKey]: labelColumn, ...branchOnly, [`agent-infra.sandbox.runtime-capability.${project}`]: runtimeCapabilitySignature };",
      "  const prefix = `${project}-dev-`;",
      "  const name = columns[0] || '';",
      "  if (!name.startsWith(prefix)) return {};",
      "  const branch = name.slice(prefix.length).replace(/\\.\\./g, '/');",
      "  return { [branchKey]: branch, ...branchOnly, [`agent-infra.sandbox.runtime-capability.${project}`]: runtimeCapabilitySignature };",
      "}",
      "function inspectMounts() {",
      "  const calls = loggedCalls();",
      "  const runCall = calls.map((call) => call[0] === '--context' ? call.slice(2) : call).reverse().find((call) => call[0] === 'run');",
      "  if (!runCall) {",
      "    const branch = inspectLabels()[`${project}.sandbox.branch`] || '';",
      "    const branchDir = branch.replace(/\\//g, '..');",
      "    const home = process.env.HOME || process.env.USERPROFILE || '';",
      "    const labels = inspectLabels();",
      "    const mode = labels[`${project}.sandbox.workspace-mode`] || 'branch-only';",
      "    const taskId = labels[`${project}.sandbox.task-id`] || null;",
      "    const digest = crypto.createHash('sha256').update(taskId ? `task-bound:${taskId}` : 'branch-only').digest('hex').slice(0, 16);",
      "    const container = `${project}-dev-${branchDir}`;",
      "    const view = path.join(home, '.agent-infra', 'workspace-views', project, container, digest);",
      "    const controlRoot = path.join(home, '.agent-infra', 'sandbox-control', project, container, digest);",
      "    const control = path.join(controlRoot, 'channel');",
      "    const workspaceMounts = mode === 'task-bound'",
      "      ? [",
      "        { Type: 'bind', Source: path.join(view, 'active', '.short-ids.json'), Destination: '/workspace/.agents/workspace/active/.short-ids.json', RW: false },",
      "        ...['completed', 'blocked', 'archive'].map((state) => ({",
      "          Type: 'bind',",
      "          Source: path.join(view, state),",
      "          Destination: path.posix.join('/workspace/.agents/workspace', state),",
      "          RW: false",
      "        }))",
      "      ]",
      "      : ['active', 'completed', 'blocked', 'archive'].map((state) => ({",
      "        Type: 'bind',",
      "        Source: path.join(view, state),",
      "        Destination: path.posix.join('/workspace/.agents/workspace', state),",
      "        RW: false",
      "      }));",
      "    const defaults = [",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'worktrees', project, branchDir), Destination: '/workspace', RW: true },",
      "      ...workspaceMounts,",
      "      ...(mode === 'task-bound' ? [{ Type: 'bind', Source: path.join(process.cwd(), '.agents', 'workspace', 'active', taskId), Destination: `/workspace/.agents/workspace/active/${taskId}`, RW: true }] : []),",
      "      { Type: 'bind', Source: control, Destination: '/run/agent-infra/control', RW: true },",
      "      { Type: 'bind', Source: path.join(controlRoot, 'public'), Destination: '/run/agent-infra/control-status', RW: false },",
      "      ...(mode === 'task-bound' ? [{ Type: 'bind', Source: path.join(controlRoot, 'runtime'), Destination: '/run/agent-infra/runtime', RW: true }] : []),",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'share', project, 'common'), Destination: '/share/common', RW: true },",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'share', project, 'branches', branchDir), Destination: '/share/branch', RW: true },",
      "      { Type: 'bind', Source: path.join(home, '.agent-infra', 'config', project, branchDir), Destination: '/home/devuser/.host-shell-config', RW: false }",
      "    ];",
      "    const selectedTools = Array.isArray(sandboxConfig.tools)",
      "      ? sandboxConfig.tools",
      "      : ['agent-infra', ...agentClientFixtures.map(({ id }) => id)];",
      "    for (const toolId of selectedTools) {",
      "      if (toolId === 'agent-infra') defaults.push({ Type: 'bind', Source: path.join(home, '.agent-infra', 'sandboxes', 'agent-infra', project, branchDir), Destination: '/home/devuser/.agent-infra-cli', RW: true });",
      "      const fixture = agentClientFixtures.find(({ id }) => id === toolId);",
      "      if (!fixture) continue;",
      "      if (!fixture.tmpfs) defaults.push({ Type: 'bind', Source: path.join(home, '.agent-infra', 'sandboxes', toolId, project, branchDir), Destination: fixture.containerMount, RW: true });",
      "      if (fixture.tmpfs) defaults.push({ Type: 'tmpfs', Source: '', Destination: fixture.containerMount, RW: true });",
      "      for (const live of fixture.hostLiveMounts) {",
      "        const source = live.hostPath.replace(fixtureHome, home);",
      "        const destination = path.posix.join(fixture.containerMount, live.containerSubpath);",
      "        if (fs.existsSync(source)) defaults.push({ Type: 'bind', Source: source, Destination: destination, RW: true });",
      "      }",
      "    }",
      "    for (const mount of defaults.filter((mount) => mount.Type === 'bind' && !fs.existsSync(mount.Source))) {",
      "      fs.mkdirSync(path.dirname(mount.Source), { recursive: true });",
      "      if (mount.Destination === '/workspace/.agents/workspace/active/.short-ids.json') fs.writeFileSync(mount.Source, '{}\\n');",
      "      else fs.mkdirSync(mount.Source, { recursive: true });",
      "    }",
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
      "  const rows = dockerRows();",
      "  const formatIndex = args.indexOf('--format');",
      "  const outputRows = formatIndex >= 0 && args[formatIndex + 1] === '{{.Names}}'",
      "    ? rows.map((row) => row.split('\\t')[0])",
      "    : rows;",
      "  if (outputRows.length > 0) {",
      "    process.stdout.write(`${outputRows.join('\\n')}\\n`);",
      "  }",
      "  if (process.env.DOCKER_EXIT_FOR_PS) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_PS));",
      "  }",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'rm' && args[1]) {",
      "  const remaining = dockerRows().filter((row) => row.split('\\t')[0] !== args[1]);",
      "  fs.writeFileSync(dockerStatePath, remaining.join('\\n'), 'utf8');",
      "  if (process.env.DOCKER_REMOVAL_UPDATES_INSPECT === '1') rememberRemoved(args[1]);",
      "  if (process.env.DOCKER_EXIT_FOR_RM) process.exit(Number(process.env.DOCKER_EXIT_FOR_RM));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'stop' && process.env.DOCKER_STOP_REQUIRES_BOUNDED_GRACE === '1' && !args.includes('--timeout')) {",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000);",
      "}",
      "if (args[0] === 'stop' && args[1]) {",
      "  if (process.env.DOCKER_EXIT_FOR_STOP) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_STOP));",
      "  }",
      "  setContainerStatus(args[1], 'Exited (0) 1 second ago');",
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
      "  if (process.env.DOCKER_INSPECT_NOT_FOUND === '1') { process.stderr.write('No such container\\n'); process.exit(1); }",
      "  if (process.env.DOCKER_REMOVAL_UPDATES_INSPECT === '1' && removedContainers().has(args.at(-1))) { process.stderr.write('No such container\\n'); process.exit(1); }",
      "  if (args[1] === '-f' && args[2] && String(args[2]).includes(`${project}.sandbox.branch`)) {",
      "    process.stdout.write(`${inspectLabels(args.at(-1))[`${project}.sandbox.branch`] || ''}\\n`);",
      "    process.exit(0);",
      "  }",
      "  const formatIndex = args.indexOf('--format');",
      "  if (formatIndex >= 0 && args[formatIndex + 1] === '{{json .Config.Labels}}') {",
      "    process.stdout.write(`${JSON.stringify(inspectLabels(args.at(-1)))}\\n`);",
      "    process.exit(0);",
      "  }",
      "  const payload = process.env.DOCKER_INSPECT_JSON",
      "    ? JSON.parse(process.env.DOCKER_INSPECT_JSON)",
      "    : [{ Id: 'fixture-container-id', State: { Running: true }, Config: { Labels: inspectLabels(args.at(-1)) }, Mounts: process.env.DOCKER_INSPECT_NO_MOUNTS === '1' ? [] : inspectMounts() }];",
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
      "if (args[0] === 'start' && args[1]) {",
      "  if (process.env.DOCKER_EXIT_FOR_START) {",
      "    process.exit(Number(process.env.DOCKER_EXIT_FOR_START));",
      "  }",
      "  setContainerStatus(args[1], 'Up 1 second');",
      "  process.exit(0);",
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
  sandboxRow,
  writeNodeCommandShim,
  writeSandboxEngineFixture
};
