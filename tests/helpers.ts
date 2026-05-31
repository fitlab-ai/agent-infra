import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

type TestPlatform = "linux" | "darwin" | "win32";
type Replacements = {
  project: string;
  org: string;
};
type Frontmatter = {
  name: string;
  description: string;
};
type CommandSpec = {
  usage?: string;
  en?: string;
  zh?: string;
};
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
type RegistryEntry = {
  entry: string;
  list?: string;
};
type SyncTemplatesReport = {
  templateRoot: string;
  templateVersion: string;
  configUpdated: boolean;
  templateSources: {
    configured: number;
    loaded: number;
    files: number;
    errors: Array<Record<string, unknown>>;
    conflicts: Array<Record<string, unknown>>;
  };
  registryAdded: RegistryEntry[];
  managed: {
    created: string[];
    removed: string[];
    written: string[];
    unchanged: string[];
    skippedMerged: string[];
  };
  merged: {
    pending: Array<{ target: string }>;
  };
  ejected: {
    preserved: string[];
    missing: string[];
    created: string[];
    skipped: string[];
  };
  custom: {
    detected: string[];
    generated: string[];
    removed: string[];
    sourceErrors: Array<Record<string, unknown>>;
    commands: {
      generated: string[];
      updated: string[];
      unchanged: string[];
    };
    customTUIs: {
      skipped: string[];
      skippedRefs: string[];
    };
  };
};
type SyncTemplatesModule = {
  syncTemplates(projectRoot: string, templateRootOverride?: string): SyncTemplatesReport;
};
type PlatformSyncModule = {
  getDefaults(): {
    statusLabels: {
      inProgress: string;
      pendingDesignWork: string;
      waitingForTriage: string;
    };
    markers: Record<string, string>;
    labels: {
      status: string[];
      type: string[];
      priority: string[];
      area: string[];
      special: string[];
    };
    milestones: Array<Record<string, unknown>>;
  };
  check(context: unknown, shared: unknown): unknown;
};

// =====================================================================
// CRITICAL: tests that spawn real `git` commands MUST use gitSafeEnv()
// ---------------------------------------------------------------------
// When `npm test` is invoked from a context that exports GIT_DIR,
// GIT_INDEX_FILE, GIT_WORK_TREE, or similar variables, child `git`
// processes inherit those vars and operate on the outer repository even
// when `cwd` points at a temp directory.
//
// Real-world incident on this repo (2026-04-29): a sandbox signing-key
// test leaked LOCAL-KEY-123 and core.bare=true into agent-infra's own
// .git/config, breaking GPG signing and repository discovery.
//
// Tests that exec/spawn `git` must pass env: gitSafeEnv(), or use
// initIsolatedGitRepo() for repo bootstrap.
// =====================================================================

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const realPlatform = process.platform;

function filePath(relativePath: string): string {
  const directPath = path.join(rootDir, relativePath);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  if (relativePath.endsWith(".js")) {
    const tsPath = path.join(rootDir, `${relativePath.slice(0, -3)}.ts`);
    if (fs.existsSync(tsPath)) {
      return tsPath;
    }
  }
  return directPath;
}

const CLI_PATH = filePath("dist/bin/cli.js");

function cliArgs(...args: string[]): string[] {
  return [CLI_PATH, ...args];
}

function cliCommand(...args: string[]): string {
  return [process.execPath, ...cliArgs(...args)].map((part) => JSON.stringify(part)).join(" ");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(filePath(relativePath));
}

function read(relativePath: string): string {
  return fs.readFileSync(filePath(relativePath), "utf8");
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

function gitSafeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_DATE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR"
  ]) {
    delete env[key];
  }
  return env;
}

function withGitSafeProcessEnv<T>(fn: () => T, extra: NodeJS.ProcessEnv = {}): T {
  const previousEnv = process.env;
  process.env = gitSafeEnv(extra);

  try {
    const result = fn();
    // Test helpers only need native Promise support; custom thenables are out of scope.
    if (result instanceof Promise) {
      return result.finally(() => {
        process.env = previousEnv;
      }) as T;
    }
    process.env = previousEnv;
    return result;
  } catch (error) {
    process.env = previousEnv;
    throw error;
  }
}

