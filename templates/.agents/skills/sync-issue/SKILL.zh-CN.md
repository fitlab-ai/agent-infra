---
name: sync-issue
description: >
  将任务处理进度同步到对应的 GitHub Issue 评论。
  当用户要求同步进度到 Issue 时触发。参数：task-id。
---

# 同步进度到 Issue

将任务处理进度同步到关联的 GitHub Issue。参数：task-id。

## 执行流程

### 1. 验证任务存在

按优先顺序搜索任务：
- `.ai-workspace/active/{task-id}/task.md`
- `.ai-workspace/blocked/{task-id}/task.md`
- `.ai-workspace/completed/{task-id}/task.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

### 2. 读取任务信息

从 task.md 中提取：
- `issue_number`（必需 —— 如果缺失，提示用户）
- 任务标题、描述、状态
- `current_step`、`created_at`、`updated_at`

### 3. 读取上下文文件

检查并读取（如存在）：
- `analysis.md` - 需求分析
- `plan.md` - 技术方案
- `implementation.md` - 实现报告
- `review.md` - 审查报告

### 4. 生成进度摘要

生成面向**项目经理和利益相关者**的清晰进度摘要：

```markdown
## 任务进度更新

**任务 ID**：{task-id}
**更新时间**：{当前时间}
**状态**：{状态描述}

### 已完成步骤

- [x] 需求分析 - {完成时间}
  - {1-2 个关键要点}
- [x] 技术设计 - {完成时间}
  - {决策和理由}
- [ ] 实现（进行中）
- [ ] 代码审查
- [ ] 最终提交

### 当前进度

{当前步骤的描述}

### 下一步

{接下来需要做什么}

### 相关文档

- 任务：`.ai-workspace/{status}/{task-id}/task.md`
- 分析：`.ai-workspace/{status}/{task-id}/analysis.md`
- 方案：`.ai-workspace/{status}/{task-id}/plan.md`

---
*由 AI 自动生成 - [任务管理](.agents/README.md)*
```

**摘要原则**：
- **面向利益相关者**：关注进展、决策和时间线
- **简洁**：避免过多技术细节
- **逻辑清晰**：按时间顺序呈现进展
- **可读性强**：使用通俗语言，避免行话

### 5. 发布到 Issue

```bash
gh issue comment {issue-number} --body "$(cat <<'EOF'
{生成的摘要}
EOF
)"
```

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

在 task.md 中添加或更新 `last_synced_at` 字段为 `{当前时间}`。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to Issue** by {agent} — Progress synced to Issue #{issue-number}
  ```

### 7. 告知用户

```
进度已同步到 Issue #{issue-number}。

已同步内容：
- 已完成步骤：{数量}
- 当前状态：{状态}
- 下一步：{描述}

查看：https://github.com/{owner}/{repo}/issues/{issue-number}
```

## 注意事项

1. **需要 Issue 编号**：任务的 task.md 中必须有 `issue_number`。如果缺失，提示用户。
2. **受众**：`sync-issue` 技能面向利益相关者；`sync-pr` 技能面向代码审查者。关注点不同。
3. **同步时机**：在完成重要阶段（分析、设计、实现、审查）或被阻塞时同步。
4. **避免刷屏**：不要同步过于频繁。

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少 Issue 编号：提示 "Task has no issue_number field"
- Issue 未找到：提示 "Issue #{number} not found"
- gh 认证失败：提示 "Please check GitHub CLI authentication"
