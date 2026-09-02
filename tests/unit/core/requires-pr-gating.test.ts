import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

type DeliveryStep = {
  tasks: string[];
  prTasks: string[];
};

function parseDeliveryStep(yamlText: string): DeliveryStep {
  const lines = yamlText.split("\n");

  let inDeliveryStep = false;
  let listKey: "tasks" | "prTasks" | null = null;
  let listIndent = -1;
  const tasks: string[] = [];
  const prTasks: string[] = [];

  for (const line of lines) {
    const stepMatch = line.match(/^( *)-\s+name:\s+(\S+)/);
    if (stepMatch) {
      inDeliveryStep = stepMatch[2] === "delivery";
      listKey = null;
      listIndent = -1;
      continue;
    }
    if (!inDeliveryStep) continue;

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

for (const workflowPath of workflowPaths) {
  const yamlText = read(workflowPath);
  const delivery = parseDeliveryStep(yamlText);

  test(`${workflowPath} delivery step declares a pr_tasks list`, () => {
    assert.ok(
      delivery.prTasks.length > 0,
      "expected pr_tasks list to be present and non-empty"
    );
  });

  test(`${workflowPath} delivery step retains local and PR task lists`, () => {
    assert.ok(delivery.tasks.length > 0, "expected delivery tasks to be present");
    assert.ok(delivery.prTasks.length > 0, "expected delivery PR tasks to be present");
  });
}
