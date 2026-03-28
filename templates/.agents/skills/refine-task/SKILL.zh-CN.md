---
name: refine-task
description: "处理代码审查反馈并修复问题"
---

# 修复审查问题

修复审查发现的问题，并产出 `refinement.md` 或 `refinement-r{N}.md`。

## 行为边界 / 关键规则

- 只修复审查产物中记录的问题
- 绝不自动执行 `git add` 或 `git commit`
- 执行本技能后，你**必须**立即更新 task.md

## 执行步骤

### 1. 验证前置条件

要求存在：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个审查产物：`review.md` 或 `review-r{N}.md`

在前置检查阶段必须记录 `{review-artifact}`、`{refinement-round}`、`{refinement-artifact}`，并从最新实现报告中记录 `{implementation-artifact}`。

同时校验 Activity Log 中最近一条 Code Review 记录；如果引用了不存在的文件，立即停止并输出：
`Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists.`

### 2. 阅读审查与实现上下文

在修改代码前先读取最新的 `{review-artifact}` 和 `{implementation-artifact}`。

### 3. 规划并执行修复

按 Blocker -> Major -> Minor 的顺序处理，始终保持改动聚焦。

> 详细修复流程、优先级和验证循环见 `reference/fix-workflow.md`。执行此步骤前先读取 `reference/fix-workflow.md`。

### 4. 运行测试验证

修复后运行项目测试命令，并把修复范围限制在审查结论内。

### 5. 编写修复报告

创建 `.agents/workspace/active/{task-id}/{refinement-artifact}`。

> 报告结构和示例章节见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 task.md：
- 审查 `## 需求` 段落，仅把因本轮修复而新满足且有测试通过支撑的条目从 `- [ ]` 勾为 `- [x]`
- 追加：
  `- {yyyy-MM-dd HH:mm:ss} — **Refinement (Round {N}, for {review-artifact})** by {agent} — Fixed {n} blockers, {n} major, {n} minor issues → {refinement-artifact}`

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`
- 设置 `status: in-progress`
- 为本轮改动涉及模块补充 `in:` label
- 同步 `## 需求` 中已勾选项到 Issue body
- 发布 `{refinement-artifact}` 评论

### 7. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出修复摘要后，根据修复的问题严重程度选择下一步：

如果修复了 Blocker 或 Major（推荐重新审查）：

```
下一步 - 代码审查：
  - Claude Code / OpenCode：/review-task {task-id}
  - Gemini CLI：/agent-infra:review-task {task-id}
  - Codex CLI：$review-task {task-id}
```

如果仅修复 Minor（可直接提交）：

```
下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

## 完成检查清单

- [ ] 已读取最新审查与实现上下文
- [ ] 已修复所有必需的 Blocker 和 Major 问题
- [ ] 已写出 `{refinement-artifact}`
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已根据剩余风险推荐正确的下一步

## 注意事项

- 首轮修复使用 `refinement.md`，后续轮次使用 `refinement-r{N}.md`
- 若不同意审查意见，要在报告的未解决问题中记录理由
- 不要把范围扩展到审查项之外

## 停止

完成检查清单后立即停止。

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少审查报告：`Review report not found, please run the review-task skill first`
- 审查产物不一致：`Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists.`
