---
name: close-codescan
description: "关闭 Code Scanning 告警并记录理由"
---

# 关闭 Code Scanning 告警

关闭指定的 Code Scanning（CodeQL）告警并记录合理的关闭理由。

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

**API reason 映射**（按 GitHub Code Scanning API）：
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
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Alert Closed** by {agent} — Code Scanning alert #{alert-number} dismissed: {reason}
  ```
- 归档任务

### 8. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
Code Scanning 告警 #{alert-number} 已关闭。

规则：{rule.id}
位置：{location.path}:{location.start_line}
原因：{reason}
说明：{explanation}

查看：{html_url}

注意：如有需要，可在 GitHub 上重新打开。

下一步 - 完成并归档任务（如有关联任务）：
  - Claude Code / OpenCode：/complete-task {task-id}
  - Gemini CLI：/agent-infra:complete-task {task-id}
  - Codex CLI：$complete-task {task-id}
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
