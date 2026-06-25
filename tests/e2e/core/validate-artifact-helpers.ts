import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  filePath,
  gitSafeEnv,
  initIsolatedGitRepo,
  pathWithPrependedBin,
  read,
  writeNodeCommandShim
} from "../../helpers.ts";

const scriptPath = filePath(".agents/scripts/validate-artifact.js");

type FrontmatterOverrides = Record<string, string | number | boolean | null | undefined>;
type FixtureReplacements = Record<string, string | number | boolean | null | undefined>;
type TaskCommentOptions = {
  summaryText?: string;
  rawBody?: boolean;
};
type IssuePayloadOverrides = Record<string, unknown>;
type PlatformSyncConfig = Record<string, unknown>;
type ValidatorOptions = {
  env?: NodeJS.ProcessEnv;
  fakeGhPath?: string;
};
type ValidatorCheck = {
  type: string;
  status: string;
  fail_type?: string;
  message?: string;
  warnings?: string[];
};
type ValidatorPayload = {
  gate: string;
  checks: ValidatorCheck[];
  type: string;
  status: string;
  message: string;
  warnings?: string[];
};
type PayloadStatusExpectation = {
  type?: string;
  status?: string;
  message?: RegExp;
};
type PlatformSyncEnv = {
  taskDir: string;
  binDir: string;
  ghPath: string;
  issuePath: string;
  commentsPath: string;
  prPath: string;
  prCommentsPath: string;
  issueFieldsPath: string;
  labelsPath: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};

function parseValidatorPayload(stdout: string): ValidatorPayload {
  return JSON.parse(stdout) as ValidatorPayload;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":") + `${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`;
}

function formatTimestampInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );

  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(date).find(({ type }) => type === "timeZoneName")?.value;
  const normalizedOffset = offsetPart === "GMT" ? "+00:00" : offsetPart?.replace("GMT", "") || "+00:00";

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}${normalizedOffset}`;
}

function write(filePathname: string, content: string) {
  fs.mkdirSync(path.dirname(filePathname), { recursive: true });
  fs.writeFileSync(filePathname, content, "utf8");
}

function writeJson(filePathname: string, value: unknown) {
  write(filePathname, JSON.stringify(value));
}

function buildTaskFrontmatter(overrides: FrontmatterOverrides = {}) {
  const now = new Date();
  const metadata = {
    id: "TASK-20260328-000001",
    type: "refactor",
    workflow: "refactoring",
    status: "active",
    created_at: formatTimestamp(new Date(now.getTime() - 60_000)),
    updated_at: formatTimestamp(now),
    issue_number: "N/A",
    created_by: "human",
    current_step: "code",
    assigned_to: "codex",
    ...overrides
  };

  return [
    "---",
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
    "---"
  ].join("\n");
}

function loadFixture(name: string, replacements: FixtureReplacements = {}) {
  let content = read(path.join("tests/fixtures/validate-artifact", name));

  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(`{{${key}}}`).join(String(value));
  }

  return content;
}

function buildTaskContent(overrides: FrontmatterOverrides = {}, replacements: FixtureReplacements = {}) {
  return loadFixture("valid-task.md", {
    FRONTMATTER: buildTaskFrontmatter(overrides),
    NOW: formatTimestamp(new Date()),
    ...replacements
  });
}

function buildCompletedTaskContent(checklistLines: string[], overrides: FrontmatterOverrides = {}) {
  const now = formatTimestamp(new Date());
  return [
    buildTaskFrontmatter({
      status: "completed",
      current_step: "commit",
      completed_at: now,
      updated_at: now,
      target_date: now.slice(0, 10),
      ...overrides
    }),
    "",
    "# 任务：完成任务校验",
    "",
    "## 需求",
    "",
    "- [x] 保留最新验证输出",
    "",
    "## 状态核对",
    "",
    "```text",
    "$ git status -s",
    "```",
    "",
    "## 活动日志",
    "",
    `- ${now} — **Completed** by codex — Task archived to completed/`,
    "",
    "## 完成检查清单",
    "",
    ...checklistLines
  ].join("\n");
}

function runValidator(args: string[], options: ValidatorOptions = {}): SpawnSyncReturns<string> {
  const env = gitSafeEnv({
    ...(options.fakeGhPath ? {
      AGENT_INFRA_GH_BIN: process.execPath,
      AGENT_INFRA_GH_ARGS_JSON: JSON.stringify([options.fakeGhPath])
    } : {}),
    ...options.env
  });
  if (env.PATH) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") {
        env[key] = env.PATH;
      }
    }
  }

  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd: filePath("."),
    env
  });
}

function writeFakeGh(filePathname: string) {
  write(filePathname, loadFixture("fake-gh.js"));
  if (process.platform === "win32") {
    writeNodeCommandShim(filePathname, filePathname);
    return filePathname;
  }

  fs.chmodSync(filePathname, 0o755);
  return filePathname;
}

function buildArtifactMarker(taskId: string, artifactFile: string) {
  return `<!-- sync-issue:${taskId}:${path.basename(artifactFile, path.extname(artifactFile))} -->`;
}

