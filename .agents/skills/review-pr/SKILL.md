---
name: review-pr
description: >
  按证据分级审查 PR 并发布正式 Review。
  当需要审查一个 PR（无论是否已有可信生命周期记录）时使用。
  仅当对话包含可解析的 PR 编号或 PR URL 时才可自动调用本技能。
---

# 审查 PR

根据目标 PR 的生命周期证据完整度与变更风险，选择 `verify`（轻量复核）、`audit`（证据审计）或 `reconstruct`（重建式审查），并把可执行的检视结论作为正式 PR Review 发布到目标 PR，同时保留可追溯的审查过程证据（`pr-review.md` / `pr-review-r{N}.md`）。

## 行为边界 / 关键规则

- 严格遵循方案中固化的证据分级主决策流：宿主解析 → 证据分类 → 新鲜度/对齐 → 风险分级 → 模式选择
- `pr-review*` 是独立 artifact family：不接入 analysis/plan/code 阶段依赖链，不修改 `current_step`
- PR 上只发布正式 PR Review（head SHA、结论、finding、receipt、Issue artifact 链接），不发第二份完整过程原文到 PR 普通评论
- 完整过程原文与 `task.md` 的可逆镜像只在关联 Issue 上同步；`restore-task` 保持 Issue-only 契约
- 不得为外部 PR 倒填或伪造已发生的 `analysis`/`plan`/`code` 生命周期历史
- head SHA 唯一记录于 `pr-review*` 与正式 PR Review；head 漂移必须进入新轮次，不得沿用旧结论
- 审查深度由证据完整度和变更风险决定，不由提交者身份决定
- 执行本技能后，你**必须**立即更新 task.md（经 `task-activity` typed intent）
- 绝不自动执行 `git add` 或 `git commit`
- 一次性检视路径（无任务/Issue）走 `.agents/workspace/reviews/{pr-number}/`，标记 `recoverable: false`，不承担可恢复承诺

## 常见违规借口与反驳

| 借口 | 反驳 |
|------|------|
| 「代码 diff 直接看就行了，不需要重建上下文」 | 仅看 diff 会遗漏需求边界、架构选择与迁移策略；`reconstruct` 必须先产出最低充分重建记录。 |
| 「PR 没有关联任务，直接写个报告发出去」 | 默认阻塞并要求先关联 Issue/task；只有显式「仅一次性检视」才走不可恢复降级路径。 |
| 「把完整重建过程也发到 PR 普通评论，方便贡献者看」 | 过程原文只同步到 Issue artifact 评论；PR 只保留正式 Review，避免重复远端副本与恢复源混淆。 |
| 「审查完了顺手提交一下」 | 本技能绝不执行 `git add`/`git commit`；提交是用户显式发起的独立步骤。 |

## 第 0 步：状态核对（执行前硬约束）

在加载本技能与相关规则后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

任务锚定路径在开始前记录当前任务目录与既有 `pr-review*` 轮次；一次性路径（无任务）记录 PR 编号与目标目录。状态核对输出粘贴到本轮产物 `pr-review-rN.md` 的 `## 状态核对` 段。

## 执行步骤

### 1. 解析入参与宿主解析

解析目标 PR 编号 `{pr-number}`（`--pr <number>`，或 PR URL，或省略时按当前分支反查）。执行：

```bash
agent-infra-internal platform-pr-review inspect --pr {pr-number} [--cwd <path>]
agent-infra-internal pr-review-grade resolve-host --pr {pr-number} [--cwd <path>]
```

`resolve-host` 输出 `HostResolution`（`unique` / `ambiguous` / `none`），按以下策略分流：

- **唯一宿主**：绑定 `{task-id}`，调用 `task-activity pr-review-inspect` 取得 canonical round、prepared/open 状态和最近成功审查身份，再按下述恢复规则开始本轮（进入步骤 2）。
- **多宿主歧义**：`resolve-host` 返回 `ambiguous`，`decide` 会拒绝分类（fail closed）。立即停止并提示人工指定唯一宿主；不进入证据分类。
- **无宿主**：默认阻塞，要求先建立 Issue/task 关联（给出关联指引），不自动创建/导入 Issue。仅当用户显式选择「仅一次性检视」时，过程文件写入 `.agents/workspace/reviews/{pr-number}/`（`recoverable: false`）。

任务锚定路径在宿主与远端 head 确定后执行：

```bash
agent-infra-internal task-activity {task-id} pr-review-inspect
```

- `prepared`：复用该 artifact；`open` 且 head 未变：对同一 artifact/head 重放 start（no-op）并恢复该轮。
- `open` 且 head 已变：先把旧 artifact 的正式 Review 状态写为 `superseded`，再用旧 artifact/head 执行 terminate；随后使用 inspect 返回的 next round。
- 无 prepared/open：按 `reference/report-template.md` 创建 next artifact 骨架，先写状态核对、身份信息、被审 head 与 `正式 Review 状态: pending`。

在上述分流完成后、步骤 2 证据分级开始前写 started：

```bash
agent-infra-internal task-activity {task-id} pr-review-start --agent {agent} \
  --artifact {pr-review-artifact} --head {head-sha}
```

一次性路径不调用 `task-activity`。任意 started 后、正式 Review 明确尚未发布的受控失败，都先把 artifact 状态写为 `aborted`，再以同一 artifact/head 调用 `pr-review-terminate --outcome aborted --reason <single-line>`；发布结果不确定时保持 open，不臆断 aborted。

### 2. 单次 decide：证据枚举 + 场景分类 + 风险分级 + 模式选择

