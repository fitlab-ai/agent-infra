import test from "node:test";
import assert from "node:assert/strict";

import { extractSection, findSectionHeading } from "../../../lib/task/sections.ts";
import { renderTemplateBody } from "../../../lib/task/issue-form.ts";
import { buildDefaultBody, issueBody } from "../../../lib/task/commands/issue-body.ts";

const TASK_MD = `---
id: TASK-1
type: refactor
---
# 任务：示例任务

## 描述

第一段描述。

第二段描述，含行内 \`## 需求\` 代码（不是标题）。

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
  requirements: "- [ ] 未完成项 A\n- [x] 已完成项 B"
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

test("buildDefaultBody emits only 描述 + 需求, never scaffolding sections", () => {
  const body = buildDefaultBody(TASK_MD);
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  assert.deepEqual(headings, ["描述", "需求"]);
});

test("buildDefaultBody keeps requirement checkboxes verbatim", () => {
  const body = buildDefaultBody(TASK_MD);
  assert.match(body, /- \[ \] 未完成项 A\n- \[x\] 已完成项 B/);
});

test("buildDefaultBody fills empty sections with N/A", () => {
  const body = buildDefaultBody("# t\n\n## 描述\n\n## 需求\n");
  assert.equal(body, "## 描述\n\nN/A\n\n## 需求\n\nN/A\n");
});

test("renderTemplateBody maps fields by id and keeps template structure", () => {
  const body = renderTemplateBody(ISSUE_FORM, FIELDS);
  const headings = [...body.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1]!.trim());
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