function buildArtifactComment(taskId: string, artifactFile: string, title: string, body: string) {
  return loadFixture("artifact-comment.md", {
    MARKER: buildArtifactMarker(taskId, artifactFile),
    TITLE: title,
    BODY: body.trim(),
    TASK_ID: taskId,
    AGENT: "codex"
  });
}

function buildTaskComment(taskId: string, taskContent: string, options: TaskCommentOptions = {}) {
  const match = taskContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = match ? taskContent.slice(match[0].length).trim() : taskContent.trim();
  const summaryText = options.summaryText || "元数据 (frontmatter)";
  const detailsBlock = match
    ? [
        `<details><summary>${summaryText}</summary>`,
        "",
        "```yaml",
        match[0].trim(),
        "```",
        "",
        "</details>"
      ].join("\n")
    : "";
  const renderedBody = options.rawBody
    ? taskContent.trim()
    : [detailsBlock, body].filter(Boolean).join("\n\n");

  return loadFixture("task-comment.md", {
    TASK_ID: taskId,
    AGENT: "codex",
    BODY: renderedBody
  });
}

function buildMilestone(title: string = "Sprint 24") {
  return { title };
}

function buildIssueType(name: string = "Task") {
  return { name };
}

function buildIssueFieldsPayload({
  pinnedFields = [
    { typename: "IssueFieldSingleSelect", name: "Priority" },
    { typename: "IssueFieldSingleSelect", name: "Effort" }
  ],
  values = [
    { typename: "IssueFieldSingleSelectValue", fieldName: "Priority", value: "High" },
    { typename: "IssueFieldSingleSelectValue", fieldName: "Effort", value: "Medium" }
  ]
}: {
  pinnedFields?: Array<{ typename: string; name: string }>;
  values?: Array<{ typename: string; fieldName: string; value: string }>;
} = {}) {
  return {
    data: {
      repository: {
        issue: {
          issueType: {
            name: "Feature",
            pinnedFields: pinnedFields.map((field) => ({
              __typename: field.typename,
              id: `field-${field.name}`,
              name: field.name
            }))
          },
          issueFieldValues: {
            nodes: values.map((value) => value.typename === "IssueFieldDateValue"
              ? {
                  __typename: value.typename,
                  value: value.value,
                  field: { name: value.fieldName }
                }
              : {
                  __typename: value.typename,
                  name: value.value,
                  optionId: `option-${value.value}`,
                  field: { name: value.fieldName }
                })
          }
        }
      }
    }
  };
}

function buildIssuePayload(overrides: IssuePayloadOverrides = {}) {
  return {
    state: "OPEN",
    labels: [{ name: "status: in-progress" }],
    body: "# Issue\n\n- [x] 保留最新验证输出\n",
    milestone: buildMilestone(),
    type: buildIssueType(),
    ...overrides
  };
}

function parseTestFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }
  const body = match[1];
  if (body === undefined) {
    return null;
  }

  const metadata: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) {
      continue;
    }
    const key = field[1];
    const value = field[2];
    if (key === undefined || value === undefined) {
      continue;
    }
    metadata[key] = value.trim();
  }

  return metadata;
}

async function runPlatformSyncAdapter(taskDir: string, config: PlatformSyncConfig, env: NodeJS.ProcessEnv = {}) {
  const oldEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    oldEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    const adapter = await import(pathToFileURL(filePath(".agents/scripts/platform-adapters/platform-sync.js")).href);
    return adapter.check({ taskDir, config, artifactFile: undefined }, {
      repoRoot: filePath("."),
      loadTask(dir: string) {
        const taskPath = path.join(dir, "task.md");
        const content = fs.readFileSync(taskPath, "utf8");
        const metadata = parseTestFrontmatter(content);
        if (!metadata) {
          return { ok: false, message: "task.md frontmatter not found or invalid" };
        }
        return { ok: true, content, metadata };
      },
      getCheckedRequirements() {
        return [];
      },
      normalizeContent(value: string) {
        return String(value || "").replace(/\r\n/g, "\n").trim();
      },
      isBlank(value: unknown) {
        return value === undefined || value === null || String(value).trim() === "";
      },
      escapeRegExp(value: string) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      },
      passResult(type: string, message: string) {
        return { type, status: "pass", message };
      },
      failResult(type: string, message: string, failType = "check_failed") {
        return { type, status: "fail", message, fail_type: failType };
      },
      blockedResult(type: string, message: string, failType = "network_error") {
        return { type, status: "blocked", message, fail_type: failType };
      },
      safeStat(filePathname: string) {
        try {
          return fs.statSync(filePathname);
        } catch {
          return null;
        }
      },
      parseIssueNumber(value: unknown) {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : null;
      },
      parsePrNumber(value: unknown) {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 ? number : null;
      }
    });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function buildPrPayload(overrides: IssuePayloadOverrides = {}) {
  return {
    labels: [],
    milestone: buildMilestone(),
    assignees: [{ login: "test-user" }],
    ...overrides
  };
}

