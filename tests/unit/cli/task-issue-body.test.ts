import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSection,
  findSectionHeading,
  mutateTableRow,
  upsertSection
} from "../../../lib/task/sections.ts";
import { requirementFieldLabels, renderTemplateBody } from "../../../lib/task/issue-form.ts";
import { buildDefaultBody, issueBody } from "../../../lib/task/commands/issue-body.ts";

const TASK_MD = `---
id: TASK-1
type: refactor
---
# 任务：示例任务

## 描述

第一段描述。

第二段描述，含行内 \`## 需求\` 代码（不是标题）。

## 任务输入

### 来源

- 用户确认

### 约束

- 保留原始状态。

## 上下文

- 分支：x

## 需求

- [ ] 未完成项 A
- [x] 已完成项 B

## 设计

不应进入 body 的脚手架。

## 活动日志

- 不应进入 body。
`;

// A realistic GitHub Issue Form (structural fixture): markdown blurb, mapped
// input/textarea fields, a non-mappable textarea, a dropdown and checkboxes.
const ISSUE_FORM = `name: Example Form
description: example
labels:
  - "status: waiting-for-triage"
body:
  - type: markdown
    attributes:
      value: |
        Please fill this in.
  - type: input
    id: summary
    attributes:
      label: 问题摘要 / Summary
    validations:
      required: true
  - type: dropdown
    id: category
    attributes:
      label: 类别 / Category
      options:
        - A
        - B
  - type: textarea
    id: description
    attributes:
      label: 详细描述 / Description
  - type: textarea
    id: solution
    attributes:
      label: 方案 / Solution
  - type: textarea
    id: context
    attributes:
      label: 相关背景 / Context
  - type: checkboxes
    id: confirmations
    attributes:
      label: 确认 / Confirmations
      options:
        - label: I confirm
`;

const FIELDS = {
  title: "示例任务",
  description: "第一段描述。\n\n第二段描述。",
  requirements: "- [ ] 未完成项 A\n- [x] 已完成项 B",
  taskInput: "### 来源\n\n- 用户确认\n\n### 约束\n\n- 保留原始状态。",
  taskInputHeading: "任务输入"
};

test("extractSection returns the section body up to the next heading", () => {
  const body = extractSection(TASK_MD, ["描述", "Description"]);
  assert.match(body, /^第一段描述。/);
  // stops before the next "## 上下文" heading
  assert.doesNotMatch(body, /分支：x/);
  // an inline `## 需求` code span on a prose line is not treated as a heading
  assert.match(body, /行内 `## 需求` 代码/);
});

test("extractSection preserves checkbox text verbatim", () => {
  const reqs = extractSection(TASK_MD, ["需求", "Requirements"]);
  assert.equal(reqs, "- [ ] 未完成项 A\n- [x] 已完成项 B");
});

test("extractSection returns '' when no alias heading is present", () => {
  assert.equal(extractSection(TASK_MD, ["不存在", "Missing"]), "");
});

test("findSectionHeading mirrors the heading actually present", () => {
  assert.equal(findSectionHeading(TASK_MD, ["描述", "Description"]), "描述");
  assert.equal(findSectionHeading("## Description\n\nx\n", ["描述", "Description"]), "Description");
  assert.equal(findSectionHeading("no section here", ["描述", "Description"]), "描述");
});

