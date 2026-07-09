import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SECTION_ZH = "工作流告警";
const SECTION_EN = "Workflow Warnings";
const ACTIVITY_ZH = "活动日志";
const ACTIVITY_EN = "Activity Log";
const HEADER = "| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |";
const SEPARATOR = "|----|------|------|----------|------|--------|--------|---------|--------|-------------|------------|";
const VALID_SEVERITIES = new Set(["IMPORTANT", "ACTION_REQUIRED"]);
const VALID_STATUSES = new Set(["open", "resolved", "ignored"]);

function usage() {
  process.stderr.write([
    "Usage:",
    "  node .agents/scripts/workflow-warnings.js add <task-dir> --step <step> --severity <IMPORTANT|ACTION_REQUIRED> --code <code> --target <target> --message <message> --action <action>",
    "  node .agents/scripts/workflow-warnings.js set-status <task-dir> --id <WW-N> --status <resolved|ignored> --resolution <reason>",
    "  node .agents/scripts/workflow-warnings.js list <task-dir> [--status <status>] [--format json|text]",
    ""
  ].join("\n"));
  process.exit(2);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) usage();
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) usage();
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function escapeCell(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function unescapeCell(value) {
  const text = String(value ?? "");
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\\" && (next === "\\" || next === "|")) {
      output += next;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function isEscapedAt(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function splitRow(line) {
  let value = String(line || "").trim();
  if (!value.startsWith("|")) return [];
  value = value.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "|" && !isEscapedAt(value, index)) {
      cells.push(unescapeCell(cell.trim()));
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(unescapeCell(cell.trim()));
  return cells;
}

function rowToWarning(cells, lineIndex) {
  return {
    lineIndex,
    id: cells[0] || "",
    time: cells[1] || "",
    step: cells[2] || "",
    severity: cells[3] || "",
    code: cells[4] || "",
    status: cells[5] || "",
    target: cells[6] || "",
    message: cells[7] || "",
    action: cells[8] || "",
    resolved_at: cells[9] || "",
    resolution: cells[10] || ""
  };
}

function warningToLine(warning) {
  return [
    warning.id,
    warning.time,
    warning.step,
    warning.severity,
    warning.code,
    warning.status,
    warning.target,
    warning.message,
    warning.action,
    warning.resolved_at,
    warning.resolution
  ].map(escapeCell).join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function findSection(lines) {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (new RegExp(`^##\\s+(${SECTION_ZH}|${SECTION_EN})\\s*$`).test(lines[index].trim())) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function insertSection(content) {
  const lines = content.split(/\r?\n/);
  const existing = findSection(lines);
  if (existing) return { content, section: existing };

  const activityIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === `## ${ACTIVITY_ZH}` || trimmed === `## ${ACTIVITY_EN}`;
  });
  const heading = content.includes(`## ${ACTIVITY_EN}`) ? SECTION_EN : SECTION_ZH;
  const block = [`## ${heading}`, "", "<!-- Workflow degradation, platform sync failures, permission gaps, and related events. Keep the header when empty. -->", "", HEADER, SEPARATOR, ""];
  const insertAt = activityIndex >= 0 ? activityIndex : lines.length;
  lines.splice(insertAt, 0, ...block);
  const updated = lines.join("\n");
  return { content: updated, section: findSection(updated.split(/\r?\n/)) };
}

function readTask(taskDir) {
  const taskPath = path.join(taskDir, "task.md");
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task file not found: ${taskPath}`);
  }
  return { taskPath, content: fs.readFileSync(taskPath, "utf8") };
}

function parseWarnings(content) {
  const lines = content.split(/\r?\n/);
  const section = findSection(lines);
  if (!section) return [];
  const warnings = [];
  for (let index = section.start + 1; index < section.end; index += 1) {
    const cells = splitRow(lines[index]);
    if (cells.length === 0) continue;
    if ((cells[0] || "").toLowerCase() === "id") continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (cells.length < 11) continue;
    warnings.push(rowToWarning(cells, index));
  }
  return warnings;
}

function nextId(warnings) {
  const max = warnings.reduce((current, warning) => {
    const match = /^WW-(\d+)$/.exec(warning.id);
    return match ? Math.max(current, Number.parseInt(match[1], 10)) : current;
  }, 0);
  return `WW-${max + 1}`;
}

function requireOption(options, key) {
  const value = options[key];
  if (!value) usage();
  return value;
}

function add(taskDir, options) {
  const severity = requireOption(options, "severity");
  if (!VALID_SEVERITIES.has(severity)) throw new Error(`Invalid severity: ${severity}`);
  const step = requireOption(options, "step");
  const code = requireOption(options, "code");
  const target = requireOption(options, "target");
  const message = requireOption(options, "message");
  const action = requireOption(options, "action");

  const task = readTask(taskDir);
  const inserted = insertSection(task.content);
  const lines = inserted.content.split(/\r?\n/);
  const warnings = parseWarnings(inserted.content);
  const duplicate = warnings.find((warning) =>
    warning.status === "open" &&
    warning.step === step &&
    warning.code === code &&
    warning.target === target
  );
  if (duplicate) {
    process.stdout.write(`${JSON.stringify({ created: false, warning: duplicate }, null, 2)}\n`);
    if (inserted.content !== task.content) fs.writeFileSync(task.taskPath, inserted.content, "utf8");
    return;
  }

  const warning = {
    id: nextId(warnings),
    time: timestamp(),
    step,
    severity,
    code,
    status: "open",
    target,
    message,
    action,
    resolved_at: "",
    resolution: ""
  };
  lines.splice(inserted.section.end - 1, 0, warningToLine(warning));
  fs.writeFileSync(task.taskPath, lines.join("\n"), "utf8");
  process.stdout.write(`${JSON.stringify({ created: true, warning }, null, 2)}\n`);
}

function setStatus(taskDir, options) {
  const id = requireOption(options, "id");
  const status = requireOption(options, "status");
  if (!["resolved", "ignored"].includes(status)) throw new Error(`Invalid status for set-status: ${status}`);
  const resolution = requireOption(options, "resolution");
  const task = readTask(taskDir);
  const lines = task.content.split(/\r?\n/);
  const warnings = parseWarnings(task.content);
  const warning = warnings.find((candidate) => candidate.id === id);
  if (!warning) throw new Error(`Warning not found: ${id}`);
  warning.status = status;
  warning.resolved_at = timestamp();
  warning.resolution = resolution;
  lines[warning.lineIndex] = warningToLine(warning);
  fs.writeFileSync(task.taskPath, lines.join("\n"), "utf8");
  process.stdout.write(`${JSON.stringify({ updated: true, warning }, null, 2)}\n`);
}

function list(taskDir, options) {
  const format = options.format || "text";
  const status = options.status || "";
  if (format !== "json" && format !== "text") usage();
  const warnings = parseWarnings(readTask(taskDir).content)
    .filter((warning) => !status || warning.status === status)
    .map(({ lineIndex: _lineIndex, ...warning }) => warning);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ warnings }, null, 2)}\n`);
    return;
  }
  for (const warning of warnings) {
    process.stdout.write(`${warning.id} [${warning.severity}] ${warning.code} ${warning.target} - ${warning.action}\n`);
  }
}

try {
  const [command, taskDirArg, ...rest] = process.argv.slice(2);
  if (!command || !taskDirArg) usage();
  const taskDir = path.resolve(taskDirArg);
  const options = parseOptions(rest);
  if (command === "add") add(taskDir, options);
  else if (command === "set-status") setStatus(taskDir, options);
  else if (command === "list") list(taskDir, options);
  else usage();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
