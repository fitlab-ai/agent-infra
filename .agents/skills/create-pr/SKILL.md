---
name: create-pr
description: >
  创建 Pull Request 到目标分支。
  当变更已提交、需要发起 Pull Request 评审时使用。
---

# 创建 Pull Request
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。


创建 Pull Request，并在与任务关联时立即补齐核心元数据和 reviewer 摘要。

`platform-pr create` 返回唯一的 `result` / `warnings` 字段；成功结果为 `pr_created`、`pr_reused` 或 `no_op`，同步降级时为对应的 `_with_warnings` 结果（包括 `no_op_with_warnings`）。创建前必须证明任务分支已推送，远端 branch SHA 与本地预期 `HEAD` 一致；缺失、漂移、PR head SHA 不一致或 bind 前竞态都属于 hard failure，不得用 warning 继续绑定。

## 行为边界 / 关键规则

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务上下文解析

> 入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留其余业务操作数后调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

## 步骤开始：started 标记

真实执行 `platform-pr create` 时由 typed core 在远端写入前幂等登记 `Create PR [started]`；dry-run 不登记。调用方不得重复手写该条目。

## 执行流程

### 前置门控：项目级 PR 流程检查

**门控读取（项目级 PR 流程策略）**：在执行编号步骤前，读取 `.agents/.airc.json` 的 `prFlow` 字段（三态：字段缺省 = 默认推荐 PR、允许跳过；`"required"` = 强制 PR；`"disabled"` = 强制无 PR）。

按读取结果分支：
- 缺省 / `"required"` → 继续到下方第 1 步
- `"disabled"` → 输出以下消息后**立即停止**，不要执行任何后续编号步骤、不要触发任何 PR 创建命令、不要修改 `task.md` 的 `pr_delivery_fact`、不要发布 PR 摘要评论：

使用 `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
当前项目未启用 PR 流程（`.agents/.airc.json` 中 `prFlow: "disabled"`）。
无需创建 Pull Request，请直接运行：
{next-step-commands}
```

### 1. 解析命令参数

先解析 task scope：可选的 `--task <ref>` 或 `-t <ref>` 绑定 `{task-id}`；位置 task ref 不再解释。剩余的可选位置参数绑定为 `{target-branch}`。

如果提供了 `{task-id}`，读取 `.agents/workspace/active/{task-id}/task.md` 获取任务信息（例如 `issue_number`、`type` 等）。
如果未提供，可从当前 session 上下文获取；仍无法确定 `{task-id}` 时，后续步骤中的任务关联逻辑跳过。

### 2. 确定目标分支

如果用户显式提供参数就直接使用；否则根据 Git 历史和分支拓扑自动推断。

> 详细分支判断规则见 `reference/branch-strategy.md`。自动推断 base 分支前，先读取 `reference/branch-strategy.md`。

### 3. 准备 PR 正文

通过 `.agents/rules/issue-pr-commands.md` 读取 PR 模板，参考最近合并的 PR 风格，并收集 `<target-branch>` 到 `HEAD` 的全部提交。

> 模板处理、HEREDOC 正文生成和 `Generated with AI assistance` 要求见 `reference/pr-body-template.md`。编写正文前先读取 `reference/pr-body-template.md`。

### 4. 检查远程分支状态

调用 `agent-infra-internal task-delivery {task-id} deliver --agent {standard-agent-token}` 统一交付任务分支。该 core 负责首次创建、相同 SHA no-op、已知最近交付 SHA 的 `--force-with-lease` 更新和未知漂移 fail-closed；交付成功后再次复核远端 SHA，并只在远端 branch SHA 等于本地 `HEAD` 时继续。可选的 `--remote` / `--base` 必须与任务已绑定值一致。随后在 locate/create/bind 前后再次读取远端 branch SHA，并要求 PR 的精确 repository/ref、base 和 `head.sha` 全部匹配；POST 后的竞态不自动删除已创建 PR 或远端 branch，下一次只按资源身份恢复。

### 5. 创建或恢复 PR

执行前先读取 `.agents/rules/issue-pr-commands.md`，把标题和正文写入临时文件，并调用其中的 `platform-pr create` intent。core 在任务锁内按 remote branch、head/base 和 PR 身份事实执行：唯一既有 PR 会复用并绑定，零个才创建，多个稳定失败；review 或 task sync 记录不作为创建 PR 的前置门禁，重放不得产生重复 PR。

如果获取到 `{task-id}` 且对应任务提供了 `issue_number`，必须在 PR 正文中保留 `Closes #{issue-number}`。

### 6. 同步 PR 元数据

