# 监控与自愈细则

`watch-pr` 步骤 2/3/4 的平台无关判定逻辑。具体平台命令（监控、解析失败 run、拉日志、读取 PR 号）见 `.agents/rules/pr-checks-commands.md`；本文件只描述与平台无关的分类与决策。

## 就绪状态分类

按 `.agents/rules/pr-checks-commands.md` 的监控命令执行后，依其退出码归为三类：

- `ready`：同一 head 的全部 checks 通过且平台明确可合入 → SKILL 步骤 7。
- `checks-failed`：至少一个 check 失败或取消 → SKILL 步骤 3 的 CI 自愈。
- `conflicting`：平台明确当前 head 与 base 冲突 → SKILL 步骤 3 的 rebase 自愈。
- `pending|timed-out|cancelled`：mergeability/checks 未形成可靠成功事实 → SKILL 步骤 4。

## 摘要刷新边界

每轮 readiness 之前，以及外部 push、自愈 commit 或 rebase 成功改变 PR head 之后，必须重新执行 `summary-context` → 机械报告与六项 precheck → `platform-pr change-report` → 含一次 `<!-- canonical-pr-change-report -->` 的 `summary-sync --change-report-file ... --result no_op --strict`。`--strict` 将报告或摘要刷新失败保留为 `failed/blocked`，不允许 warning 穿透到 ready/complete 路由。core 以权威 PR snapshot、任务意图 digest 和完整 patch 重新校验 sidecar；报告缺失、stale、invalid、占位符绕过或发布竞态时，不得继续 ready/complete 路由，转入求助出口并登记 warning。

每轮重建 precheck 时，除执行下方功能级报告门槛外，六项 `rationale` 都必须陈述对应检查的实际结论，并至少带一条含路径、行号和简短 `detail` 的证据；兼容、旧路径、冗余和范围检查分别说明，不复用泛化套话。理由和证据遵循当前部署语言，中文技能必须使用中文。

功能分组、逐组字段、行数唯一归属及 `needs-review` 条件统一遵循 `.agents/skills/create-pr/reference/change-report.md` 的 candidate 内容契约。每次刷新都重新按当前任务目标和 patch 建立功能组，不沿用上一 head 的说明代替本轮证据。完整 PR 统计与上一有效 head → 当前 head 的增量分开核算；没有可验证的上一 head 时明确标为未确认。任何功能组缺少目标对应、行为增减、必要性、行数对账、测试覆盖/成本或定位证据时，将 `target-alignment` 或 `change-composition` 标为 `needs-review` 并指出缺口。沿用现有 `nextAction=review-code` 路由；不得以结构完整或 CI 全绿继续 `watch-pr`。

完整 PR 的范围继续绑定当前权威 base/head/merge-base/patch 与完整统计。增量单独绑定上一有效报告 head → 当前 head：在覆盖旧 sidecar 前，用 `readPrChangeReport` 校验旧报告，只在 repository/resource identity 匹配当前 PR 时采用旧 `identity.head.sha`。对两个 head 做 tree-to-tree diff 并明确列出 SHA，不用 merge-base 替代端点差异，不把增量 totals 加到完整 PR totals。没有旧报告、报告无效或身份不符时标注上一 head 未确认，不从全量推算或填零。两个 SHA 相同只报告 head 未变化；rebase 后仍比较原 head 和新 head 的树差异。sidecar 无效只使增量不可确认，不改变现有 full-PR 报告流程。

## 预检分流

`summary-sync --strict` 成功后，消费其结构化结果中的 `nextAction`，再决定是否进入 readiness：

- `nextAction=review-code`：停止当前 Watch PR readiness 与自愈循环，按统一 helper 推荐 `review-code` 并结束本轮。不得把 CI 绿色当作清除必要性疑点，也不得自动实施冗余清理或重构。
- `nextAction=watch-pr`：继续现有 readiness 分类与自愈决策树。
- `nextAction` 缺失或 invalid：遵循严格刷新失败出口，进入求助流程，不推断为 `watch-pr`。

此 route 只复用 core 已由六项 checks 推导的结果；不会把 `review-code` 报告或自动修复权限授予 Watch PR。

## 自愈决策树

