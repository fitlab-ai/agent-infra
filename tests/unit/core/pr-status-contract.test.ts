import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

// Task templates must carry the pr_status field with the `pending` default so
// new tasks start on the soft-gated path.
const taskTemplates = [
  ".agents/templates/task.md",
  "templates/.agents/templates/task.en.md",
  "templates/.agents/templates/task.zh-CN.md"
];

for (const templatePath of taskTemplates) {
  test(`${templatePath} declares pr_status: pending default`, () => {
    assert.match(read(templatePath), /^pr_status: pending/m);
  });
}

// Extract markdown table rows (lines that start with `|`) as cell arrays.
// cells[0] is the empty leading segment; cells[1..] are the real columns.
function tableRows(content: string): string[][] {
  return content
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
}

// Locate the complete-task PR-dimension decision row for prFlow=required with
// pr_status in {pending, skipped} and return its decision cell.
function requiredSkippedDecisionCell(content: string): string | null {
  for (const cells of tableRows(content)) {
    if (cells.length < 4) continue;
    const prFlow = cells[1];
    const prStatus = cells[2];
    if (/required/.test(prFlow) && /pending/.test(prStatus) && /skipped/.test(prStatus)) {
      return cells[3];
    }
  }
  return null;
}

// Regression guard (blocker from review-plan round 1, hardened per review-code
// round 1): the prFlow=required strong constraint must NOT be bypassable by a
// pre-existing / manually-set pr_status=skipped. We assert the STRUCTURE of the
// decision row, not mere keyword co-occurrence: the required + pending/skipped
// row must STOP, point to /create-pr, and refuse --skip-pr.
const completeTaskDocs: Array<{ path: string; stop: RegExp; refuse: RegExp }> = [
  { path: ".agents/skills/complete-task/SKILL.md", stop: /停止/, refuse: /不被接受/ },
  { path: "templates/.agents/skills/complete-task/SKILL.zh-CN.md", stop: /停止/, refuse: /不被接受/ },
  { path: "templates/.agents/skills/complete-task/SKILL.en.md", stop: /stop/i, refuse: /not accepted/i }
];

for (const { path, stop, refuse } of completeTaskDocs) {
  test(`${path} required + pending/skipped decision stops and refuses --skip-pr`, () => {
    const cell = requiredSkippedDecisionCell(read(path));
    assert.ok(cell, "expected a prFlow=required + pending/skipped decision row");
    assert.match(cell as string, stop, "required + skipped must STOP (no bypass)");
    assert.match(cell as string, /\/create-pr/, "must direct the user to /create-pr");
    assert.match(cell as string, /--skip-pr/, "must mention --skip-pr in the decision");
    assert.match(cell as string, refuse, "--skip-pr must be refused under required");
  });
}

// Regression guard (major from review-plan round 1, hardened per review-code
// round 1): under prFlow=required the workflow pr_tasks ALWAYS counts, and the
// pr_status=skipped exclusion is scoped to the DEFAULT (field-absent) case only
// — i.e. the two are distinct branches, so `skipped` can never drop pr_tasks
// under `required`. We assert that structural relationship, not co-occurrence.
const workflowDocs = [
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

// The leading comment block (lines starting with `#`) carries the gate rule.
function leadingComment(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("#")) lines.push(line.replace(/^#\s?/, ""));
    else if (lines.length > 0) break;
  }
  return lines.join("\n");
}

for (const workflowPath of workflowDocs) {
  test(`${workflowPath} pr_tasks rule: required always counts, skipped excludes only when default`, () => {
    const comment = leadingComment(read(workflowPath));
    // `required` is bound to "always counts" on the same clause.
    assert.match(
      comment,
      /required[^\n]*?(始终计入|always counts)/i,
      "prFlow=required must always count pr_tasks"
    );
    // The skipped exclusion is scoped to the field-absent / default case, so it
    // cannot apply to `required`.
    assert.match(
      comment,
      /(字段缺省|field is absent)[\s\S]{0,120}skipped/i,
      "pr_status=skipped exclusion must be scoped to the field-absent case"
    );
  });
}
