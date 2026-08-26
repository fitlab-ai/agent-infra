---
name: block-task
description: >
  标记任务为阻塞状态并记录原因。
  当任务因外部阻塞无法推进、需要挂起并记录原因时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 标记任务阻塞
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`antigravity`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`antigravity-cli`→`antigravity`）或人工例外 `human`。


## 行为边界 / 关键规则

- 本命令更新任务元数据并物理移动任务目录
- 仅在确实无法继续时才阻塞 —— 如果是可以克服的困难，先尝试解决

## 使用场景

- **技术问题**：无法解决的 Bug、缺少依赖、基础设施问题
- **需求问题**：需求不明确、规格冲突、待定决策
- **资源问题**：缺少访问权限、等待外部团队、被其他任务阻塞
- **需要决策**：待定的架构决策、需要利益相关者批准

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

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
agent-infra-internal task-lifecycle {task-id} block --agent {standard-agent-token} \
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

如果存在有效的 `issue_number`，调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status blocked`。
随后调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` 更新 task 评论。

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} block-task.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中「归档路径」之后、「解除阻塞时执行」之前的「可选：清理本任务的沙箱」块；任一不满足则整段省略。blocked task-bound 沙箱受保护，不通过自动批量清理；如确需清理，请人工核对身份。该块独立于「下一步」语义。

输出格式：
使用 `agent-infra-internal agent-client next-steps --skill check-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
任务 {task-id} 已标记为阻塞。

阻塞原因：{摘要}
解除阻塞所需：{需要什么}
归档路径：.agents/workspace/blocked/{task-id}/

可选：清理本任务的沙箱
（任务已阻塞并移到 blocked/，task-bound 沙箱受保护，不会被 `ai sandbox rm --unbound` 自动删除；如确需清理，请先人工核对容器、控制清单和工作树身份。）

解除阻塞时执行：
  agent-infra-internal task-lifecycle {task-id} activate --agent {standard-agent-token} --note "{恢复说明}"

下一步 - 检查任务状态（解除阻塞后）：
{next-step-commands}
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
agent-infra-internal task-lifecycle {task-id} activate --agent {standard-agent-token} --note "{恢复说明}"
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