把宿主、artifact 存在性、head 状态与六个纯证据风险因素写入输入 JSON。prior review 只使用 inspect 返回的最高 `applied` / `no-op` artifact；pending/aborted/superseded/failed 只参与 round 连续性，不作为既有结论。调用一次：

```bash
agent-infra-internal pr-review-grade decide --input-file {decide-input.json} [--cwd <path>]
```

一次返回完整 `DecisionRecord`（`scenario` / `freshness` / `alignment` / `risk` / `mode` / `firstReview` / `reason`）。把决策输入与输出原样记录到 `pr-review-rN.md` 的「证据清单」段（AC3 可追溯）。`host.kind === 'ambiguous'` 时命令拒绝，回到步骤 1 的阻塞出口。

### 3. 生成 `pr-review-rN.md`

按 `reference/report-template.md` 完成本轮产物；任务锚定路径保留步骤 1 已写入的身份/head/pending 状态，不重新分配 round。`reconstruct`（或 `audit` 证据不足）时，在行级 finding 之前先写「重建上下文」段（需求边界 / 架构选择 / 影响面 / 验证覆盖，见 `reference/evidence-grading.md`）。frontmatter 或首部记录 `recoverable: true|false`（一次性路径为 `false`）。完成最终问题清单后，一次性冻结 `{verdict, blockers, major, minor}`；正式 Review 正文与步骤 6 的 complete payload 必须直接复用该对象，不从报告文案反向统计。

### 4. 同步 Issue artifact 评论（任务锚定路径）

依次同步 task 评论与 artifact 评论，取得稳定 comment URL：

```bash
agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}
agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {pr-review-artifact} --agent {agent}
```

一次性路径（无任务/Issue）跳过本步。

### 5. 核对 head 并发布正式 Review

再次读取远端 head，确认未被审查期间漂移：

```bash
agent-infra-internal platform-pr-review inspect --pr {pr-number} [--cwd <path>]
```

若 head 与步骤 1 记录一致，组装正文（head SHA / 结论 / finding / receipt / Issue artifact 链接，**不含 marker**），发布正式 Review：

```bash
agent-infra-internal platform-pr-review publish --pr {pr-number} --scope {taskId|pr{pr-number}} --round {round} \
  --commit {head-sha} --event {COMMENT|APPROVE|REQUEST_CHANGES} --body-file {review-body.md} [--dry-run] [--cwd <path>]
```

`publish` 由 core 生成并校验 marker（首行），按 marker + commit 幂等（重放 no-op；marker 命中但 commit 不一致稳定失败）。head 漂移时，先把旧 artifact 状态写为 `superseded`，再闭合旧轮：

```bash
agent-infra-internal task-activity {task-id} pr-review-terminate --agent {agent} \
  --artifact {pr-review-artifact} --head {head-sha} \
  --outcome superseded --reason "head changed before publish"
```

闭合成功后重新执行步骤 1，进入下一 canonical round；不得先写新轮 started。若 publish 调用的远端结果不确定，保留 open 并在重试时依赖 marker + commit 恢复。

### 6. 回写发布结果与任务状态

- **任务锚定路径**：publish 返回 `applied` / `no-op` 后，把 Review ID/URL 与同名正式 Review 状态写入 `pr-review-rN.md`「发布结果」段，再以步骤 3 冻结的同一组 verdict/counts 闭合活动日志：

  ```bash
  agent-infra-internal task-activity {task-id} pr-review-complete --agent {agent} \
    --artifact {pr-review-artifact} --head {head-sha} --verdict {approved|changes-requested|commented} \
    --blockers {blockers} --major {major} --minor {minor}
  ```

  `task-activity` 由 typed payload 生成 `Verdict: <结论>, blockers: N, major: N, minor: N → {pr-review-artifact}`，并经 `writeTask` 原子完成 Activity Log、`## 审查反馈` 链接与版本戳刷新；不改 `current_step`，也不把 receipt/head/Review URL 写入 NOTE。

- **一次性路径（无任务）**：Review ID/URL 只写 `pr-review-rN.md`「发布结果」段，不调用 `task-activity`。

### 7. 发布后回写再同步（任务锚定路径）

步骤 6 已改写本地 `pr-review-rN.md`「发布结果」段与 task.md（活动日志），而步骤 4 同步的是旧快照。`verify_comment_content` / `verify_task_comment_content` 会全文比对，必须先再同步使本地与远端一致。依次调用：

```bash
agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}
agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {pr-review-artifact} --agent {agent}
```

`platform-comment sync` 对既有 marker 评论是幂等原地更新，comment URL 不变。一次性路径无任务，跳过本步。

### 8. 完成校验

- **任务锚定路径**：

  ```bash
  agent-infra-internal task-verify {task-id} review-pr.completed --artifact {pr-review-artifact} --format text
  ```

- **一次性路径**：

  ```bash
  agent-infra-internal pr-review-grade verify-artifact --artifact-file {pr-review-artifact} [--cwd <path>]
  ```

退出码 0 通过；1 按输出修复后重跑；2 停止并告知用户需要人工介入。

### 9. 告知用户

按 `reference/output-guidance.md` 选择唯一出口（正常发布 / 阻塞要求关联 / 一次性检视），渲染下一步前读取 `.agents/rules/next-step-output.md`。

## 完成检查清单

- [ ] 已按证据分级完成 PR 审查并产出 `pr-review-rN.md`
- [ ] 正式 Review 已发布到目标 PR，绑定被审 head SHA
- [ ] 任务锚定路径的 Issue artifact/task 评论已同步并再同步
- [ ] 已完成校验（`task-verify` 或 `verify-artifact`）
- [ ] 已更新 task.md 并追加 Activity Log（任务锚定路径）

## 停止

完成检查清单后立即停止。不要自动提交。
