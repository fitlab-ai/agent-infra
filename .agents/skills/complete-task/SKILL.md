---
name: complete-task
description: >
  标记任务完成并归档。
  当任务工作已完成并验证、需要收尾归档时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 完成任务
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`gemini`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`gemini-cli`→`gemini`）或人工例外 `human`。


## 行为边界 / 关键规则

- 本命令更新任务元数据并物理移动任务目录
- 除非强制执行，不要转移有未完成工作流步骤的任务

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：本地生命周期边界

正常完成路径在 active 阶段完成业务更新、平台同步和预完成门禁后，才由步骤 6 的单次 lifecycle intent 原子完成基础终态字段、started/done 日志、目录转移和短号释放；不得提前手工写入这些机械状态。已归档任务只允许进入 `finalization-retry` 场景，不回迁目录或重新执行 lifecycle。

## 执行步骤
### 1. 验证任务存在

检查任务是否存在于 `.agents/workspace/active/{task-id}/`。

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果在 `active/` 中未找到，检查 `blocked/` 和 `completed/`：
- 如果在 `completed/` 且 task.md 存在匹配的 Complete Task Activity Log：进入场景 B `finalization-retry`，跳过步骤 2-6，直接执行步骤 7
- 如果在 `completed/` 但缺少匹配日志：告知用户任务已完成但终态身份不完整并停止，不手工修补
- 如果在 `blocked/`：告知用户任务被阻塞；建议先解除阻塞

场景 A 为 active 任务的正常完成路径；场景 B `finalization-retry` 只重试归档后的 task 评论与终态门禁。

### 2. 验证完成前置条件（未满足则必须停止）

**门控读取（项目级 PR 流程策略）**：在执行本步骤前，读取 `.agents/.airc.json` 的 `prFlow` 字段（三态：字段缺省 = 默认推荐 PR、允许跳过；`"required"` = 强制 PR；`"disabled"` = 强制无 PR），以及 `task.md` frontmatter 的 `pr_status`（`pending` / `created` / `skipped`）。

**PR 维度判定（先判 `prFlow` 强约束，后看 `pr_status`）**：

| `prFlow` | `pr_status` | 判定 |
|---|---|---|
| `disabled` | 任意 | 无 PR 路径 → PR 维度满足，继续其余前置条件 |
| `required` | `created` | PR 维度满足，继续 |
| `required` | `pending` / `skipped` | **停止**：强制 PR 下必须先 `/create-pr`；`--skip-pr` 不被接受（含既有/手动写入的 `skipped`） |
| 缺省 | `created` / `skipped` | PR 维度满足，继续 |
| 缺省 | `pending` | **默认停止**并输出下方二选一引导；除非用户提供 `--skip-pr`（写 `pr_status: skipped` 后继续）或 `--force` |

- `--skip-pr` 处理：仅在 `prFlow` 非 `required` 时生效——把 `task.md` 的 `pr_status` 写为 `skipped` 后继续；`prFlow=required` 时忽略 `--skip-pr` 并按上表停止。
- 注：`--force` 可越过下方其余前置条件，但**不解除 `prFlow=required` 的 PR 强约束**（强约束的唯一出口是创建 PR）。

缺省 + `pending` 的二选一引导消息：
```
任务 {task-id} 尚未创建 PR（pr_status: pending）。请二选一：
  - 走 PR 流程：/create-pr {task-ref}
  - 显式跳过并完成：/complete-task {task-ref} --skip-pr
```

`required` + `pending`/`skipped` 的停止消息：
```
当前项目强制 PR 流程（prFlow: "required"），任务尚未创建 PR。
请先运行 /create-pr {task-ref} 创建 PR 后再完成；--skip-pr 在强制 PR 下不被接受。
```

