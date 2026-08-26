# 监控与自愈细则

`watch-pr` 步骤 2/3/4 的平台无关判定逻辑。具体平台命令（监控、解析失败 run、拉日志、读取 PR 号）见 `.agents/rules/pr-checks-commands.md`；本文件只描述与平台无关的分类与决策。

## Readiness 分类

按 `.agents/rules/pr-checks-commands.md` 的监控命令执行后，依其退出码归为三类：

- `ready`：同一 head 的全部 checks 通过且平台明确可合入 → SKILL 步骤 7。
- `checks-failed`：至少一个 check 失败或取消 → SKILL 步骤 3 的 CI 自愈。
- `conflicting`：平台明确当前 head 与 base 冲突 → SKILL 步骤 3 的 rebase 自愈。
- `pending|timed-out|cancelled`：mergeability/checks 未形成可靠成功事实 → SKILL 步骤 4。

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
PR #{pr#} 监控阻塞，需人工介入。

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
