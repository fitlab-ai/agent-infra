import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";

import { read } from "../../helpers.ts";
import { decodePrDeliveryFact } from "../../../lib/task/pr-delivery-fact.ts";

const taskTemplates = [
  ".agents/templates/task.md",
  "templates/.agents/templates/task.en.md",
  "templates/.agents/templates/task.zh-CN.md"
];

for (const templatePath of taskTemplates) {
  test(`${templatePath} declares a versioned unbound delivery fact`, () => {
    const content = read(templatePath);
    const line = content.split("\n").find((item) => item.startsWith("pr_delivery_fact:"));
    assert.ok(line);
    const value = line!.slice("pr_delivery_fact:".length).trim();
    const fact = decodePrDeliveryFact(value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : JSON.parse(value));
    assert.deepEqual(fact, { version: 1, state: "unbound", reason: "initial" });
  });
}

for (const workflowPath of [
  ".agents/workflows/feature-development.yaml",
  ".agents/workflows/bug-fix.yaml",
  ".agents/workflows/refactoring.yaml"
]) {
  const document = parseYaml(read(workflowPath)) as {
    steps?: Array<{ name?: unknown; tasks?: unknown; pr_tasks?: unknown }>;
  };
  const delivery = document.steps?.find((step) => step.name === "delivery");

  test(`${workflowPath} declares a structured delivery step`, () => {
    assert.ok(delivery);
    assert.ok(Array.isArray(delivery!.tasks));
    assert.ok(Array.isArray(delivery!.pr_tasks));
    assert.ok(delivery!.tasks!.length > 0);
    assert.ok(delivery!.pr_tasks!.length > 0);
  });
}
