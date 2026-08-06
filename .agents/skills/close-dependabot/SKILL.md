---
name: close-dependabot
description: >
  关闭 Dependabot 安全告警并记录理由。
  当某条 Dependabot 安全告警已处理或需按理由关闭时使用。
---

# 关闭 Dependabot 告警
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`gemini`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`gemini-cli`→`gemini`）或人工例外 `human`。


关闭指定的 Dependabot 安全告警并记录合理的关闭理由。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：本地生命周期边界

安全告警 API 仍由本技能处理；若存在关联任务，步骤 7 只声明一个本地 lifecycle intent，由核心统一提交基础元数据、日志、归档目录和短号。

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

```bash
agent-infra-internal task-lifecycle {task-id} close-dependabot --agent {standard-agent-token} \
  --alert-number {alert-number} --reason "{reason}"
```

仅 `status=applied|no-op` 视为本地归档完成。若 API 已关闭但 lifecycle 返回 `failed`，必须明确报告“远端已关闭、本地待恢复”，展示 recovery steps，并以同一 intent 重试；不得手工更新 task.md、移动目录或释放短号。

### 8. 告知用户

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) 第 7 步按告警号定位到了关联任务、(3) 该关联任务 task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中「注意：…」之后、「下一步」之前的「可选：清理本任务的沙箱」块；任一不满足则整段省略。`{branch}` 取第 7 步定位到的关联任务 task.md 的 `branch` 值。该块独立于「下一步」语义。

使用 `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
安全告警 #{alert-number} 已关闭。

告警：{summary}
严重程度：{severity}
原因：{reason}
说明：{explanation}

查看：{alert-url}

注意：如有需要，可在平台侧重新打开。

可选：清理本任务的沙箱
（关联任务的沙箱容器和 per-branch 配置目录不会自动回收。如果不再需要可执行：）

ai sandbox rm {branch}

下一步 - 完成并归档任务（如有关联任务）：
{next-step-commands}
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