```text
# self-heal-test-command-contract
primary: failing-job-command
fallback-source: project-test-skill
unknown: help
```

对每个失败 check，按下列顺序判定「自愈」还是「求助」：

1. **能否定位到对应的 CI run**（按规则的「解析失败 run id」）？否 → 求助。
2. **失败属于哪一层**？
   - 代码层（可自愈）：lint / format / 类型检查 / 单元或集成测试断言 / 构建编译错误等，能从日志定位到本仓库具体文件与原因。
   - 非代码层（不可自愈）：网络抖动、权限 / 令牌、外部服务不可用、依赖源故障、明显的 flaky（重跑可能变绿但非本次改动引入）→ 求助。
3. **是否已达修复上限**（默认 2 次推送修复）？是 → 求助。
4. 满足「可定位 + 代码层 + 未达上限」时执行一次自愈：
   - 自愈前先 `git status -s` 记录当前工作树，确保后续只纳入与本次失败相关的改动。
   - 在本地按日志定位并最小化修复（只动与该失败相关的代码 / 测试 / 配置）。
   - 运行对应测试：优先失败 job 对应的本地命令；否则读取项目 `test` skill，选择其中声明的 core 或 full 验证命令。两者均未知时进入求助出口。**测试通过前不得提交或推送。**
   - 测试通过后发布修复：把相关路径、message、expected HEAD、expected tree 和 push policy（remote、完整 refs、automatic）写入同一个 intent JSON，调用一次 `git-workflow commit` 并复核远端 SHA；远端失败时使用相同 commit intent 的空 `paths` push-only 重试。
   - 将本次修复的 commit SHA 追加到当前运行的 `repairCommits`，修复计数 +1，回到 SKILL 步骤 2 重新监控；全绿时列表为空走 `complete-task`，非空走 `review-code`。
   - 绝不执行与失败无关的「顺手优化」；不放宽 / 跳过失败的断言来「修绿」。

## 合并冲突自愈

```text
# conflict-heal-contract
strategy: rebase
remote-update: exact-lease
unsafe: help
```

1. 仅当 PR、head 与 base repository 完全相同，当前分支等于 head ref，本地 HEAD 等于快照 head SHA，且工作树/暂存区干净时继续；否则求助。
2. 找到与 PR repository 精确匹配的 remote，抓取 base ref，记录完整 `expectedBaseHead`，并确认远端 head 仍等于完整旧 SHA。
3. 执行 `git rebase <expectedBaseHead>`。只处理 Git 报告的文本 unmerged paths；无法可靠解决时 `git rebase --abort`，记录冲突路径和双方 SHA 后求助。
4. rebase 完成后运行项目 `test` skill 的完整验证。失败时不推送。
5. 把 remote、branch、完整 `expectedOldHead`、`newHead`、baseBranch 和完整 `expectedBaseHead` 写入仓库外的临时 intent JSON，调用 `agent-infra-internal git-workflow push-rebased --input {intent.json}`。
6. core 会复核干净状态、分支/HEAD、远端 head/base、ancestor、精确 `--force-with-lease` 与推送后远端 SHA。任一失败不得改用普通 force；重新取 PR 快照或求助。
7. 推送成功后把新 SHA 加入 `repairCommits`，`rebaseAttempts += 1`，重新监控新 head。上限 2 次；最终 ready 且列表非空时只进入 `review-code` 出口。

## 求助报告模板

进入求助出口时，向用户输出以下固定结构（不写入产物文件）：

```
PR #{pr#} 监控处于 blocked 状态；请根据下方证据处理具体阻塞项。

阻塞原因：{非代码层 / 达修复上限 / run 不可定位 / readiness 未知 / rebase 或安全更新失败}
PR head/base：{repository/ref/SHA}
冲突与远端事实：{conflict paths / expected 与 actual head/base / rebase abort 状态}
验证：{命令与失败摘要；未运行则说明原因}
失败 check：{name}（workflow：{workflow}）
失败 run / 日志：{run/job 链接}
已尝试的修复（共 {k} 次）：
  - {commit 简述}：{改动概述} → 重新监控后仍失败
建议：{升级平台 CLI / 检查权限 / 重跑外部依赖 / 人工查看日志 等}
```
