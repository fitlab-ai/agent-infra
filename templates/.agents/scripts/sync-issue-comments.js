import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXIT_CODE = {
  pass: 0,
  fail: 1,
  blocked: 2
};

const ARTIFACT_ORDER = [
  "analysis",
  "plan",
  "implementation",
  "review",
  "refinement",
  "summary",
  "cancel"
];

const TITLE_BY_STEM = {
  task: "任务文件",
  analysis: "需求分析",
  plan: "技术方案",
  implementation: "实现报告（Round 1）",
  review: "审查报告（Round 1）",
  refinement: "修复报告（Round 1）",
  summary: "交付摘要",
  cancel: "取消说明"
};

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");

function main(argv) {
  const { value: agentValue, rest: agentArgs } = extractOption(argv, "--agent");
  const { value: formatValue, rest: formatArgs } = extractOption(agentArgs, "--format");
  const { present: dryRun, rest: positional } = extractFlag(formatArgs, "--dry-run");
  const [taskDirArg, ...artifactFiles] = positional;

  if (!taskDirArg) {
    failUsage();
  }

  const taskDir = path.resolve(taskDirArg);
  const format = formatValue === "text" ? "text" : "json";
  const agent = String(agentValue || "codex").trim() || "codex";
  const result = syncIssueComments({
    taskDir,
    artifactFiles,
    agent,
    dryRun
  });

  writeOutput(result, format);
  process.exit(EXIT_CODE[result.status] ?? 1);
}

function syncIssueComments({ taskDir, artifactFiles, agent, dryRun }) {
  const task = loadTask(taskDir);
  if (!task.ok) {
    return blockedResult(task.message, []);
  }

  const issueNumber = parseIssueNumber(task.metadata.issue_number);
  if (!issueNumber) {
    return passResult("Skipped: task has no issue_number", []);
  }

  const ownerRepo = resolveOwnerRepo(taskDir);
  if (!ownerRepo.ok) {
    return blockedResult(ownerRepo.message, []);
  }

  const commentsResult = ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${ownerRepo.value}/issues/${issueNumber}/comments?per_page=100`
  ], taskDir);
  if (!commentsResult.ok) {
    return blockedResult(commentsResult.message, []);
  }

  const comments = flattenComments(commentsResult.value);
  const specs = buildCommentSpecs({ taskDir, task, artifactFiles, agent });
  if (!specs.ok) {
    return failResult(specs.message, []);
  }

  const operations = [];
  for (const spec of specs.value) {
    const existing = findCommentByMarker(comments, spec.marker);
    if (!existing) {
      operations.push({ action: "create", file: spec.file, marker: spec.marker, body: spec.body });
      continue;
    }

    if (normalizeContent(existing.body) === normalizeContent(spec.body)) {
      operations.push({ action: "skip", file: spec.file, marker: spec.marker, comment_id: existing.id });
      continue;
    }

    operations.push({
      action: "update",
      file: spec.file,
      marker: spec.marker,
      comment_id: existing.id,
      body: spec.body
    });
  }

  if (dryRun) {
    return passResult("Dry run completed", summarizeOperations(operations));
  }

  const applied = [];
  for (const operation of operations) {
    if (operation.action === "skip") {
      applied.push(operation);
      continue;
    }

    const writeResult = writeComment({
      ownerRepo: ownerRepo.value,
      issueNumber,
      operation,
      cwd: taskDir
    });
    if (!writeResult.ok) {
      return blockedResult(writeResult.message, [...applied, operation]);
    }

    applied.push({
      ...operation,
      comment_id: operation.comment_id || writeResult.commentId || null
    });
  }

  return passResult("GitHub issue comments synced", summarizeOperations(applied));
}

function loadTask(taskDir) {
  const taskPath = path.join(taskDir, "task.md");
  if (!fs.existsSync(taskPath)) {
    return { ok: false, message: `Task file not found: ${taskPath}` };
  }

  const content = fs.readFileSync(taskPath, "utf8");
  const metadata = parseFrontmatter(content);
  if (!metadata) {
    return { ok: false, message: "task.md frontmatter not found or invalid" };
  }

  return { ok: true, path: taskPath, content, metadata };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return null;
  }

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (parsed) {
      metadata[parsed[1]] = parsed[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }

  return metadata;
}

function buildCommentSpecs({ taskDir, task, artifactFiles, agent }) {
  const files = resolveSyncFiles(taskDir, artifactFiles);
  const specs = [];

  for (const file of files) {
    const filePath = path.join(taskDir, file);
    if (!fs.existsSync(filePath)) {
      return { ok: false, message: `Artifact file not found: ${file}` };
    }

    const stem = path.basename(file, path.extname(file));
    const marker = `<!-- sync-issue:${task.metadata.id}:${stem} -->`;
    const title = titleForStem(stem);
    const content = fs.readFileSync(filePath, "utf8");
    const body = stem === "task"
      ? buildTaskComment({ taskId: task.metadata.id, agent, content })
      : buildArtifactComment({ taskId: task.metadata.id, stem, title, agent, content });

    specs.push({ file, stem, marker, title, body });
  }

  return { ok: true, value: specs };
}

function resolveSyncFiles(taskDir, artifactFiles) {
  if (artifactFiles.length > 0) {
    const files = artifactFiles.includes("task.md") ? artifactFiles : ["task.md", ...artifactFiles];
    return unique(files);
  }

  const entries = fs.readdirSync(taskDir)
    .filter((entry) => entry.endsWith(".md"))
    .filter((entry) => entry === "task.md" || artifactSortKey(entry));

  return entries.sort(compareArtifactFiles);
}

function compareArtifactFiles(left, right) {
  if (left === "task.md") {
    return -1;
  }
  if (right === "task.md") {
    return 1;
  }

  const leftKey = artifactSortKey(left);
  const rightKey = artifactSortKey(right);
  return leftKey.order - rightKey.order || leftKey.round - rightKey.round || left.localeCompare(right);
}

function artifactSortKey(file) {
  const stem = path.basename(file, path.extname(file));
  const match = stem.match(/^([a-z-]+)(?:-r(\d+))?$/);
  if (!match) {
    return null;
  }

  const [, base, roundValue] = match;
  const order = ARTIFACT_ORDER.indexOf(base);
  if (order === -1) {
    return null;
  }

  return {
    order,
    round: roundValue ? Number(roundValue) : 1
  };
}

function buildArtifactComment({ taskId, stem, title, agent, content }) {
  return [
    `<!-- sync-issue:${taskId}:${stem} -->`,
    `## ${title}`,
    "",
    `> **${agent}** · ${taskId}`,
    "",
    content.trim(),
    "",
    "---",
    `*由 ${agent} 自动生成 · 内部追踪：${taskId}*`
  ].join("\n");
}