记录 `platform-pr create` 结构化结果中的 `result`（`pr_created`、`pr_reused` 或 `no_op`），并调用 `agent-infra-internal platform-pr sync {task-id} --agent {standard-agent-token} --metadata --closing-issue --result {primary-result}`。`in:` target 由 shared core 根据 task-bound diff/PR evidence 和仓库映射计算，唯一 closing Issue 按 Issue→PR 顺序收敛，其他 metadata 仍从 Issue 同步；不从 Issue 反向复制 `in:`，也不清除非 `in:` labels。权限不足逐项返回 degraded，部分副作用返回 blocked/`IN_LABEL_SYNC_PARTIAL`。

### 7. 生成 PR 代码增减报告

创建或唯一复用 PR 后，调用 `agent-infra-internal platform-pr inspect {task-id}` 取得权威 base/head SHA，并按 `reference/change-report.md` 生成完整 PR 的机械统计。结合任务目标与完整三点 diff 生成六项带文件证据的 precheck candidate，再调用 `platform-pr change-report` 写入任务绑定的 `pr-change-report.json` sidecar。执行本步骤前先读取该 reference。

报告由 core renderer 生成，既是下方 reviewer 摘要的一部分，也必须出现在最终用户回复中；不得只给总行数、忽略字节变化、只统计最后一个 commit，或由调用方自行拼接报告段。

### 8. 发布审查摘要

读取最新的上下文产物：`plan.md` / `plan-r{N}.md`、`review-plan.md` / `review-plan-r{N}.md`、`code.md` / `code-r{N}.md`、`review-code.md` / `review-code-r{N}.md`（存在时）。

基于这些产物聚合 reviewer 摘要，正文只放一次 `<!-- canonical-pr-change-report -->` 占位符，再使用隐藏标记维护唯一且幂等的摘要评论。调用 `summary-sync` 时传入 `--change-report-file .agents/workspace/active/{task-id}/pr-change-report.json`，并继续传递同一个 `--result {primary-result}`；不得根据同步子步骤猜测 PR 是创建还是复用。

> canonical context、摘要聚合和 `summary-sync` 调用见 `reference/comment-publish.md`（其引用 `.agents/rules/pr-sync.md`）。发布摘要前先读取该 reference。

### 9. 确认任务状态

`platform-pr create` 在成功创建或恢复唯一远端身份后，通过任务写入内核原子更新 verified `pr_delivery_fact`、规范时间/版本和 Create PR 完成日志。调用方只核对结构化结果，不再次编辑 fact。

### 10. 完成校验

如果本次操作关联了 `{task-id}`，运行完成校验，确认任务元数据和同步状态符合规范；如果没有任务上下文，跳过本步骤。

```bash
agent-infra-internal task-verify {task-id} create-pr.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 11. 告知用户

> 仅在校验通过后执行本步骤。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

说明 PR URL、元数据同步结果、摘要评论结果，完整展示第 7 步的分类统计表与必要性结论，并推荐下一步进入 PR 监控（按 `.agents/rules/next-step-output.md` 把 `{task-ref}` 渲染为短号 `NN`）：

使用 `agent-infra-internal agent-client next-steps --skill watch-pr --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
下一步 - 监控 PR 检查（全部 checks 全绿前自动自愈）：
{next-step-commands}
```

或者，若想跳过主动监控并立即尝试完成，改用 `complete-task`；其全部 checks 硬门禁仍会对 pending/failed/head mismatch fail-closed：

使用 `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
下一步（备选）- 跳过主动监控并尝试完成：
{next-step-commands}
```

`watch-pr` 为主路径；上面的 `complete-task` 备选块只跳过主动轮询，不跳过全部 checks，也不保证立即归档。

## 注意事项

- 必须检查分支中的全部提交，而不是只看最后一个
- `create-pr` 不能把 type label 映射委托给其他技能，必须在获取到 `{task-id}` 时于本技能内内联处理
- summary marker、权威 PR head 和 `### PR 代码增减` 由 `platform-pr summary-sync` 统一包装
- 如果当前分支已存在 PR，仍须完成绑定、报告生成、摘要同步和结果校验；不得因复用而直接结束
- 如果从 Issue 继承元数据失败，继续使用 task.md 和分支推断兜底

## 错误处理

- `{target}` 与 `HEAD` 之间没有可提交内容
- 推送被拒绝：建议执行 `git pull --rebase`
- 已存在 PR：继续完成绑定、报告生成、摘要同步和结果校验后输出当前 PR URL
- 无法访问 Issue 元数据：跳过继承并继续
- PR 创建失败且已关联 `{task-id}`：调用 `agent-infra-internal task-warning {task-id} add --step create-pr --severity ACTION_REQUIRED --code PR_CREATE_FAILED --target pr --message "{reason}" --action "修复推送、权限或平台问题后重跑 create-pr"` 提交结构化 warning 意图，不写不完整 `pr_delivery_fact`
- PR 摘要评论失败且已关联 `{task-id}`：按 `.agents/rules/pr-sync.md` 记录 `COMMENT_SYNC_FAILED` 告警，不回滚已创建 PR
