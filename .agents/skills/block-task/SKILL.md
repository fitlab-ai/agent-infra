---
name: block-task
description: >
  标记任务为阻塞状态并记录原因。
  当任务因外部阻塞无法推进、需要挂起并记录原因时使用。
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

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本步骤第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本步骤 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Block Task [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

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
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `status`：blocked
- `blocked_at`：{当前时间戳}
- `updated_at`：{当前时间戳}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Block Task** by {agent} — {一行原因}
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

> Issue 同步的 status label 规则见 `.agents/rules/issue-sync.md`。执行同步前先读取该文件，完成 upstream 仓库检测和权限检测。

如果存在有效的 `issue_number`，按 issue-sync.md 设置 `status: blocked`。

### 7. 完成校验

**释放短号**（先 `mv` 目录已成功，再 release；脚本幂等，未在注册表也返回 0）：

```bash
node .agents/scripts/task-short-id.js release "$task_id" || true
```

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate block-task .agents/workspace/blocked/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中「归档路径」之后、「解除阻塞时执行」之前的「可选：清理本任务的沙箱」块；任一不满足则整段省略。`{branch}` 取已读入的 task.md 的 `branch` 值（任务此时已移动到 blocked/，从 `.agents/workspace/blocked/{task-id}/task.md` 读取）。该块独立于「下一步」语义。

输出格式：
```
任务 {task-id} 已标记为阻塞。

阻塞原因：{摘要}
解除阻塞所需：{需要什么}
归档路径：.agents/workspace/blocked/{task-id}/

可选：清理本任务的沙箱
（任务已阻塞并移到 blocked/，沙箱容器和 per-branch 配置目录不会自动回收。如果不再需要可执行：）

ai sandbox rm {branch}

解除阻塞时执行：
  mv .agents/workspace/blocked/{task-id} .agents/workspace/active/{task-id}
  # 然后更新 task.md：status -> active，移除 blocked_at

下一步 - 检查任务状态（解除阻塞后）：
  - Claude Code / OpenCode：/check-task {task-ref}
  - Gemini CLI：/agent-infra:check-task {task-ref}
  - Codex CLI：$check-task {task-ref}
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
