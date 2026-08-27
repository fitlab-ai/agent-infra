---
name: close-codescan
description: >
  关闭 Code Scanning 告警并记录理由。
  当某条 Code Scanning 告警已处理或需按理由关闭时使用。
---

# 关闭 Code Scanning 告警
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`antigravity`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`antigravity-cli`→`antigravity`）或人工例外 `human`。


关闭指定的 Code Scanning（CodeQL）告警并记录合理的关闭理由。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：本地生命周期边界

安全告警 API 仍由本技能处理；若存在关联任务，步骤 7 只声明一个本地 lifecycle intent，由核心统一提交基础元数据、日志、归档目录和短号。

## 执行流程

### 1. 获取告警信息

执行前先读取 `.agents/rules/security-alerts.md`，并按其中的 Code Scanning 告警读取命令获取告警详情。

验证告警处于 `open` 状态。如果已被关闭/修复，告知用户并退出。

### 2. 展示告警详情

```
Code Scanning 告警 #{alert-number}

严重程度：{security_severity_level}
规则：{rule.id} - {rule.description}
扫描工具：{tool.name}
位置：{location.path}:{location.start_line}
消息：{message}
```

### 3. 询问关闭理由

提示用户选择理由：

1. **误报 (False Positive)** - CodeQL 规则误判；代码不存在此安全问题
2. **不会修复 (Won't Fix)** - 已知问题但基于架构或业务原因不予修复
3. **测试代码 (Used in Tests)** - 仅在测试代码中出现，不影响生产环境安全
4. **取消** - 不关闭告警

### 4. 要求详细说明

如果用户选择关闭（非取消），要求提供详细说明：
- 最少 20 个字符
- 必须清楚说明为什么可以安全关闭该告警
- 如果是误报，说明为什么代码不存在该安全问题
- 如果是不修复，说明技术或业务原因

### 5. 最终确认

```
即将关闭 Code Scanning 告警 #{alert-number}：

规则：{rule.id}
位置：{location.path}:{location.start_line}
原因：{选择的理由}
说明：{用户的说明}

确认？(y/N)
```

### 6. 执行关闭

按 `.agents/rules/security-alerts.md` 中的 Code Scanning 告警关闭命令执行关闭操作，并传入映射后的 `{api-reason}` 与用户说明。

**API reason 映射**（按 Code Scanning API）：
- 误报 -> `false positive`
- 不会修复 -> `won't fix`
- 测试代码 -> `used in tests`

### 7. 记录到任务（如存在）

如果有关联任务（搜索 `codescan_alert_number: <alert-number>`）：

```bash
agent-infra-internal task-lifecycle {task-id} close-codescan --agent {standard-agent-token} \
  --alert-number {alert-number} --reason "{reason}"
```

仅 `status=applied|no-op` 视为本地归档完成。若 API 已关闭但 lifecycle 返回 `failed`，必须明确报告“远端已关闭、本地待恢复”，展示 recovery steps，并以同一 intent 重试；不得手工更新 task.md、移动目录或释放短号。

### 8. 告知用户

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) 第 7 步按告警号定位到了关联任务、(3) 该任务 task.md 的 `branch` 存在且不是 `main` / `master`、(4) 任务状态与沙箱 workspace identity 已交叉校验且无冲突时，才渲染清理提示。状态和 identity 决定命令：仅 `completed` + `task-bound` 使用完整 `{task-id}`；仅在明确核对为 `branch-only` 时使用 `{branch}`；`active` 不渲染自动清理命令；`blocked` / `archive` 只渲染人工核对提示，不渲染命令。状态或 identity 缺失、冲突时整段省略；关闭告警本身不能推断任务已完成。该块独立于「下一步」语义。

使用 `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
Code Scanning 告警 #{alert-number} 已关闭。

规则：{rule.id}
位置：{location.path}:{location.start_line}
原因：{reason}
说明：{explanation}

查看：{html_url}

注意：如有需要，可在 平台上重新打开。

可选：清理本任务的沙箱
（仅在关联任务为 `completed` 且 identity 为 `task-bound` 时，使用完整任务 ID：）

ai sandbox rm {task-id}

（仅在明确核对 identity 为 `branch-only` 时，使用分支名：）

ai sandbox rm {branch}

下一步 - 完成并归档任务（如有关联任务）：
{next-step-commands}
```

## 注意事项

1. **谨慎处理高严重程度告警**：Critical/High 告警需要充分分析。建议先执行 import-codescan + analyze-task。
2. **真实的理由**：关闭记录保存在平台中，可能会被审计。
3. **定期复查**：已关闭的告警应定期复查。
4. **优先修复**：关闭应作为最后手段。

## 错误处理

- 告警未找到：提示 "Code Scanning alert #{number} not found"
- 已关闭：提示 "Alert #{number} is already {state}"
- 权限错误：提示 "No permission to modify alerts"
- 用户取消：提示 "Cancellation acknowledged"