function assertPointsToPrSyncRule(filePathname: string) {
  const content = read(filePathname);
  assert.match(content, /`\.agents\/rules\/pr-sync\.md`/);
}

function assertHasCanonicalPrSyncStructure(filePathname: string, headings: RegExp[]) {
  const content = read(filePathname);
  assert.match(content, /<!-- sync-pr:\{task-id\}:summary -->/);
  assert.match(content, /<!-- last-commit: \{git-head-sha\} -->/);
  for (const heading of headings) {
    assert.match(content, heading);
  }
}

function createHeadCommit(repoRoot: string): string {
  const env = gitSafeEnv();
  const emailResult = spawnSync("git", ["config", "user.email", "codex@example.com"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(emailResult.status, 0, emailResult.stderr);

  const nameResult = spawnSync("git", ["config", "user.name", "Codex"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(nameResult.status, 0, nameResult.stderr);

  write(path.join(repoRoot, "README.md"), "# temp\n");

  const addResult = spawnSync("git", ["add", "README.md"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const commitResult = spawnSync("git", ["commit", "-qm", "test commit"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(commitResult.status, 0, commitResult.stderr);

  const revParseResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(revParseResult.status, 0, revParseResult.stderr);

  return revParseResult.stdout.trim();
}

function addWorktree(repoRoot: string, worktreePath: string, branch: string) {
  const result = spawnSync("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(result.status, 0, result.stderr);
}

function commitInWorktree(worktreePath: string, message: string): string {
  const commitResult = spawnSync("git", ["commit", "--allow-empty", "-qm", message], {
    cwd: worktreePath,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(commitResult.status, 0, commitResult.stderr);

  const revParseResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  assert.equal(revParseResult.status, 0, revParseResult.stderr);

  return revParseResult.stdout.trim();
}

async function withTempRoot<T>(prefix: string, fn: (tempRoot: string) => T | Promise<T>): Promise<T> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function withProjectTempRoot<T>(prefix: string, fn: (tempRoot: string) => T | Promise<T>): Promise<T> {
  const scratchRoot = filePath(".tmp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(scratchRoot, prefix));
  try {
    return await fn(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function setupPlatformSyncEnv(tempRoot: string): PlatformSyncEnv {
  const taskDir = path.join(tempRoot, "TASK-20260328-000001");
  const binDir = path.join(tempRoot, "bin");
  const ghPath = writeFakeGh(path.join(binDir, "gh"));
  const issuePath = path.join(tempRoot, "issue.json");
  const commentsPath = path.join(tempRoot, "comments.json");
  const prPath = path.join(tempRoot, "pr.json");
  const prCommentsPath = path.join(tempRoot, "pr-comments.json");
  const issueFieldsPath = path.join(tempRoot, "issue-fields.json");
  const labelsPath = path.join(tempRoot, "labels.json");

  initIsolatedGitRepo(tempRoot, { remote: "git@github.com:fitlab-ai/agent-infra.git" });

  return {
    taskDir,
    binDir,
    ghPath,
    issuePath,
    commentsPath,
    prPath,
    prCommentsPath,
    issueFieldsPath,
    labelsPath,
    env(extra: NodeJS.ProcessEnv = {}) {
      return {
        PATH: pathWithPrependedBin(binDir),
        ...extra
      };
    }
  };
}

function runValidatorWithFakeGh(args: string[], ctx: PlatformSyncEnv, env: NodeJS.ProcessEnv = {}) {
  return runValidator(args, {
    fakeGhPath: ctx.ghPath,
    env: ctx.env(env)
  });
}

function assertPayloadStatus(result: SpawnSyncReturns<string>, expected: PayloadStatusExpectation) {
  const payload = parseValidatorPayload(result.stdout);
  if (expected.type) {
    assert.equal(payload.type, expected.type);
  }
  if (expected.status) {
    assert.equal(payload.status, expected.status);
  }
  if (expected.message) {
    assert.match(payload.message, expected.message);
  }
  return payload;
}

export {
  addWorktree,
  assertHasCanonicalPrSyncStructure,
  assertPayloadStatus,
  assertPointsToPrSyncRule,
  buildArtifactComment,
  buildCompletedTaskContent,
  buildIssueFieldsPayload,
  buildIssuePayload,
  buildIssueType,
  buildPrPayload,
  buildTaskComment,
  buildTaskContent,
  buildTaskFrontmatter,
  commitInWorktree,
  createHeadCommit,
  formatTimestamp,
  formatTimestampInTimeZone,
  loadFixture,
  parseValidatorPayload,
  runPlatformSyncAdapter,
  runValidator,
  runValidatorWithFakeGh,
  setupPlatformSyncEnv,
  withProjectTempRoot,
  withTempRoot,
  write,
  writeFakeGh,
  writeJson
};

export type {
  FrontmatterOverrides,
  IssuePayloadOverrides,
  PlatformSyncConfig,
  PlatformSyncEnv,
  ValidatorPayload
};