function buildTaskComment({ taskId, agent, content }) {
  const body = buildRenderedTaskBody(content);
  return [
    `<!-- sync-issue:${taskId}:task -->`,
    "## 任务文件",
    "",
    `> **${agent}** · ${taskId}`,
    "",
    body,
    "",
    "---",
    `*由 ${agent} 自动生成 · 内部追踪：${taskId}*`
  ].join("\n");
}

function buildRenderedTaskBody(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    return content.trim();
  }

  const body = content.slice(frontmatterMatch[0].length).trim();
  return [
    "<details><summary>元数据 (frontmatter)</summary>",
    "",
    "```yaml",
    frontmatterMatch[0].trim(),
    "```",
    "",
    "</details>",
    "",
    body
  ].join("\n").trim();
}

function titleForStem(stem) {
  const match = stem.match(/^(.+?)-r(\d+)$/);
  if (match) {
    const [, base, round] = match;
    const baseTitle = TITLE_BY_STEM[base] || base;
    return `${baseTitle.replace(/（Round 1）$/, "")}（Round ${round}）`;
  }

  return TITLE_BY_STEM[stem] || stem;
}

function writeComment({ ownerRepo, issueNumber, operation, cwd }) {
  const payloadPath = path.join(os.tmpdir(), `agent-infra-comment-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ body: operation.body }), "utf8");

  try {
    const args = operation.action === "create"
      ? ["api", `repos/${ownerRepo}/issues/${issueNumber}/comments`, "-X", "POST", "--input", payloadPath]
      : ["api", `repos/${ownerRepo}/issues/comments/${operation.comment_id}`, "-X", "PATCH", "--input", payloadPath];
    const result = ghJson(args, cwd);
    if (!result.ok) {
      return result;
    }

    return { ok: true, commentId: result.value?.id };
  } finally {
    fs.rmSync(payloadPath, { force: true });
  }
}

function resolveOwnerRepo(cwd) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    env: process.env
  });

  if (result.status !== 0) {
    return { ok: false, message: `Unable to resolve git remote: ${result.stderr.trim() || result.stdout.trim()}` };
  }

  const remote = result.stdout.trim();
  const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) {
    return { ok: false, message: `Unable to parse owner/repo from remote '${remote}'` };
  }

  return { ok: true, value: match[1] };
}

function ghJson(args, cwd) {
  const gh = resolveGhCommand();
  const result = spawnSync(gh.command, [...gh.preArgs, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env
  });

  if (result.status !== 0) {
    return {
      ok: false,
      type: "network_error",
      message: classifyGhFailure(`${result.stderr || ""}${result.stdout || ""}`.trim(), args)
    };
  }

  if (!result.stdout.trim()) {
    return { ok: true, value: null };
  }

  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, type: "network_error", message: `Invalid JSON from gh: ${error.message}` };
  }
}

function resolveGhCommand() {
  const command = process.env.AGENT_INFRA_GH_BIN || "gh";
  const rawPreArgs = process.env.AGENT_INFRA_GH_ARGS_JSON;
  if (!rawPreArgs) {
    return { command, preArgs: [] };
  }

  try {
    const preArgs = JSON.parse(rawPreArgs);
    if (Array.isArray(preArgs) && preArgs.every((arg) => typeof arg === "string")) {
      return { command, preArgs };
    }
  } catch {
    return { command, preArgs: [] };
  }

  return { command, preArgs: [] };
}

function classifyGhFailure(stderr, args) {
  const message = stderr || `gh ${args.join(" ")} failed`;
  if (/token.*invalid|requires authentication|http 401|not logged in/i.test(message)) {
    return `GitHub authentication failed: ${message}`;
  }

  return message;
}

function flattenComments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  if (value.every((item) => Array.isArray(item))) {
    return value.flat();
  }

  return value;
}

function findCommentByMarker(comments, marker) {
  return comments.find((comment) => typeof comment.body === "string" && comment.body.includes(marker)) || null;
}

function summarizeOperations(operations) {
  return operations.map((operation) => ({
    action: operation.action,
    file: operation.file,
    marker: operation.marker,
    comment_id: operation.comment_id || null
  }));
}

function normalizeContent(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function parseIssueNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "" || value === "N/A") {
    return null;
  }

  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function unique(values) {
  return [...new Set(values)];
}

function passResult(message, operations) {
  return { status: "pass", message, operations };
}

function failResult(message, operations) {
  return { status: "fail", message, operations };
}

function blockedResult(message, operations) {
  return { status: "blocked", message, operations };
}

function extractOption(args, name) {
  const rest = [];
  let value;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      value = args[index + 1];
      index += 1;
      continue;
    }

    const inlinePrefix = `${name}=`;
    if (arg.startsWith(inlinePrefix)) {
      value = arg.slice(inlinePrefix.length);
      continue;
    }

    rest.push(arg);
  }

  return { value, rest };
}

function extractFlag(args, name) {
  const rest = [];
  let present = false;

  for (const arg of args) {
    if (arg === name) {
      present = true;
      continue;
    }

    rest.push(arg);
  }

  return { present, rest };
}

function writeOutput(result, format) {
  if (format === "text") {
    process.stdout.write([
      `GitHub comment sync: ${result.status}`,
      "",
      result.message,
      "",
      ...result.operations.map((operation) => {
        const id = operation.comment_id ? ` #${operation.comment_id}` : "";
        return `- ${operation.action}${id}: ${operation.file}`;
      })
    ].join("\n") + "\n");
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function failUsage() {
  process.stderr.write([
    "Usage:",
    "  node .agents/scripts/sync-issue-comments.js <task-dir> [artifact-file ...] [--agent <name>] [--dry-run] [--format json|text]"
  ].join("\n") + "\n");
  process.exit(1);
}

main(process.argv.slice(2));
