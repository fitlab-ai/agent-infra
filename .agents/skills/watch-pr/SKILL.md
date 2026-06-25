---
name: watch-pr
description: >
  监控 PR 的 required checks 并在失败时自愈。
  当需要监控 PR 的 required checks 并在失败时自愈时使用。
---

# 监控 Pull Request

在 `create-pr` 之后持续监控 PR 的 required CI checks：全绿则引导合入，required check 失败则自动拉日志、本地修复并推送、重新轮询；达修复上限或属非代码层/不可定位失败则停止并向用户求助。平台专属命令集中在 `.agents/rules/pr-checks-commands.md`，本技能正文保持平台无关。

## 行为边界 / 关键规则

- 仅监控 + 自愈当前 PR 的 required checks；不做与失败 check 无关的改动。
- 自愈会修改业务代码并 `git push` 到 PR 分支，但**推送前必须本地跑通相关测试**；修复尝试有硬上限（默认 2）；仅对可定位的代码层失败（lint / format / test / 类型 / 构建）自愈，非代码层（网络 / 权限 / 外部服务 / flaky）一律转求助出口。
- 求助出口是「产出后停止」语义：停止本轮、输出阻塞说明、等待用户主动触发，**不**中途提问。
- 裸数字 / `#NN` / `TASK-id` 入参一律按任务短号解析（见 `.agents/rules/task-short-id.md`）；PR 号只走 `--pr <number>` / PR URL / 省略（当前分支），不复用裸数字语法。
- 执行本技能（任务锚定路径）后，必须更新 task.md。

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本轮第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本轮 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N}) [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤

### 1. 解析入参

按以下确定性分支解析出目标 PR 号 `{pr#}` 与可选 `{task-id}`：

- 场景 A（省略入参）：按 `.agents/rules/pr-checks-commands.md` 取当前分支的 PR 号；随后按下方「反查任务」确定 `{task-id}`。
- 场景 B（`#NN` / 裸数字 / `TASK-id`，**任务锚定主路径**）：匹配 `^[#]?[0-9]+$` 时按「任务入参短号别名」解析为完整 `{task-id}`（解析失败直接透传退出码，不重写错误处理）；`TASK-id` 直接采用。读 `.agents/workspace/active/{task-id}/task.md` 取 `pr_number` 作为 `{pr#}`；`pr_number` 为空时按「错误处理」提示先 `create-pr`，停止。
- 场景 C（`--pr <number>` 或 PR URL）：直接取该 PR 号为 `{pr#}`；随后按「反查任务」确定 `{task-id}`。
- 反查任务（场景 A / C）：在 `.agents/workspace/active/*/task.md` 中查找 `pr_number == {pr#}` 的任务；命中则取该 `{task-id}`（任务锚定）；未命中则进入「仅监控」降级路径（无 `{task-id}`，跳过步骤 5/6）。

### 2. 监控 required checks

执行此步骤前，先读取 `reference/monitor-and-heal.md` 与 `.agents/rules/pr-checks-commands.md`。

按 `.agents/rules/pr-checks-commands.md` 的监控命令对 `{pr#}` 的 required checks 轮询（含总时长上限，默认 30 分钟），按 `reference/monitor-and-heal.md` 的「结果分类」分为「全绿」/「失败」/「挂起」三个场景，分别进入步骤 7 全绿出口、步骤 3 自愈、或步骤 4 求助。

### 3. 失败自愈循环

执行此步骤前，先读取 `reference/monitor-and-heal.md` 的「自愈决策树」与 `.agents/rules/pr-checks-commands.md` 的「解析失败 run id 并拉日志」。

对失败 check：先按规则确定性解析其失败 run 并拉取失败日志、判定失败类别；本地修复前先读取 `.agents/rules/debugging-guide.md`，按其四阶段流程定位根因，禁止盲目改代码重试；仅当属可定位的代码层失败时，本地最小化修复、运行对应测试通过后**暂存并提交本次修复再推送**（`git add` 仅相关文件 → 按 `.agents/rules/commit-and-pr.md` `git commit` → `git push` 到当前 PR 分支，并记录 commit SHA），再回到步骤 2 重新监控。修复尝试计数，达硬上限（默认 2）或 run 不可定位 → 转步骤 4。

### 4. 求助出口（产出后停止）

当自愈达上限、失败属非代码层、run id 不可定位、或步骤 2 挂起超时时，停止本轮并向用户汇总：阻塞原因、已尝试的修复（含每次修复 commit）、相关失败 job 与 run/log 链接（报告结构见 `reference/monitor-and-heal.md` 的「求助报告模板」）。**不**渲染下一步命令，等待用户裁定。随后在任务锚定路径下执行步骤 5/6 记录本轮结果。

### 5. 更新任务状态

> 仅任务锚定路径执行；「仅监控」降级路径跳过本步骤与步骤 6。

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- **不改** `pr_status`（保持 `created`）与 `current_step`
- **追加**到 `## 活动日志`（不要覆盖之前的记录；`{N}` = 本任务已有 Watch PR 条目数 + 1）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N})** by {agent} — {全绿：all required checks green / 阻塞：blocked: {简述}}
  ```

### 6. 完成校验

> 仅任务锚定路径执行。

运行完成校验：

```bash
node .agents/scripts/validate-artifact.js gate watch-pr .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 7. 告知用户

> 任务锚定路径仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

按场景输出：
- 「全绿」+ 任务锚定：说明所有 required checks 已通过、PR 可合入，并按下方模板渲染下一步（`{task-ref}` 替换为短号）：

  ```
  下一步 - 完成并归档任务：
    - Claude Code / OpenCode：/complete-task {task-ref}
    - Gemini CLI：/agent-infra:complete-task {task-ref}
    - Codex CLI：$complete-task {task-ref}
  ```

- 「全绿」+ 仅监控降级：说明 PR 可合入；本次无关联任务，请对相应任务运行 `complete-task`（无 `{task-ref}` 可渲染时不强行输出短号命令块）。
- 「阻塞」：仅输出步骤 4 的阻塞说明，不推荐下一步命令。

## 完成检查清单

- [ ] 解析出目标 PR（及可能的任务上下文）
- [ ] 完成 required checks 监控，得到全绿 / 阻塞结论
- [ ] 自愈仅限可定位的代码层失败，且推送前本地测试通过、未超修复上限
- [ ] 任务锚定路径：更新了 task.md 并追加 Watch PR 的 Activity Log
- [ ] 任务锚定路径：完成校验通过
- [ ] 向用户展示了所有 TUI 格式的下一步命令（全绿出口；阻塞出口不渲染下一步）

## 停止

完成检查清单后立即停止。全绿出口等待用户运行 `complete-task`；阻塞出口等待用户裁定。

## 注意事项

1. **前置条件**：PR 已存在（由 `create-pr` 创建或显式 `--pr` / 当前分支可定位）。
2. **裸数字恒为任务短号**：不要把裸数字当作 PR 号；PR 号用 `--pr <number>`。
3. **自愈安全**：推送前必须本地测试通过；非代码层 / 不可定位失败一律求助，不盲目重试。
4. **可多次运行**：watch-pr 可在一次任务生命周期多次运行，Round 计数按已有 Watch PR Activity Log 条目数递增。

## 错误处理

- 无法定位 PR（任务短号命中但 task.md 无 `pr_number`，且未传 `--pr`、当前分支也无 PR）：提示「请先运行 `create-pr`，或用 `--pr <number>` 指定 PR」，停止。
- 平台 CLI 未认证或 API 不可用：提示需人工介入，停止。
- 短号解析失败：透传 `task-short-id.js` 的退出码与错误信息，不重写。