function initIsolatedGitRepo(repoRoot: string, { remote = null }: { remote?: string | null } = {}): void {
  const env = gitSafeEnv();
  const initResult = spawnSync("git", ["init", "-q", "-b", "main"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  if (initResult.status !== 0) {
    throw new Error(`git init failed: ${initResult.stderr}`);
  }

  if (remote) {
    const remoteResult = spawnSync("git", ["remote", "add", "origin", remote], {
      cwd: repoRoot,
      encoding: "utf8",
      env
    });
    if (remoteResult.status !== 0) {
      throw new Error(`git remote add failed: ${remoteResult.stderr}`);
    }
  }
}

function supportsPosixModeBits(): boolean {
  return realPlatform !== "win32";
}

function assertModeBits(filePathname: string, expectedMode: number): void {
  if (!supportsPosixModeBits()) {
    return;
  }

  const actualMode = fs.statSync(filePathname).mode & 0o777;
  assertEqual(actualMode, expectedMode);
}

/**
 * Restrict a node:test case to the listed Node.js process.platform values.
 *
 * Use this as the test options argument: test(name, onPlatforms("linux", "darwin"), fn).
 * Allowed values are "linux", "darwin", and "win32". Do not use early returns
 * such as `if (process.platform === "...") return;` to skip a whole test body.
 *
 * Branching on process.platform inside a test remains valid when the same test
 * intentionally covers platform-specific assertions or fixture construction.
 */
function onPlatforms(...allowed: TestPlatform[]): { skip: false | string } {
  return {
    skip: allowed.includes(process.platform as TestPlatform)
      ? false
      : `requires ${allowed.join("/")} (current: ${process.platform})`
  };
}

function assertEqual(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`Expected mode ${expected.toString(8)}, got ${actual.toString(8)}`);
  }
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
    dockerStdoutForPs = ""
  }: SandboxFixtureOptions = {}
): SandboxFixture {
  const repoDir = path.join(tmpDir, "repo");
  const binDir = path.join(tmpDir, "bin");
  const logPath = path.join(tmpDir, "docker-log.jsonl");
  const dockerJsPath = path.join(binDir, "docker.js");
  const idJsPath = path.join(binDir, "id.js");
  const whichJsPath = path.join(binDir, "which.js");

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
      "  process.exit(1);",
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

function listFilesRecursive(relativeDir: string): string[] {
  const entries = fs.readdirSync(filePath(relativeDir), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(relativePath);
    }
    return [relativePath];
  });
}

