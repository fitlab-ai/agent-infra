import test from "node:test";
import assert from "node:assert/strict";

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
  test(`${workflowPath} documents fact-state PR routing`, () => {
    const content = read(workflowPath);
    assert.match(content, /prFlow/);
    assert.match(content, /pr_delivery_fact\.state/);
  });
}
