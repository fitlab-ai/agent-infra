---
name: close-codescan
description: >
  关闭 Code Scanning 告警并记录理由。
  当某条 Code Scanning 告警已处理或需按理由关闭时使用。
---

# 关闭 Code Scanning 告警

关闭指定的 Code Scanning（CodeQL）告警并记录合理的关闭理由。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本步骤第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本步骤 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Close Codescan [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

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
获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

- 添加关闭记录到 task.md
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Close Codescan** by {agent} — Code Scanning alert #{alert-number} dismissed: {reason}
  ```
- 归档任务
- **释放短号**（归档目录已 mv 成功，再 release；脚本幂等）：

  ```bash
  node .agents/scripts/task-short-id.js release "$task_id" || true
  ```

### 8. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) 第 7 步按告警号定位到了关联任务、(3) 该关联任务 task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中「注意：…」之后、「下一步」之前的「可选：清理本任务的沙箱」块；任一不满足则整段省略。`{branch}` 取第 7 步定位到的关联任务 task.md 的 `branch` 值。该块独立于「下一步」语义。

```
Code Scanning 告警 #{alert-number} 已关闭。

规则：{rule.id}
位置：{location.path}:{location.start_line}
原因：{reason}
说明：{explanation}

查看：{html_url}

注意：如有需要，可在 平台上重新打开。

可选：清理本任务的沙箱
（关联任务的沙箱容器和 per-branch 配置目录不会自动回收。如果不再需要可执行：）

ai sandbox rm {branch}

下一步 - 完成并归档任务（如有关联任务）：
  - Claude Code / OpenCode：/complete-task {task-ref}
  - Gemini CLI：/agent-infra:complete-task {task-ref}
  - Codex CLI：$complete-task {task-ref}
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