标记完成之前，验证以下所有条件：
- [ ] 所有工作流步骤已完成（检查 task.md 中的工作流进度；**对 yaml 中 commit 步骤的 `pr_tasks` 列表，按「走 PR 路径」判定是否计入未完成判定：`prFlow=required` 始终计入；`prFlow=disabled` 不计入；缺省下仅当 `pr_status=skipped` 时不计入，否则计入**）
- [ ] 代码已审查（`review-code.md` 或 `review-code-r{N}.md` 存在，且最新审查结论为 Approved；或已在外部完成审查）
- [ ] 代码已提交（没有与此任务相关的未提交变更）
- [ ] 测试通过
- [ ] 审查分歧账本无未关闭分歧、无未复审的 post-review 提交；绑定 PR 路径中本地 HEAD、`last_reviewed_commit`、PR head 严格一致，或已合并 squash 的平台快照与远端 Git 等价证据完整且当前 Git 凭据可读取证据 refs；无有效 PR 路径中本地单父重写与 `last_reviewed_commit` 内容等价且之后无受保护提交
- [ ] 人工校验项已完成（最新 review-code 的 Manual validation 计数 > 0 时，须存在通过校验的 manual-validation 产物及其完成记录，且该完成记录位于最新 review-code 之后；计数为 0 或无未决项时跳过）

> **⚠️ 前置条件分支判断 — 你必须先判断“继续”还是“停止”：**
>
> - 如果以上所有条件都满足 → 继续步骤 3
> - 如果任意一个条件不满足 → **默认停止**，输出前置条件未满足的警告
> - 只有用户明确要求 `--force` 时，才可以在前置条件未满足时继续
>
> **禁止在前置条件未满足时继续执行步骤 3-8，也不要输出「任务 {task-id} 已完成，任务目录已转移到 completed/。」**

如果任何前置条件未满足，警告用户：
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {缺失的前置条件}

Please complete the missing steps first, or use --force to override.
```

如果前置条件未满足且用户未明确提供 `--force`，立即停止，不执行步骤 3-8。

### 3. 完成业务内容更新

在 `.agents/workspace/active/{task-id}/task.md` 中只更新生命周期核心不负责的业务内容：
- 新增或更新 `## 状态核对` 段，粘贴第 0 步审计命令原文（含 `$ ` 前缀行），放在 `## 活动日志` 之前
- 标记所有工作流步骤为已完成
- 逐项验证并勾选 `## 完成检查清单` 中的所有条目（将 `- [ ]` 改为 `- [x]`）

不得在本步骤写 `status/current_step/completed_at/updated_at/agent_infra_version`、基础 Activity Log、目录或短号；这些由步骤 6 统一提交。

### 4. 在 active 阶段同步平台

检查 `task.md` 中是否存在有效的 `issue_number`。如果没有，跳过本步骤且不输出任何内容。

> Issue 元数据边界见 `.agents/rules/issue-sync.md`；评论同步统一调用 internal platform intent。

如果存在有效的 `issue_number`，严格按以下顺序执行：

1. 按 artifact catalog 顺序，对本地已有产物逐项调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {artifact} --agent {artifact-agent} --backfill`。
2. 调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --requirements --fields`。
3. 把业务摘要写入临时文件，并调用 `agent-infra-internal platform-comment sync {task-id} --kind summary --body-file {path} --agent {standard-agent-token}`。

不要在本步骤同步 task 评论；它依赖 lifecycle 写入后的完整终态 task.md。不要设置 `status:` label，平台自动化应在 Issue 关闭后清理状态标签。

任一操作失败时，任务仍必须位于 active 且短号仍有效；先按失败类型调用以下结构化 warning intent，再立即停止，不进入步骤 5：

```bash
agent-infra-internal task-warning {task-id} add --step complete-task --severity ACTION_REQUIRED --code {COMMENT_SYNC_FAILED|REQUIREMENTS_SYNC_FAILED|SUMMARY_SYNC_FAILED|NETWORK_RETRY_EXHAUSTED} --target {artifact|issue|summary|platform} --message "{error_code}: {error_message}" --action "修复平台同步问题后重跑 complete-task"
```

相同 `step/code/target` 组合由核心幂等去重；调用方不分配 warning id 或手写账本行。

### 5. 运行 active 预完成硬门禁

平台写入成功后、移动目录和释放短号之前运行：

```bash
agent-infra-internal task-verify {task-id} complete-task.preflight --format text
```

该事件依次执行 `review-ledger`、`manual-validation`、`post-review-commit`、`platform-sync-preflight`。任一退出码非 0（fail/blocked）时，任务必须继续留在 active；从 gate 结果取稳定 code/target，通过 `task-warning ... add --step complete-task ...` 落账后停止。若审查基线或 head 不一致，必须先重新 `commit` / `review-code`；不得回退审查基线。

