---
name: refine-task
description: >
  处理代码审查反馈并修复审查中发现的问题。按优先级（Blocker -> Major -> Minor）修复。
  仅处理审查中标记的问题，不添加额外变更。当用户要求修复审查问题时触发。参数：task-id。
---

# 修复审查问题

## 行为边界 / 关键规则

- 仅修复审查中标记的问题 —— 不要添加无关变更或额外的"改进"
- 不要自动提交。绝不自动执行 `git commit` 或 `git add`
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.agent-workspace/active/{task-id}/task.md` - 任务文件
- 至少一个审查产物：`review.md` 或 `review-r{N}.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果缺少 `task.md` 或没有任何审查产物，提示用户先完成前置步骤。

随后执行以下发现与校验：
1. 扫描任务目录中的审查产物文件（`review.md`、`review-r{N}.md`）
2. 取最高轮次的审查产物作为本次修复输入，记为 `{review-artifact}`
3. 扫描修复产物文件（`refinement.md`、`refinement-r{N}.md`）并确定本轮修复产物：
   - 如果不存在 `refinement.md` 且不存在 `refinement-r*.md` → 本轮为第 1 轮，产出 `refinement.md`
   - 如果存在 `refinement.md` 且不存在 `refinement-r*.md` → 本轮为第 2 轮，产出 `refinement-r2.md`
   - 如果存在 `refinement-r{N}.md` → 本轮为第 N+1 轮，产出 `refinement-r{N+1}.md`
   - 记录 `{refinement-round}` 和 `{refinement-artifact}`
4. 扫描实现报告文件（`implementation.md`、`implementation-r{N}.md`），取最高轮次作为修复上下文的 `{implementation-artifact}`
   - 记录 `{implementation-artifact}`
5. **一致性校验**：检查 `task.md` 的 `## 活动日志` 中最近一条 Code Review 记录的轮次号和文件名，是否与步骤 2 扫描到的最新审查产物匹配

若 Activity Log 记录与实际文件不匹配，立即停止并提示：
`Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists.`

### 2. 阅读审查与实现上下文

仔细阅读步骤 1 中确定的最新审查产物 `{review-artifact}` 和实现产物 `{implementation-artifact}` 以理解：
- 所有阻塞项（必须修复）
- 所有主要问题（应该修复）
- 次要问题（可选优化）
- 审查者的建议和推荐
- 当前实现和之前修复的上下文

### 3. 规划修复

分类并确定优先级：
1. **阻塞项优先**：必须解决所有阻塞项
2. **然后是主要问题**：处理所有主要问题
3. **最后是次要问题**：如有时间则处理（可选）

对于每个问题，确定：
- 需要修改哪些文件
- 具体要做哪些修改
- 如何验证修复

### 4. 执行代码修复

按优先级顺序修复问题：

**对于每个修复**：
1. 读取受影响的文件
2. 应用修复
3. 验证修复是否解决了审查意见
4. 运行相关测试

**修复原则**：
- 仅修复标记的问题 —— 不要添加无关变更
- 不要添加超出要求的额外"改进"
- 保持变更最小化和聚焦

### 5. 运行测试验证

执行项目的测试命令。参考 `test` 技能获取项目特定的测试命令。

确保修复后所有测试仍然通过。

### 6. 创建修复报告

创建 `.agent-workspace/active/{task-id}/{refinement-artifact}`。

### 7. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agent-workspace/active/{task-id}/task.md`：
- `current_step`：refinement
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 记录本轮修复产物：`{refinement-artifact}`（Round `{refinement-round}`）
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Refinement (Round {N}, for {review-artifact})** by {agent} — Fixed {n} blockers, {n} major, {n} minor issues → {refinement-artifact}
  ```

### 8. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务 {task-id} 修复完成。

修复情况：
- 阻塞项修复：{数量}/{总数}
- 主要问题修复：{数量}/{总数}
- 次要问题修复：{数量}/{总数}
- 所有测试通过：{是/否}
- 审查输入：{review-artifact}
- 修复产物：{refinement-artifact}

下一步 - 重新审查或提交：
- 重新审查：
  - Claude Code / OpenCode：/review-task {task-id}
  - Gemini CLI：/agent-infra:review-task {task-id}
  - Codex CLI：$review-task {task-id}
- 直接提交：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

## 输出模板

```markdown
# 修复报告

- **修复轮次**：Round {refinement-round}
- **产物文件**：`{refinement-artifact}`
- **审查输入**：`{review-artifact}`
- **实现上下文**：`{implementation-artifact}`

### 审查反馈处理

#### 阻塞项修复
1. **{问题标题}**（来自 {review-artifact}）
   - **修复**：{做了什么修改}
   - **文件**：`{file-path}:{line-number}`
   - **验证**：{如何验证}

#### 主要问题修复
1. **{问题标题}**（来自 {review-artifact}）
   - **修复**：{做了什么修改}
   - **文件**：`{file-path}:{line-number}`

#### 次要问题处理
1. **{问题标题}**（来自 {review-artifact}）
   - **修复**：{做了什么修改}

#### 未处理的问题
- {问题}：{未处理的原因，例如不同意审查建议}

### 修复后的测试结果
- 所有测试通过：{是/否}
- 测试输出：{摘要}
```

## 完成检查清单

- [ ] 阅读并理解了所有审查发现
- [ ] 修复了所有阻塞项
- [ ] 修复了所有主要问题
- [ ] 在适当情况下处理了次要问题
- [ ] 修复后所有测试通过
- [ ] 创建了 `{refinement-artifact}` 修复报告
- [ ] 更新了 task.md 中的任务状态
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）

## 注意事项

1. **前置条件**：必须有审查报告（`review.md` 或 `review-r{N}.md` 存在）
2. **禁止自动提交**：不要自动执行 `git commit`。提醒用户手动提交
3. **范围纪律**：仅修复审查中标记的问题 —— 不添加额外变更
4. **不同意见**：如果不同意某个审查意见，在"未处理的问题"部分记录你的理由
5. **重新审查**：修复阻塞项后，建议重新运行 review-task 技能进行验证
6. **一致性要求**：最新审查产物、Activity Log 记录和修复报告标题必须引用同一轮次文件
7. **版本化规则**：首轮修复使用 `refinement.md`；后续轮次使用 `refinement-r{N}.md`

## 停止

完成检查清单后，**立即停止**。等待用户审查修复结果并决定重新审查还是提交。

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少审查报告：提示 "Review report not found, please run the review-task skill first"
- 审查产物不一致：提示 "Review artifact mismatch: Activity Log references {expected} but file not found. Please verify the review artifact exists."
- 修复后测试失败：输出测试错误，询问用户如何处理
