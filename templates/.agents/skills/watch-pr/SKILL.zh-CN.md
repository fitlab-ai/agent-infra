---
name: watch-pr
description: >
  监控 PR readiness，并在任一 check 失败或合并冲突时自愈。
  当需要持续监控 PR 直到门禁通过且明确可合入时使用。
---

# 监控 Pull Request

在 `create-pr` 之后持续监控同一 PR head 的全部 checks 与 mergeability。只有全部 checks 通过且平台明确可合入才进入成功出口；check 失败走既有修复，合并冲突走受限 rebase 自愈，未知或无法安全闭环时 fail-closed。

## 行为边界 / 关键规则

- 仅监控 + 自愈当前 PR 的全部 checks 与文本合并冲突；不扩展到审批或其他仓库规则。
- 自愈通过 Git workflow intent 发布修复，但**发布前必须本地跑通相关测试**；修复上限与代码层分类授权不变。
- 求助出口是「产出后停止」语义：停止本轮、输出阻塞说明、等待用户主动触发，**不**中途提问。
- 裸数字 / `NN` / `TASK-id` 入参一律按任务短号解析（见 `.agents/rules/task-short-id.md`）；PR 号只走 `--pr <number>` / PR URL / 省略（当前分支），不复用裸数字语法。
- 执行本技能（任务锚定路径）后，必须更新 task.md。

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务上下文解析

> 入口允许省略 task ref，也接受 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

## 步骤开始：写入 started 标记

确认前置条件后、本轮第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本轮 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N}) [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤

### 1. 解析入参

按以下确定性分支解析出目标 PR 号 `{pr#}` 与可选 `{task-id}`：

- 场景 A（省略入参）：从当前分支反查 active task；定位后读取其 verified `pr_delivery_fact.identity.number`。
- 场景 B（省略 task ref 或 `--task/-t`，**任务锚定主路径**）：按「任务上下文解析」取得完整 `{task-id}`。读 `.agents/workspace/active/{task-id}/task.md` 取 verified `pr_delivery_fact.identity.number` 作为 `{pr#}`；fact 未绑定时按「错误处理」提示先 `create-pr`，停止。
- 场景 C（`--pr <number>` 或 PR URL）：直接取该 PR 号为 `{pr#}`；随后按「反查任务」确定 `{task-id}`。
- 反查任务（场景 A / C）：通过任务上下文/任务查询取得与 `{pr#}` 唯一绑定的 active task。未命中时停止并提示先绑定 PR；typed checks intent 不建立第二套无任务状态机。

### 2. 监控 PR readiness

执行此步骤前，先读取 `reference/monitor-and-heal.md` 与 `.agents/rules/pr-checks-commands.md`。

进入本轮时初始化 `repairCommits=[]` 与 `rebaseAttempts=0`。每轮 readiness 前先调用 `platform-pr summary-context`，按共享 PR change-report contract 以当前权威 PR head 重建任务绑定的 `pr-change-report.json`，再用含唯一 `<!-- canonical-pr-change-report -->` 占位符的正文调用 `summary-sync --change-report-file ... --result no_op` 刷新同一条摘要。报告或摘要刷新失败时不得进入 ready/complete 出口，按步骤 4 记录阻塞。刷新完成后调用 `agent-infra-internal platform-checks watch {task-id} --interval-seconds 30 --deadline-seconds 1800`，只按结构化 `readiness.state` 分流：`ready` 进入步骤 7，`conflicting` 或 `checks-failed` 进入步骤 3，`pending|timed-out|cancelled` 进入步骤 4。

### 3. 自愈循环

执行此步骤前，先读取 `reference/monitor-and-heal.md` 的「自愈决策树」与 `.agents/rules/pr-checks-commands.md` 的「解析失败 run id 并拉日志」。

`checks-failed` 只对可定位代码层失败做最小修复和测试，再用既有 commit/push intent 发布。`conflicting` 严格执行 reference 的同仓库、干净工作树、head/base 身份、rebase、完整测试与 `git-workflow push-rebased` 精确 lease 流程；上限 2 次。仅记录远端复核成功的 SHA；任何外部 push、自愈 commit 或 rebase 改变 head 后，先按本轮报告→摘要顺序刷新，再重新监控新 head；任一安全检查失败转步骤 4。

### 4. 求助出口（产出后停止）

当自愈达上限、失败属非代码层、run id 不可定位、readiness 未知/超时，或 rebase、测试、远端身份、精确 lease 任一无法闭环时，停止本轮并按 reference 汇总 PR head/base、冲突文件、远端事实、测试与尝试记录。**不**渲染下一步命令。随后在任务锚定路径下执行步骤 5/6。

### 5. 更新任务状态

> 仅任务锚定路径执行；「仅监控」降级路径跳过本步骤与步骤 6。

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- **不改** `pr_delivery_fact` 与 `current_step`
- **追加**到 `## 活动日志`（不要覆盖之前的记录；`{N}` = 本任务已有 Watch PR 条目数 + 1）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N})** by {agent} — {成功：PR ready, repair commits: {k} [{sha 摘要}] / 阻塞：blocked: {简述}}
  ```

### 6. 完成校验

> 仅任务锚定路径执行。

运行完成校验：

```bash
agent-infra-internal task-verify {task-id} watch-pr.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 7. 告知用户

> 任务锚定路径仅在校验通过后执行本步骤。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

按场景输出：
- `ready` + 任务锚定：说明全部 checks 已通过且当前 head 明确可合入，并只按本轮是否产生修复 commit 渲染一个出口（`{task-ref}` 替换为短号）：

  `repairCommits.length == 0`：

使用 `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

  ```
  下一步 - 完成并归档任务：
  {next-step-commands}
  ```

  `repairCommits.length > 0`：

使用 `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

  ```
  下一步 - 重新代码审查：
  {next-step-commands}
  ```

- 「阻塞」：仅输出步骤 4 的阻塞说明，不推荐下一步命令。

## 完成检查清单

- [ ] 解析出目标 PR（及可能的任务上下文）
- [ ] 完成 readiness 监控，只有 checks 通过且明确可合入才得到成功结论
- [ ] check / rebase 自愈均通过本地测试和对应安全 intent，且未超修复上限
- [ ] 任务锚定路径：更新了 task.md 并追加 Watch PR 的 Activity Log
- [ ] 任务锚定路径：完成校验通过
- [ ] 已通过统一 helper 渲染已选场景的下一步命令

## 停止

完成检查清单后立即停止。全绿出口等待用户运行所选的 `complete-task` 或 `review-code`；阻塞出口等待用户裁定。

## 注意事项

1. **前置条件**：PR 已存在（由 `create-pr` 创建或显式 `--pr` / 当前分支可定位）。
2. **裸数字恒为任务短号**：不要把裸数字当作 PR 号；PR 号用 `--pr <number>`。
3. **自愈安全**：推送前必须本地测试通过；非代码层 / 不可定位失败一律求助，不盲目重试。
4. **可多次运行**：watch-pr 可在一次任务生命周期多次运行，Round 计数按已有 Watch PR Activity Log 条目数递增。

## 错误处理

- 无法定位 PR（任务短号命中但 task.md 无 verified bound `pr_delivery_fact`，且未传 `--pr`、当前分支也无 PR）：提示「请先运行 `create-pr`，或用 `--pr <number>` 指定 PR」，停止。
- 平台 CLI 未认证或 API 不可用：提示需人工介入，停止。
- 短号解析失败：透传 `task-short-id.js` 的退出码与错误信息，不重写。
