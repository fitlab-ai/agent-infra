---
name: close-dependabot
description: "关闭 Dependabot 安全告警并记录理由"
---

# 关闭 Dependabot 告警

关闭指定的 Dependabot 安全告警并记录合理的关闭理由。

## 执行流程

### 1. 获取告警信息

执行前先读取 `.agents/rules/security-alerts.md`，并按其中的 Dependabot 告警读取命令获取告警详情。

验证告警处于 `open` 状态。如果已被关闭/修复，告知用户并退出。

### 2. 展示告警详情

向用户展示关键信息：
```
安全告警 #{alert-number}

严重程度：{severity}
漏洞：{summary}
包名：{package-name}（{ecosystem}）
当前版本：{current-version}
受影响版本范围：{vulnerable-version-range}
修复版本：{first-patched-version}

GHSA：{ghsa-id}
CVE：{cve-id}
```

### 3. 询问关闭理由

提示用户选择理由：

1. **误报 (False Positive)** - 漏洞代码路径在本项目中未被使用
2. **无法利用 (Not Exploitable)** - 漏洞存在但在当前上下文中无法被利用
3. **已有缓解措施 (Mitigated)** - 通过其他方式缓解了风险（配置、网络隔离等）
4. **无修复版本 (No Fix Available)** - 无修复版本且风险可接受
5. **仅开发/测试依赖 (Dev/Test Dependency Only)** - 仅在开发/测试中使用，不在生产环境中
6. **取消** - 不关闭告警

### 4. 要求详细说明

如果用户选择关闭（非取消），要求提供详细说明：
- 最少 20 个字符
- 必须清楚说明为什么可以安全关闭该告警
- 应引用具体证据（代码搜索结果、配置等）

### 5. 最终确认

```
即将关闭安全告警 #{alert-number}：

告警：{summary}
严重程度：{severity}
原因：{选择的理由}
说明：{用户的说明}

确认？(y/N)
```

### 6. 执行关闭

按 `.agents/rules/security-alerts.md` 中的 Dependabot 告警关闭命令执行关闭操作，并传入映射后的 `{api-reason}` 与用户说明。

**API reason 映射**：
- 误报 -> `not_used` 或 `inaccurate`
- 无法利用 -> `tolerable_risk`
- 已有缓解措施 -> `tolerable_risk`
- 无修复版本 -> `tolerable_risk`
- 开发/测试依赖 -> `not_used`

### 7. 记录到任务（如存在）

如果有关联任务（搜索 `security_alert_number: <alert-number>`）：
获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

- 添加关闭记录到 task.md
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Alert Closed** by {agent} — Dependabot alert #{alert-number} dismissed: {reason}
  ```
- 归档任务

### 8. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
安全告警 #{alert-number} 已关闭。

告警：{summary}
严重程度：{severity}
原因：{reason}
说明：{explanation}

查看：{alert-url}

注意：如有需要，可在平台侧重新打开。

下一步 - 完成并归档任务（如有关联任务）：
  - Claude Code / OpenCode：/complete-task {task-id}
  - Gemini CLI：/agent-infra:complete-task {task-id}
  - Codex CLI：$complete-task {task-id}
```

## 注意事项

1. **谨慎处理高严重程度告警**：Critical/High 告警需要在关闭前进行充分分析。建议先执行 import-dependabot + analyze-task。
2. **真实的理由**：关闭记录保存在平台中，可能会被审计。
3. **定期复查**：已关闭的告警应定期复查，因为代码变更可能使关闭理由失效。
4. **优先修复**：关闭应作为最后手段。优先考虑升级、替换或缓解。

## 错误处理

- 告警未找到：提示 "Security alert #{number} not found"
- 已关闭：提示 "Alert #{number} is already {state}"
- 权限错误：提示 "No permission to modify alerts"
- 用户取消：提示 "Cancellation acknowledged"
