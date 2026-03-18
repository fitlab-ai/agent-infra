---
name: import-codescan
description: >
  导入 Code Scanning（CodeQL）告警并创建修复任务。
  当用户要求导入 Code Scanning 告警时触发。参数：告警编号。
---

# 导入 Code Scanning 告警

导入指定的 Code Scanning（CodeQL）告警并创建修复任务。

## 行为边界 / 关键规则

- 本技能仅负责导入告警并创建任务骨架 —— 不直接修改业务代码或关闭告警
- 不要自动提交。绝不自动执行 `git commit` 或 `git add`
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行流程

### 1. 获取告警信息

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

提取关键信息：
- `number`：告警编号
- `state`：状态（open/dismissed/fixed）
- `rule`：规则信息（id、severity、description、security_severity_level）
- `tool`：扫描工具信息（name、version）
- `most_recent_instance`：位置（path、start_line、end_line）、消息
- `html_url`：GitHub 告警链接

### 2. 创建任务目录和文件

检查是否已存在该告警的任务。如果不存在，创建：

目录：`.agent-workspace/active/TASK-{yyyyMMdd-HHmmss}/`

任务元数据：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
codescan_alert_number: <alert-number>
severity: <critical/high/medium/low>
rule_id: <rule-id>
tool: <tool-name>
```

### 3. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 task.md：`current_step` -> `requirement-analysis`。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Import Code Scanning Alert** by {agent} — Code Scanning alert #{alert-number} imported
  ```

### 4. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
Code Scanning 告警 #{alert-number} 已导入。

告警信息：
- 严重程度：{severity}
- 规则：{rule-id}
- 位置：{file-path}:{line-number}

任务信息：
- 任务 ID：{task-id}

下一步：
  - Claude Code / OpenCode：/analyze-task {task-id}
  - Gemini CLI：/agent-orchestrator:analyze-task {task-id}
  - Codex CLI：$analyze-task {task-id}
```

## 注意事项

1. **严重程度优先级**：Critical/High -> 立即处理。Medium -> 计划处理。Low -> 可延后。
2. **范围**：本技能仅负责导入告警并创建任务；风险评估由 `analyze-task` 负责。
3. **后续动作**：导入后先执行 `analyze-task`，分析完成后再决定修复或关闭。

## 完成检查清单

- [ ] 获取并记录了告警关键信息
- [ ] 创建或确认了对应的任务目录与任务文件
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）

## 错误处理

- 告警未找到：提示 "Code Scanning alert #{number} not found"
- 告警已关闭：询问用户是否继续分析
- 网络/权限错误：提示相应信息