function listSkillNames(): string[] {
  return fs.readdirSync(filePath(".agents/skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function langTemplate(basePath: string, lang: string): string {
  const ext = path.extname(basePath);
  const variant = /\.(?:en|zh-CN)(?=\.[^.]+$)/.test(basePath)
    ? basePath.replace(/\.(?:en|zh-CN)(?=\.[^.]+$)/, `.${lang}`)
    : basePath.replace(ext, `.${lang}${ext}`);
  if (exists(variant)) {
    return variant;
  }

  return basePath;
}

function renderPlaceholders(content: string, replacements: Replacements): string {
  return content
    .replace(/\{\{project\}\}/g, replacements.project)
    .replace(/\{\{org\}\}/g, replacements.org);
}

function buildCommandSyncFiles(project: string): [string, string][] {
  return listSkillNames().flatMap((skill) => [
    [`.claude/commands/${skill}.md`, `templates/.claude/commands/${skill}.en.md`],
    [`.opencode/commands/${skill}.md`, `templates/.opencode/commands/${skill}.en.md`],
    [`.gemini/commands/${project}/${skill}.toml`, `templates/.gemini/commands/_project_/${skill}.en.toml`]
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadFreshEsm<T = Record<string, unknown>>(relativePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(filePath(relativePath));
  moduleUrl.searchParams.set("v", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return import(moduleUrl.href) as Promise<T>;
}

function parseFrontmatter(relativePath: string): Frontmatter | null {
  const content = read(relativePath);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!match) {
    return null;
  }

  const lines = (match[1] ?? "").split(/\r?\n/);
  let name = "";
  let description = "";

  const normalizeValue = (value: string): string => value.replace(/^["']|["']$/g, "").trim();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("name:")) {
      name = normalizeValue(line.slice("name:".length).trim());
      continue;
    }

    if (!line.startsWith("description:")) {
      continue;
    }

    const value = line.slice("description:".length).trim();
    if (value === ">") {
      const descriptionLines: string[] = [];

      for (let offset = index + 1; offset < lines.length; offset += 1) {
        const descriptionLine = lines[offset] ?? "";
        if (!/^\s+/.test(descriptionLine)) {
          break;
        }

        descriptionLines.push(descriptionLine.trim());
        index = offset;
      }

      description = descriptionLines.join(" ").trim();
      continue;
    }

    description = normalizeValue(value);
  }

  return { name, description };
}

function skillDocPaths(skill: string): string[] {
  return [
    `.agents/skills/${skill}/SKILL.md`,
    `templates/.agents/skills/${skill}/SKILL.en.md`,
    `templates/.agents/skills/${skill}/SKILL.zh-CN.md`
  ].filter(exists);
}

const commandSpecs: Record<string, CommandSpec> = {
  "analyze-task": {
    usage: "<task-id>",
    en: "Analyze task $1.",
    zh: "分析任务 $1。"
  },
  "archive-tasks": {
    usage: "[--days N | --before YYYY-MM-DD | TASK-ID...]",
    en: "Archive completed tasks: $ARGUMENTS",
    zh: "归档已完成任务：$ARGUMENTS"
  },
  "import-codescan": {
    usage: "<alert-number>",
    en: "Import CodeQL alert #$1.",
    zh: "导入 CodeQL 告警 #$1。"
  },
  "import-dependabot": {
    usage: "<alert-number>",
    en: "Import Dependabot alert #$1.",
    zh: "导入 Dependabot 告警 #$1。"
  },
  "import-issue": {
    usage: "<issue-number>",
    en: "Import Issue #$1.",
    zh: "导入 Issue #$1。"
  },
  "block-task": {
    usage: "<task-id> [reason]",
    en: "Block task: $ARGUMENTS",
    zh: "阻塞任务：$ARGUMENTS"
  },
  "cancel-task": {
    usage: "<task-id> <reason>",
    en: "Cancel task: $ARGUMENTS",
    zh: "取消任务：$ARGUMENTS"
  },
  "check-task": {
    usage: "<task-id>",
    en: "Check status of task $1.",
    zh: "查看任务 $1 的状态。"
  },
  commit: {},
  "close-codescan": {
    usage: "<alert-number>",
    en: "Close CodeQL alert #$1.",
    zh: "关闭 CodeQL 告警 #$1。"
  },
  "close-dependabot": {
    usage: "<alert-number>",
    en: "Close Dependabot alert #$1.",
    zh: "关闭 Dependabot 告警 #$1。"
  },
  "complete-task": {
    usage: "<task-id>",
    en: "Complete task $1.",
    zh: "完成任务 $1。"
  },
  "create-pr": {
    usage: "[task-id] [target-branch]",
    en: "Create PR: $ARGUMENTS",
    zh: "创建 PR：$ARGUMENTS"
  },
  "create-release-note": {
    usage: "<ver> [prev]",
    en: "Generate release note: $ARGUMENTS",
    zh: "生成发布说明：$ARGUMENTS"
  },
  "create-task": {
    usage: "<description>",
    en: "Task description: $ARGUMENTS",
    zh: "任务描述：$ARGUMENTS"
  },
  "init-labels": {},
  "init-milestones": {
    usage: "[--history]",
    en: "Initialize milestones: $ARGUMENTS",
    zh: "初始化里程碑：$ARGUMENTS"
  },
  "implement-task": {
    usage: "<task-id>",
    en: "Implement task $1.",
    zh: "实施任务 $1。"
  },
  "plan-task": {
    usage: "<task-id>",
    en: "Design plan for task $1.",
    zh: "为任务 $1 设计方案。"
  },
  "post-release": {},
  "refine-task": {
    usage: "<task-id>",
    en: "Refine task $1.",
    zh: "修复任务 $1 的审查问题。"
  },
  "refine-title": {
    usage: "<number>",
    en: "Refine title of #$1.",
    zh: "优化 #$1 的标题。"
  },
  release: {
    usage: "<version>",
    en: "Release version $1.",
    zh: "发布版本 $1。"
  },
  "review-task": {
    usage: "<task-id>",
    en: "Review task $1.",
    zh: "审查任务 $1。"
  },
  "restore-task": {
    usage: "<issue-number> [task-id]",
    en: "Restore task from Issue: $ARGUMENTS",
    zh: "从 Issue 还原任务：$ARGUMENTS"
  },
  test: {},
  "test-integration": {},
  "update-agent-infra": {},
  "upgrade-dependency": {
    usage: "<pkg> <from> <to>",
    en: "Upgrade dependency: $ARGUMENTS",
    zh: "升级依赖：$ARGUMENTS"
  }
};

export {
  buildCommandSyncFiles,
  CLI_PATH,
  commandSpecs,
  cliArgs,
  cliCommand,
  envWithPrependedPath,
  escapeRegExp,
  exists,
  filePath,
  gitSafeEnv,
  assertModeBits,
  initIsolatedGitRepo,
  langTemplate,
  listFilesRecursive,
  listSkillNames,
  loadFreshEsm,
  parseFrontmatter,
  pathWithPrependedBin,
  read,
  renderPlaceholders,
  onPlatforms,
  supportsPosixModeBits,
  withGitSafeProcessEnv,
  writeSandboxEngineFixture,
  writeNodeCommandShim,
  skillDocPaths
};

export type {
  PlatformSyncModule,
  SyncTemplatesModule,
  SyncTemplatesReport
};
