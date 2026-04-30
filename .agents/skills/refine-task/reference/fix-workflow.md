# 修复工作流

在修复阶段修改代码之前先读取本文件。

## 规划修复

按以下顺序分类并确定优先级：
1. **先处理 Blocker**
2. **再处理 Major**
3. **最后处理 Minor**

对每一个问题，都要明确：
- 哪些文件必须修改
- 具体需要怎样修复
- 如何验证修复已经生效

详细优先级规则：
- 所有 Blocker 都必须最先修完
- 只要没有被 Blocker 阻塞，所有 Major 都应在同一轮一并修复
- 只有在 Blocker 和 Major 都解决后，Minor 才是可选项
- 如果你不同意某条审查意见，不要静默跳过，而是把分歧记录到 unresolved issues

## 执行修复

对每一项修复：
1. 读取受影响文件
2. 施加最小必要改动
3. 验证改动确实解决了审查反馈
4. 运行项目测试的 **smoke 子集**做即时反馈（参见 `test` skill）

## 运行测试验证

写 refinement 报告前，运行项目测试的 **core 子集**做最终验证，确保所有必需测试仍然通过。如果项目没有分层 script，回退到完整项目测试命令。

## 选择下一步分支

判断规则：
1. 始终将重新审查作为默认推荐的下一步，无论本轮修复了哪个级别的问题
2. 直接提交仅可作为附加选项，且仅在所有问题均已解决且改动明显低风险时
3. 如果仍有任何 `Blocker` 或 `Major` 未解决，不要提供直接提交选项

禁止规则：
- 绝对不要把直接提交写成唯一下一步——重新审查必须始终作为首要推荐

必用输出模板：

```text
任务 {task-id} 修复完成。

修复情况：
- 阻塞项修复：{数量}/{总数}
- 主要问题修复：{数量}/{总数}
- 次要问题修复：{数量}/{总数}
- 所有测试通过：{是/否}
- 审查输入：{review-artifact}
- 修复产物：{refinement-artifact}

下一步 - 重新审查或提交：
- 重新审查（始终推荐）：
  - Claude Code / OpenCode：/review-task {task-id}
  - Gemini CLI：/agent-infra:review-task {task-id}
  - Codex CLI：$review-task {task-id}
- 直接提交（可选；仅在所有问题已解决且风险可控时）：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

## 注意事项

1. **前置条件**：必须存在审查产物（`review.md` 或 `review-r{N}.md`）
2. **禁止自动提交**：不要执行 `git commit`
3. **范围约束**：只修复审查中列出的问题
4. **分歧处理**：如果不同意审查意见，要在报告里明确记录
5. **重新审查**：修复后始终推荐执行 `review-task`
6. **一致性**：最新审查产物、Activity Log 记录和修复报告必须引用同一轮次
