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
- `.agent-workspace/active/{task-id}/task.md`
- `.agent-workspace/blocked/{task-id}/task.md`
- `.agent-workspace/completed/{task-id}/task.md`

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

### 4. 探测交付状态

依次执行以下探测；任一步失败时，降级到“模式 C：开发中”，不要编造无法确认的信息。

**a) 提取 commit hash**

从 task.md 的 `## Activity Log` 中匹配最后一条 `**Commit** by` 记录，活动日志格式固定为：

```text
**Commit** by {agent} — {hash} {subject}
```

提取第一个词作为 commit hash；如果找不到，标记为“无 commit”。

**b) 检测 commit 是否在受保护分支上**

如果存在 commit hash，执行：

```bash
git branch -a --contains {commit-hash} 2>/dev/null
```

判断规则：
- 输出包含 `main` 或 `master` -> 已合入主分支，记录分支名
- 输出匹配 `{major}.{minor}.x` 模式的分支名 -> 已合入版本分支，记录分支名
- 都不匹配 -> 未合入受保护分支

**c) 检测关联 PR**

检查 task.md 的 `pr_number` 字段；如果存在，执行：

```bash
gh pr view {pr-number} --json state,mergedAt
```

根据返回结果识别 PR 是 `OPEN`、`MERGED` 还是其他状态。

**d) 检测 Issue 状态**

执行：

```bash
gh issue view {issue-number} --json state
```

记录 Issue 当前是 `OPEN` 还是 `CLOSED`。

**e) 综合判定交付模式**

按以下优先级确定摘要模式：

| 条件 | 模式 |
|------|------|
| commit 已在受保护分支上 | 模式 A：已完成 |
| 有 PR，且状态为 `OPEN` 或 `MERGED` | 模式 B：PR 阶段 |
| 其他情况 | 模式 C：开发中 |

优先级必须为 `模式 A > 模式 B > 模式 C`。即使存在 PR，只要 commit 已在受保护分支上，也按“已完成”处理。

### 5. 生成进度摘要

生成面向**项目经理和利益相关者**的清晰进度摘要：

三种模式共享以下要求：
- 头部去掉 `**任务 ID**` 行，并在状态描述中展示 commit hash（如有）
- 如需提供链接，用 `**相关链接**` 替换 `**相关文档**`，且只包含 GitHub 上可访问的资源
- 脚注统一为 `*由 AI 自动生成 · 内部追踪：{task-id}*`

#### 模式 A：已完成

适用条件：commit 已在 `main`、`master` 或 `{major}.{minor}.x` 版本分支上。

```markdown
## 任务进度更新

**更新时间**：{当前时间}
**状态**：✅ 已完成，代码已合入 `{branch}`（`{commit-short}`）

### 完成总结

- [x] 需求分析 - {完成时间}
  - {1-2 个关键要点}
- [x] 技术设计 - {完成时间}
  - {决策和理由}
- [x] 实现 - {完成时间}
  - {核心实现内容}
- [x] 最终交付 - {完成时间}
  - {合入方式或结果}

### 最终变更

| 类型 | 内容 |
|------|------|
| 分支 | `{branch}` |
| Commit | [`{commit-short}`](../../commit/{commit-hash}) |
| PR | {PR 链接或 `N/A`} |
| Issue | {issue-state} |

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

要求：
- 使用“完成总结”替代“已完成步骤”，更简洁地说明交付结果
- 不要包含“当前进度”或“下一步”段落
- 链接信息保留在“最终变更”表格中；PR 仅在存在时附上

#### 模式 B：PR 阶段

适用条件：不存在已合入受保护分支的 commit，但存在状态为 `OPEN` 或 `MERGED` 的关联 PR。

```markdown
## 任务进度更新

**更新时间**：{当前时间}
**状态**：PR [#{pr-number}](../../pull/{pr-number}) {待审查或已合并}{（`{commit-short}`）可选}

### 已完成步骤

- [x] 需求分析 - {完成时间}
  - {1-2 个关键要点}
- [x] 技术设计 - {完成时间}
  - {决策和理由}
- [x] 实现 - {完成时间}
  - {核心实现内容}
- [ ] 代码审查
- [ ] 最终提交

### 当前进度

{当前 PR 状态、审查结论或合并情况}

### 相关链接

- PR：[#{pr-number}](../../pull/{pr-number})

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

要求：
- 保留“已完成步骤”和“当前进度”
- 不要包含“下一步”段落，因为 PR 本身就是下一步的载体
- 相关链接只列 GitHub 可访问资源，至少包含 PR

#### 模式 C：开发中

适用条件：既未检测到已合入受保护分支的 commit，也没有可用的 `OPEN`/`MERGED` PR。

```markdown
## 任务进度更新

**更新时间**：{当前时间}
**状态**：{状态描述}{（`{commit-short}`）可选}

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

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

要求：
- 保留“已完成步骤”“当前进度”“下一步”
- 不要包含“相关链接”段落，因为此时还没有适合公开引用的 GitHub 资源

**摘要原则**：
- **面向利益相关者**：关注进展、决策和时间线
- **状态真实**：依据探测结果选择模式，不要假设“提交 -> PR -> 合入”的固定路径
- **简洁**：避免过多技术细节
- **逻辑清晰**：按时间顺序呈现进展
- **可读性强**：使用通俗语言，避免行话

### 6. 发布到 Issue

```bash
gh issue comment {issue-number} --body "$(cat <<'EOF'
{生成的摘要}
EOF
)"
```

### 7. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

在 task.md 中添加或更新 `last_synced_at` 字段为 `{当前时间}`。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to Issue** by {agent} — Progress synced to Issue #{issue-number}
  ```

### 8. 告知用户

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
