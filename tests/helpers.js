import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const realPlatform = process.platform;

function filePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function exists(relativePath) {
  return fs.existsSync(filePath(relativePath));
}

function read(relativePath) {
  return fs.readFileSync(filePath(relativePath), "utf8");
}

function pathWithPrependedBin(binDir, envPath = process.env.PATH || "") {
  return [binDir, envPath].filter(Boolean).join(path.delimiter);
}

function envWithPrependedPath(env, binDir) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const nextPath = pathWithPrependedBin(binDir, env[pathKey] || "");
  return {
    ...env,
    [pathKey]: nextPath,
    PATH: nextPath
  };
}

function supportsPosixModeBits() {
  return realPlatform !== "win32";
}

function assertModeBits(filePathname, expectedMode) {
  if (!supportsPosixModeBits()) {
    return;
  }

  const actualMode = fs.statSync(filePathname).mode & 0o777;
  assertEqual(actualMode, expectedMode);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected mode ${expected.toString(8)}, got ${actual.toString(8)}`);
  }
}

function writeNodeCommandShim(commandPath, scriptPath) {
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

function listFilesRecursive(relativeDir) {
  const entries = fs.readdirSync(filePath(relativeDir), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(relativePath);
    }
    return [relativePath];
  });
}

function listSkillNames() {
  return fs.readdirSync(filePath(".agents/skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function langTemplate(basePath, lang) {
  const ext = path.extname(basePath);
  const variant = /\.(?:en|zh-CN)(?=\.[^.]+$)/.test(basePath)
    ? basePath.replace(/\.(?:en|zh-CN)(?=\.[^.]+$)/, `.${lang}`)
    : basePath.replace(ext, `.${lang}${ext}`);
  if (exists(variant)) {
    return variant;
  }

  return basePath;
}

function renderPlaceholders(content, replacements) {
  return content
    .replace(/\{\{project\}\}/g, replacements.project)
    .replace(/\{\{org\}\}/g, replacements.org);
}

function buildCommandSyncFiles(project) {
  return listSkillNames().flatMap((skill) => [
    [`.claude/commands/${skill}.md`, `templates/.claude/commands/${skill}.en.md`],
    [`.opencode/commands/${skill}.md`, `templates/.opencode/commands/${skill}.en.md`],
    [`.gemini/commands/${project}/${skill}.toml`, `templates/.gemini/commands/_project_/${skill}.en.toml`]
  ]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadFreshEsm(relativePath) {
  const moduleUrl = pathToFileURL(filePath(relativePath));
  moduleUrl.searchParams.set("v", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return import(moduleUrl.href);
}

function parseFrontmatter(relativePath) {
  const content = read(relativePath);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!match) {
    return null;
  }

  const lines = match[1].split(/\r?\n/);
  let name = "";
  let description = "";

  const normalizeValue = (value) => value.replace(/^["']|["']$/g, "").trim();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("name:")) {
      name = normalizeValue(line.slice("name:".length).trim());
      continue;
    }

    if (!line.startsWith("description:")) {
      continue;
    }

    const value = line.slice("description:".length).trim();
    if (value === ">") {
      const descriptionLines = [];

      for (let offset = index + 1; offset < lines.length; offset += 1) {
        const descriptionLine = lines[offset];
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

function skillDocPaths(skill) {
  return [
    `.agents/skills/${skill}/SKILL.md`,
    `templates/.agents/skills/${skill}/SKILL.en.md`,
    `templates/.agents/skills/${skill}/SKILL.zh-CN.md`
  ].filter(exists);
}

const commandSpecs = {
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
  "create-issue": {
    usage: "<task-id>",
    en: "Create Issue for task $1.",
    zh: "为任务 $1 创建 Issue。"
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
  commandSpecs,
  envWithPrependedPath,
  escapeRegExp,
  exists,
  filePath,
  assertModeBits,
  langTemplate,
  listFilesRecursive,
  listSkillNames,
  loadFreshEsm,
  parseFrontmatter,
  pathWithPrependedBin,
  read,
  renderPlaceholders,
  supportsPosixModeBits,
  writeNodeCommandShim,
  skillDocPaths
};