`--force` 不解除本硬门禁：未关闭分歧必须先在账本闭合，未复审提交必须重新审查、具备有效豁免，或由平台适配器为绑定的变更请求（PR/MR）提供权威合并快照与远端 refs，并在隔离临时仓库中证明单父 squash merge 等价，或在无有效变更请求时由本地 Git 对象证明唯一受保护提交是内容等价的单父重写且之后无受保护提交；平台 preflight 必须通过。适配器不支持所需能力，平台事实、Git 对象、拓扑、内容证据缺失，或当前 Git 凭据不能读取远端证据 refs 时 fail closed。required checks 由平台适配器提供规范化状态，并在合并前通过分支保护 / ruleset 以及 `review-code` / `watch-pr` 路由承担。

### 6. 执行本地生命周期意图并验证转移

```bash
agent-infra-internal task-lifecycle {task-id} complete --agent {standard-agent-token}
```

仅 `status=applied|no-op` 视为本地完成。`status=failed` 时展示 `error` 与 completed/pending steps，以同一 intent 重试；不得宣称完成或手工补写局部状态。

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

确认任务目录已成功移动。

### 7. 同步终态 task 评论并完成校验

场景 A 与场景 B `finalization-retry` 都从 completed 目录执行本步骤。若存在有效的 `issue_number`，先调用：

```bash
agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}
```

该调用失败时任务已归档，不能调用只接受 active 任务的 `task-warning`；保留 completed 状态并停止。修复网络或平台问题后重跑 complete-task，会由步骤 1 进入 `finalization-retry`，只重复本步骤。

运行完成校验，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} complete-task.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断或状态标签清理尚未收敛）-> 保留 completed 状态并停止；稍后重跑 complete-task 进入 `finalization-retry`

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> 完成时间收尾行（整段输出的最后一行）取值 `date "+%Y-%m-%d %H:%M:%S"`（本地时区、不带偏移），固定放在输出的绝对末尾，便于多窗口扫视。本 skill 不渲染「下一步」命令，但会在收尾行之前渲染一段**可选的沙箱清理提示**（见下方门控），且仍统一打印该收尾行。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中的「可选：清理本任务的沙箱」块；任一不满足则整段省略。`{branch}` 取已读入的 task.md 的 `branch` 值（任务此时已移动到 completed/，从 `.agents/workspace/completed/{task-id}/task.md` 读取）。该块独立于「下一步」语义，不是工作流后继命令。

输出格式：
```
任务 {task-id} 已完成，任务目录已转移到 completed/。

任务信息：
- 标题：{title}
- 完成时间：{timestamp}
- 目标路径：.agents/workspace/completed/{task-id}/

交付物：
- {关键产出列表：修改的文件、添加的测试等}

可选：清理本任务的沙箱
（任务已归档，沙箱容器和 per-branch 配置目录不会自动回收。如果不再需要可执行：）

ai sandbox rm {branch}

Completed at: {completion-time}
```



## 完成检查清单

- [ ] 验证了所有工作流步骤已完成
- [ ] 更新了 task.md 的完成状态和时间戳
- [ ] 将任务目录移动到 `.agents/workspace/completed/`
- [ ] 验证了转移成功
- [ ] 告知了用户完成情况

## 注意事项

1. **过早完成**：不要转移有未完成步骤的任务。未完成的情况示例：
   - 代码已编写但未提交
   - 代码已提交但未审查
   - 审查发现阻塞项但未修复
   - PR 已创建但未合并
   - 人工校验项未完成

2. **回滚**：如果任务被错误转移：
   ```bash
   mv .agents/workspace/completed/{task-id} .agents/workspace/active/{task-id}
   ```
   然后将 task.md 中的状态改回 `active`。

3. **多贡献者**：如果多个 AI 代理参与了任务，确保所有贡献都已提交后再完成。

## 错误处理

- 任务未找到：提示 "Task {task-id} not found in active directory"
- 已完成：提示 "Task {task-id} is already in completed directory"
- 任务被阻塞：提示 "Task {task-id} is blocked. Unblock it first by moving to active/"
- 移动失败：提示错误并建议手动移动
