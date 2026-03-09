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
- `.ai-workspace/active/{task-id}/task.md` - 任务文件
- `.ai-workspace/active/{task-id}/review.md` - 审查报告

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 2. 阅读审查报告

仔细阅读 `review.md` 以理解：
- 所有阻塞项（必须修复）
- 所有主要问题（应该修复）
- 次要问题（可选优化）
- 审查者的建议和推荐

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

更新 `.ai-workspace/active/{task-id}/implementation.md`，追加修复部分。

### 7. 更新任务状态

更新 `.ai-workspace/active/{task-id}/task.md`：
- `current_step`：refinement
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}

### 8. 告知用户

输出格式：
```
Refinement complete for task {task-id}.

Fixes applied:
- Blockers fixed: {数量}/{总数}
- Major issues fixed: {数量}/{总数}
- Minor issues fixed: {数量}/{总数}
- All tests pass: {Yes/No}

Next step - re-review or commit:
- Re-review: execute the review-task skill with {task-id}
- Commit directly: execute the commit skill
```

## 输出模板

追加到 `implementation.md`：

```markdown
## 修复记录

### 审查反馈处理

#### 阻塞项修复
1. **{问题标题}**（来自 review.md）
   - **修复**：{做了什么修改}
   - **文件**：`{file-path}:{line-number}`
   - **验证**：{如何验证}

#### 主要问题修复
1. **{问题标题}**（来自 review.md）
   - **修复**：{做了什么修改}
   - **文件**：`{file-path}:{line-number}`

#### 次要问题处理
1. **{问题标题}**（来自 review.md）
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
- [ ] 更新了 implementation.md 的修复记录
- [ ] 更新了 task.md 中的任务状态
- [ ] 告知了用户下一步

## 注意事项

1. **前置条件**：必须有审查报告（review.md 存在）
2. **禁止自动提交**：不要自动执行 `git commit`。提醒用户手动提交
3. **范围纪律**：仅修复审查中标记的问题 —— 不添加额外变更
4. **不同意见**：如果不同意某个审查意见，在"未处理的问题"部分记录你的理由
5. **重新审查**：修复阻塞项后，建议重新运行 review-task 技能进行验证

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少审查报告：提示 "Review report not found, please run the review-task skill first"
- 修复后测试失败：输出测试错误，询问用户如何处理
