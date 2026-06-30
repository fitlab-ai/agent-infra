---
name: import-dependabot
description: >
  导入 Dependabot 安全告警并创建修复任务。
  当某条 Dependabot 安全告警需要转为受跟踪的修复任务时使用。
---

# 导入 Dependabot 安全告警

导入指定的 Dependabot 安全告警并创建修复任务。

## 行为边界 / 关键规则

- 本技能仅负责导入告警并创建任务骨架 —— 不直接修改业务代码或关闭告警
- 不要自动提交。绝不自动执行 `git commit` 或 `git add`
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：记录开始时间

本技能会**创建** task.md，开始时尚无文件可写。先在内存记录开始时间 `started_at`（`date "+%Y-%m-%d %H:%M:%S%:z"`）；在最后写活动日志时**一次性补两条**——started 行用 `started_at`、done 行用完成时间，二者同基名（started 行 action 加 ` [started]` 后缀、note 用 `started`）：

```
- {started_at} — **Import Dependabot [started]** by {agent} — started
- {done_at} — **Import Dependabot** by {agent} — {完成说明}
```

`ai task log` 会按基名把两条配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行流程

### 1. 获取告警信息

执行前先读取 `.agents/rules/security-alerts.md`，并按其中的 Dependabot 告警读取命令获取告警详情。

提取关键信息：
- `number`：告警编号
- `state`：状态（open/dismissed/fixed）
- `security_advisory`：安全公告详情（ghsa_id、cve_id、severity、summary、description）
- `dependency`：受影响的依赖（包名、生态系统、清单路径）
- `security_vulnerability`：受影响版本范围、首个修复版本

### 2. 创建任务目录和文件

检查 `.agents/workspace/active/` 中是否已存在该告警的任务。
- 如果找到，**默认复用现有任务**，不询问用户；在最终告知中明确「已复用现有任务 `{task-id}`，未重新导入」。如需重新导入，需先归档/删除已有任务
- 如果未找到，创建新任务

创建目录：`.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`

任务元数据需包含：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
security_alert_number: <alert-number>
cve_id: <CVE-ID>
ghsa_id: <GHSA-ID>
```

### 3. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 task.md：`current_step` -> `requirement-analysis`。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Dependabot** by {agent} — Dependabot alert #{alert-number} imported
  ```

### 4. 完成校验

**先调用短号分配**（保证注册表 entry 已分配；完成校验阶段会读取）：

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

如失败（退出码非 0），按提示「归档若干任务」或「调高 task.shortIdLength」处理；不要继续执行后续步骤。

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate import-dependabot .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 5. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

```
安全告警 #{alert-number} 已导入。

漏洞信息：
- 严重程度：{severity}
- CVE/GHSA：{cve-id} / {ghsa-id}
- 受影响包：{package-name}

任务信息：
- 任务 ID：{task-id}（短号 {task-ref}）

产出文件：
- 任务文件：.agents/workspace/active/{task-id}/task.md

下一步：
  - Claude Code / OpenCode：/analyze-task {task-ref}
  - Gemini CLI：/agent-infra:analyze-task {task-ref}
  - Codex CLI：$analyze-task {task-ref}
```



## 完成检查清单

- [ ] 获取并记录了告警关键信息
- [ ] 创建或确认了对应的任务目录与任务文件
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）

## 错误处理

- 告警未找到：提示 "Security alert #{number} not found"
- 告警已关闭：**默认仍继续创建/复用任务**，并在告知用户中明确该告警当前状态（dismissed/fixed）；用户可视情况手动归档任务
- 网络/权限错误：提示相应信息
