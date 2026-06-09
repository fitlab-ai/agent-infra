import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

type CommitStep = {
  tasks: string[];
  prTasks: string[];
};

function parseCommitStep(yamlText: string): CommitStep {
  const lines = yamlText.split("\n");

  let inCommitStep = false;
  let listKey: "tasks" | "prTasks" | null = null;
  let listIndent = -1;
  const tasks: string[] = [];
  const prTasks: string[] = [];

  for (const line of lines) {
    const stepMatch = line.match(/^( *)-\s+name:\s+(\S+)/);
    if (stepMatch) {
      inCommitStep = stepMatch[2] === "commit";
      listKey = null;
      listIndent = -1;
      continue;
    }
    if (!inCommitStep) continue;

    const keyMatch = line.match(/^( *)(tasks|pr_tasks):\s*$/);
    if (keyMatch) {
      listKey = keyMatch[2] === "tasks" ? "tasks" : "prTasks";
      listIndent = (keyMatch[1] ?? "").length;
      continue;
    }

    if (listKey) {
      const itemMatch = line.match(/^( *)-\s+(.+)$/);
      if (itemMatch && (itemMatch[1] ?? "").length > listIndent) {
        const value = (itemMatch[2] ?? "").trim();
        if (listKey === "tasks") tasks.push(value);
        else prTasks.push(value);
        continue;
      }
      const otherKey = line.match(/^( *)\S+:/);
      if (otherKey && (otherKey[1] ?? "").length <= listIndent) {
        listKey = null;
        listIndent = -1;
      }
    }
  }

  return { tasks, prTasks };
}

const workflowPaths = [
  ".agents/workflows/feature-development.yaml",
  ".agents/workflows/bug-fix.yaml",
  ".agents/workflows/refactoring.yaml",
  "templates/.agents/workflows/feature-development.en.yaml",
  "templates/.agents/workflows/bug-fix.en.yaml",
  "templates/.agents/workflows/refactoring.en.yaml",
  "templates/.agents/workflows/feature-development.zh-CN.yaml",
  "templates/.agents/workflows/bug-fix.zh-CN.yaml",
  "templates/.agents/workflows/refactoring.zh-CN.yaml"
];

const taskSemanticCategories: Array<{ name: string; keywords: string[] }> = [
  { name: "test", keywords: ["测试", "tests", "test"] },
  { name: "commit-message", keywords: ["提交信息", "commit message", "提交", "commit"] },
  { name: "task-completion", keywords: ["将任务移至已完成", "移至已完成", "已完成", "Move the task to completed", "completed"] }
];

for (const workflowPath of workflowPaths) {
  const yamlText = read(workflowPath);
  const commit = parseCommitStep(yamlText);

  test(`${workflowPath} commit step declares a pr_tasks list`, () => {
    assert.ok(
      commit.prTasks.length > 0,
      "expected pr_tasks list to be present and non-empty"
    );
  });

  test(`${workflowPath} commit step pr_tasks lists at least one PR-flow item`, () => {
    const joined = commit.prTasks.join("\n");
    assert.ok(
      /拉取请求|pull request|PR/i.test(joined),
      "expected pr_tasks to mention PR / pull request"
    );
  });

  for (const category of taskSemanticCategories) {
    test(`${workflowPath} commit step tasks include a ${category.name} item`, () => {
      const joined = commit.tasks.join("\n");
      const matched = category.keywords.some((kw) => joined.includes(kw));
      assert.ok(
        matched,
        `expected tasks list to mention one of: ${category.keywords.join(", ")}`
      );
    });
  }

  test(`${workflowPath} references requiresPullRequest gating`, () => {
    assert.match(yamlText, /requiresPullRequest/);
  });
}
