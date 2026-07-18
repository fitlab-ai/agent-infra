---
name: block-task
description: >
  标记任务为阻塞状态并记录原因。
  当任务因外部阻塞无法推进、需要挂起并记录原因时使用。
  仅当对话包含可解析的任务引用，且能在本技能支持的任务状态或目录中
  定位到对应的 task.md 时，才可自动调用本技能。
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

## 步骤开始：本地生命周期边界

确认前置条件后，由步骤 3 的单次 lifecycle intent 原子写入 started/done 日志、基础元数据、目录转移和短号释放；本步骤不得提前手工写入其中任一项。

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

### 3. 执行本地生命周期意图

```bash
agent-infra-internal task-lifecycle {task-id} block --agent {agent} \
  --reason "{一行原因}" --unblock-condition "{解除阻塞条件}"
```

解析 stdout 单 JSON。仅 `status=applied|no-op` 视为本地完成；`status=failed` 时展示 `error` 与 `completedSteps`/`pendingSteps`，不得宣称任务已阻塞。生命周期核心统一维护 `status`/`blocked_at`、阻塞信息、Activity Log、目录与短号。

### 4. 验证本地终态

确认结构化结果的 `targetState=blocked`、目标路径为 `.agents/workspace/blocked/{task-id}`、短号效果已提交，并检查：

```bash
ls .agents/workspace/blocked/{task-id}/task.md
```

### 5. 保留恢复身份

记录 lifecycle 结果中的请求身份与规范 metadata，供失败后以同一 intent 安全重试；不得手工补写局部状态。

### 6. 同步到 Issue（可选）

检查 `task.md` 中是否存在有效的 `issue_number`。如果没有，跳过。

> Issue 同步的 status label 规则见 `.agents/rules/issue-sync.md`。执行同步前先读取该文件，完成 upstream 仓库检测和权限检测。

如果存在有效的 `issue_number`，按 issue-sync.md 设置 `status: blocked`。

### 7. 完成校验

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
  agent-infra-internal task-lifecycle {task-id} activate --agent {agent} --note "{恢复说明}"

下一步 - 检查任务状态（解除阻塞后）：
  - Claude Code / OpenCode：/check-task {task-ref}
  - Gemini CLI：/{{project}}:check-task {task-ref}
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
agent-infra-internal task-lifecycle {task-id} activate --agent {agent} --note "{恢复说明}"
```

成功后从保留的 `current_step` 继续。失败时按结构化 recovery 字段以同一 intent 重试，不手工移动目录或编辑基础元数据。

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
