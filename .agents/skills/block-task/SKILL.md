---
name: block-task
description: "标记任务为阻塞状态并记录原因"
---

# 标记任务阻塞

## 行为边界 / 关键规则

- 本命令更新任务元数据并物理移动任务目录
- 仅在确实无法继续时才阻塞 —— 如果是可以克服的困难，先尝试解决

## 使用场景

- **技术问题**：无法解决的 Bug、缺少依赖、基础设施问题
- **需求问题**：需求不明确、规格冲突、待定决策
- **资源问题**：缺少访问权限、等待外部团队、被其他任务阻塞
- **需要决策**：待定的架构决策、需要利益相关者批准

## 执行步骤

### 1. 验证任务存在

检查任务是否存在于 `.agents/workspace/active/{task-id}/`。

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果未找到，检查其他目录并告知用户。

### 2. 分析阻塞原因

阻塞之前，彻底分析：
- [ ] 具体的问题是什么？
- [ ] 根本原因是什么？
- [ ] 已经尝试了哪些解决方案？
- [ ] 需要什么帮助或信息才能解除阻塞？

### 3. 更新任务元数据

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `status`：blocked
- `blocked_at`：{当前时间戳}
- `updated_at`：{当前时间戳}
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Blocked** by {agent} — {一行原因}
  ```

在 task.md 中添加阻塞信息部分。

### 4. 移动任务到 blocked 目录

```bash
mv .agents/workspace/active/{task-id} .agents/workspace/blocked/{task-id}
```

### 5. 验证移动

```bash
ls .agents/workspace/blocked/{task-id}/task.md
```

### 6. 同步到 Issue（可选）

检查 `task.md` 中是否存在有效的 `issue_number`。如果没有，跳过。

> Issue 同步的 status label 规则见 `.agents/rules/issue-sync.md`。执行同步前先读取该文件。

如果存在有效的 `issue_number`，直接设置 `status: blocked`。

### 7. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务 {task-id} 已标记为阻塞。

阻塞原因：{摘要}
解除阻塞所需：{需要什么}
归档路径：.agents/workspace/blocked/{task-id}/

解除阻塞时执行：
  mv .agents/workspace/blocked/{task-id} .agents/workspace/active/{task-id}
  # 然后更新 task.md：status -> active，移除 blocked_at

下一步 - 检查任务状态（解除阻塞后）：
  - Claude Code / OpenCode：/check-task {task-id}
  - Gemini CLI：/agent-infra:check-task {task-id}
  - Codex CLI：$check-task {task-id}
```

## 输出模板

添加到 task.md 的阻塞信息部分：

```markdown
## 阻塞信息

### 摘要
{阻塞原因的一行描述}

### 问题描述
{阻塞问题的详细描述}

### 根本原因
{分析为什么会被阻塞}

### 已尝试的解决方案
- {尝试了什么以及为什么没有成功}

### 解除阻塞所需
- {需要什么：信息、决策、资源等}

### 解除阻塞条件
{允许恢复工作的具体条件}

### 备选方案
{考虑过的任何变通方法或替代方案}
```

## 完成检查清单

- [ ] 分析并记录了阻塞原因
- [ ] 更新了 task.md 的阻塞状态和阻塞信息
- [ ] 将任务目录移动到 `.agents/workspace/blocked/`
- [ ] 验证了移动成功
- [ ] 告知了用户如何解除阻塞

## 解除阻塞

当阻塞问题解决后：

```bash
# 1. 移回 active
mv .agents/workspace/blocked/{task-id} .agents/workspace/active/{task-id}

# 2. 更新 task.md：设置 status 为 active，更新时间戳
# 3. 从中断处继续（检查 current_step）
```

## 注意事项

1. **何时阻塞**：仅在确实无法继续时才阻塞。如果是可以克服的困难，先尝试解决。
2. **文档化**：阻塞信息越详细，其他人越容易帮助解除阻塞。
3. **多个阻塞项**：如果有多个阻塞问题，全部列出。
4. **超时**：如果任务被阻塞很长时间，考虑是否需要重新设计或取消。

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 任务已被阻塞：提示 "Task {task-id} is already in blocked directory"
- 任务已完成：提示 "Task {task-id} is already completed"
- 移动失败：提示错误并建议手动移动