test("buildDefaultBody emits task input, description and requirements in order", () => {
  const body = buildDefaultBody(TASK_MD);
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  assert.deepEqual(headings, ["任务输入", "描述", "需求"]);
  assert.match(body, /### 来源\n\n- 用户确认/);
});

test("buildDefaultBody keeps requirement checkboxes verbatim", () => {
  const body = buildDefaultBody(TASK_MD);
  assert.match(body, /- \[ \] 未完成项 A\n- \[x\] 已完成项 B/);
});

test("buildDefaultBody fills empty sections with N/A", () => {
  const body = buildDefaultBody("# t\n\n## 描述\n\n## 需求\n");
  assert.equal(body, "## 任务输入\n\nN/A\n\n## 描述\n\nN/A\n\n## 需求\n\nN/A\n");
});

test("renderTemplateBody maps fields by id and keeps template structure", () => {
  const body = renderTemplateBody(ISSUE_FORM, FIELDS);
  const formBody = body.slice(0, body.indexOf("### 任务输入"));
  const headings = [...formBody.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1]!.trim());
  // markdown / dropdown / checkboxes skipped; only input + textarea labels remain, in order
  assert.deepEqual(headings, [
    "问题摘要 / Summary",
    "详细描述 / Description",
    "方案 / Solution",
    "相关背景 / Context"
  ]);
  assert.match(body, /### 问题摘要 \/ Summary\n\n示例任务/);
  assert.match(body, /### 详细描述 \/ Description\n\n第一段描述。/);
});

test("renderTemplateBody appends task input exactly once after form fields", () => {
  const body = renderTemplateBody(ISSUE_FORM, FIELDS);
  assert.equal(body.match(/^### 任务输入$/gm)?.length, 1);
  assert.match(body, /### 任务输入\n\n### 来源\n\n- 用户确认\n\n### 约束\n\n- 保留原始状态。\n$/);
});

test("renderTemplateBody fills empty task input with N/A", () => {
  const body = renderTemplateBody(ISSUE_FORM, { ...FIELDS, taskInput: "" });
  assert.match(body, /### 任务输入\n\nN\/A\n$/);
});

test("renderTemplateBody fills unmappable fields with N/A", () => {
  const body = renderTemplateBody(ISSUE_FORM, FIELDS);
  assert.match(body, /### 相关背景 \/ Context\n\nN\/A/);
});

test("renderTemplateBody keeps requirement checkboxes verbatim in mapped field", () => {
  const body = renderTemplateBody(ISSUE_FORM, FIELDS);
  assert.match(body, /### 方案 \/ Solution\n\n- \[ \] 未完成项 A\n- \[x\] 已完成项 B/);
});

test("renderTemplateBody throws on YAML without a body[] list", () => {
  assert.throws(() => renderTemplateBody("name: x\ndescription: y\n", FIELDS), /body\[\]/);
});

test("requirementFieldLabels returns labels rendered from requirement text fields", () => {
  assert.deepEqual(requirementFieldLabels(ISSUE_FORM), ["方案 / Solution"]);
  assert.throws(() => requirementFieldLabels("name: x\ndescription: y\n"), /body\[\]/);
});

test("issueBody exits 1 with a prefixed error on an unknown task ref", () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exitCode;
  let captured = "";
  process.stderr.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    issueBody(["TASK-99999999-999999"]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(process.exitCode, 1);
  assert.match(captured, /^ai task issue-body: /);
  process.exitCode = originalExit;
});

test("upsertSection preserves the actual language heading and outside text", () => {
  const input = "# T\n\n## Description\n\nold\n\n## Tail\n\nkeep\n";
  assert.deepEqual(
    upsertSection(input, { aliases: ["\u63cf\u8ff0", "Description"], heading: "\u63cf\u8ff0", body: "new" }),
    {
      content: "# T\n\n## Description\n\nnew\n\n## Tail\n\nkeep\n",
      heading: "Description",
      operation: "update"
    }
  );
});

test("upsertSection creates a missing section with the requested heading", () => {
  assert.deepEqual(
    upsertSection("# T\n", { aliases: ["Notes"], heading: "Notes", body: "body" }),
    { content: "# T\n\n## Notes\n\nbody\n", heading: "Notes", operation: "create" }
  );
});

test("upsertSection preserves existing trailing bytes when creating a missing section", () => {
  const samples = [
    { input: "# T", expected: "# T\n\n## Notes\n\nbody\n" },
    { input: "# T\n", expected: "# T\n\n## Notes\n\nbody\n" },
    { input: "# T\n\n\n\n", expected: "# T\n\n\n\n## Notes\n\nbody\n" },
    { input: "# T\r\n", expected: "# T\r\n\r\n## Notes\r\n\r\nbody\r\n" },
    { input: "# T\r\n\r\n\r\n", expected: "# T\r\n\r\n\r\n## Notes\r\n\r\nbody\r\n" }
  ];
  for (const sample of samples) {
    const result = upsertSection(sample.input, {
      aliases: ["Notes"],
      heading: "Notes",
      body: "body"
    });
    assert.equal(result.content, sample.expected);
    assert.equal(result.content.startsWith(sample.input), true);
  }
});

test("mutateTableRow merges selected cells and preserves untouched cell tokens", () => {
  const input = "## Ledger\n\n| id | status | note |\n|----|--------|------|\n| A | open |  keep  |\n\nend\n";
  assert.deepEqual(
    mutateTableRow(input, {
      kind: "table-row",
      action: "upsert",
      sectionAliases: ["Ledger"],
      columns: ["id", "status", "note"],
      keyColumn: "id",
      key: "A",
      values: { status: "closed" }
    }),
    {
      content: "## Ledger\n\n| id | status | note |\n|----|--------|------|\n| A | closed |  keep  |\n\nend\n",
      section: "Ledger",
      operation: "update"
    }
  );
});

test("mutateTableRow supports key-only insert and repeated no-op", () => {
  const input = "## IDs\n\n| id |\n|----|\n";
  const first = mutateTableRow(input, {
    kind: "table-row",
    action: "upsert",
    sectionAliases: ["IDs"],
    columns: ["id"],
    keyColumn: "id",
    key: "A",
    values: {}
  });
  assert.equal(first.operation, "insert");
  assert.equal(first.content, "## IDs\n\n| id |\n|----|\n| A |\n");
  const second = mutateTableRow(first.content, {
    kind: "table-row",
    action: "upsert",
    sectionAliases: ["IDs"],
    columns: ["id"],
    keyColumn: "id",
    key: "A",
    values: {}
  });
  assert.deepEqual(second, { content: first.content, section: "IDs", operation: "update" });
});

test("mutateTableRow keeps whitespace-only cells stable for empty scalar updates", () => {
  const input = "## Ledger\n\n| id | note |\n|----|------|\n| A |   |\n";
  for (const value of ["", null] as const) {
    const mutation = {
      kind: "table-row" as const,
      action: "upsert" as const,
      sectionAliases: ["Ledger"],
      columns: ["id", "note"],
      keyColumn: "id",
      key: "A",
      values: { note: value }
    };
    const first = mutateTableRow(input, mutation);
    const second = mutateTableRow(first.content, mutation);
    assert.equal(first.content, input);
    assert.equal(second.content, input);
  }
});

test("mutateTableRow validates insert columns and delete is idempotent", () => {
  const input = "## Ledger\n\n| id | status |\n|----|--------|\n";
  assert.throws(
    () => mutateTableRow(input, {
      kind: "table-row",
      action: "upsert",
      sectionAliases: ["Ledger"],
      columns: ["id", "status"],
      keyColumn: "id",
      key: "A",
      values: {}
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TABLE_MISSING_COLUMN"
  );
  assert.deepEqual(
    mutateTableRow(input, {
      kind: "table-row",
      action: "delete",
      sectionAliases: ["Ledger"],
      columns: ["id", "status"],
      keyColumn: "id",
      key: "missing"
    }),
    { content: input, section: "Ledger", operation: "delete" }
  );
});

test("upsertSection rejects ambiguous language aliases", () => {
  assert.throws(
    () => upsertSection(
      "## Description\n\none\n\n## \u63cf\u8ff0\n\ntwo\n",
      { aliases: ["Description", "\u63cf\u8ff0"], heading: "Description", body: "next" }
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TASK_DOCUMENT_INVALID"
  );
});

test("mutateTableRow escapes inserted cells and deletes a matching row", () => {
  const input = "## Ledger\r\n\r\n| id | note |\r\n|----|------|\r\n";
  const inserted = mutateTableRow(input, {
    kind: "table-row",
    action: "upsert",
    sectionAliases: ["Ledger"],
    columns: ["id", "note"],
    keyColumn: "id",
    key: "A|B",
    values: { note: "x\\y|z" }
  });
  assert.equal(
    inserted.content,
    "## Ledger\r\n\r\n| id | note |\r\n|----|------|\r\n| A\\|B | x\\\\y\\|z |\r\n"
  );
  assert.equal(
    mutateTableRow(inserted.content, {
      kind: "table-row",
      action: "delete",
      sectionAliases: ["Ledger"],
      columns: ["id", "note"],
      keyColumn: "id",
      key: "A|B"
    }).content,
    input
  );
});

test("mutateTableRow returns precise validation codes", () => {
  const base = "## Ledger\n\n| id | status |\n|----|--------|\n| A | open |\n";
  const common = {
    kind: "table-row" as const,
    action: "upsert" as const,
    sectionAliases: ["Ledger"],
    columns: ["id", "status"],
    keyColumn: "id",
    key: " A "
  };
  const cases: { values: Record<string, string>; code: string }[] = [
    { values: { unknown: "x" }, code: "TABLE_UNKNOWN_COLUMN" },
    { values: { id: " A " }, code: "TABLE_KEY_COLUMN_IN_VALUES" },
    { values: { id: " B " }, code: "TABLE_KEY_CONFLICT" },
    { values: { status: "bad\ncell" }, code: "TABLE_CELL_INVALID" }
  ];
  for (const sample of cases) {
    assert.throws(
      () => mutateTableRow(base, { ...common, values: sample.values }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === sample.code
    );
  }

  assert.throws(
    () => mutateTableRow(base.replace("| A | open |\n", "| A | open |\n| A | closed |\n"), {
      ...common,
      values: { status: "closed" }
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TABLE_DUPLICATE_KEY"
  );

  assert.throws(
    () => mutateTableRow(base, {
      ...common,
      action: "delete",
      values: { status: "closed" }
    } as never),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TABLE_DELETE_VALUES_FORBIDDEN"
  );
});
