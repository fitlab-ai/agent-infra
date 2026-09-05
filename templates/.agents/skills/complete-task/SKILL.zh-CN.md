---
name: complete-task
description: >
  标记任务完成并归档。
  当任务工作已完成并验证、需要收尾归档时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 完成任务
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

宿主 finalization 使用 receipt v2（不可变 `receiptId`、单调 `revision` 和 canonical warnings）。生命周期/身份/required PR 等硬失败返回 `result: failed|blocked`；生命周期完成后，评论、外围验证和其他同步失败返回 `result: completed_with_warnings` 及六字段 warning，并仅重试 receipt 中的 pending step。


## 行为边界 / 关键规则

### 持久化报告证据

生成收尾报告或同步内容时，先读取 `.agents/rules/evidence-reporting.md`。成功检查记录命令、范围、状态/结构化结果、实际结果和未覆盖部分；失败、阻塞或争议保留复现入口、准确位置和决定性摘录。

- 本命令更新任务元数据并物理移动任务目录
- 除非强制执行，不要转移有未完成工作流步骤的任务
- 入口接受可选 `--external-pr <N>`；仅用于外部交付候选歧义时的显式选择，不绕过身份或平台门禁

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并在本轮产物的 `## 状态核对` 段记录任务/产物范围、关键结果和未覆盖部分；正常成功不粘贴完整目录清单或 `task.md` 尾部。失败、阻塞、身份不一致或争议时，附决定性原文行：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务上下文解析

> 入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留其余业务操作数后调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：本地生命周期边界

正常完成路径在 active 阶段完成业务更新、平台同步和预完成门禁后，才由步骤 6 的单次 finalization intent 按固定顺序原子推进生命周期、终态 task 评论和完成校验；不得提前手工写入这些机械状态。已归档任务只允许进入 `finalization-retry` 场景，不回迁目录或重新执行 lifecycle。

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

先读取 `reference/external-delivery.md`，然后在 active 任务上调用：

```bash
agent-infra-internal platform-pr resolve-external {task-id} --agent {standard-agent-token} [--pr {external-pr}]
```

- `mode=external`：只以本次 typed result 的 `authorization` 和 `selected` 作为外部交付授权与绑定身份，继续 required-PR、本地生命周期和终态校验；外围证据失败在 lifecycle 后记录为 warning。
- `mode=normal`：走现有本地生命周期前置条件；历史 PR 字段不构成外部授权。
- `status=failed|blocked`：立即停止并展示稳定错误；`--force` 不得绕过。

**门控读取（项目级 PR 流程策略）**：在执行本步骤前，读取 `.agents/.airc.json` 的 `prFlow` 字段（三态：字段缺省 = 默认推荐 PR、允许跳过；`"required"` = 强制 PR；`"disabled"` = 强制无 PR），以及 `task.md` frontmatter 的 `pr_delivery_fact`（`unbound` / `bound` / `skipped`）。

**PR 维度判定（先判 `prFlow` 强约束，后看 `pr_delivery_fact.state`）**：

| `prFlow` | `pr_delivery_fact.state` | 判定 |
|---|---|---|
| `disabled` | 任意 | 无 PR 路径 → PR 维度满足，继续其余前置条件 |
| `required` | `bound` | PR 维度满足，继续 |
| `required` | `unbound` / `skipped` | **停止**：强制 PR 下必须先 `/create-pr`；`--skip-pr` 不被接受（含既有/手动写入的 `skipped`） |
| 缺省 | `bound` / `skipped` | PR 维度满足，继续 |
| 缺省 | `unbound` | **默认停止**并输出下方二选一引导；除非用户提供 `--skip-pr`（通过当前 `platform-pr skip` 写入器写入 `pr_delivery_fact.state=skipped` 后继续）或 `--force` |

- `--skip-pr` 处理：仅在 `prFlow` 非 `required` 时生效——通过当前 `platform-pr skip` 写入器把 `task.md` 的 `pr_delivery_fact.state` 写为 `skipped` 后继续；`prFlow=required` 时忽略 `--skip-pr` 并按上表停止。
- 注：`--force` 可越过下方其余前置条件，但**不解除 `prFlow=required` 的 PR 强约束**（强约束的唯一出口是创建 PR）。

缺省 + `pending` 的二选一引导消息：
```
任务 {task-id} 尚未决定 PR 交付（pr_delivery_fact: unbound）。请二选一：
  - 走 PR 流程：/create-pr --task {task-ref}
  - 显式跳过并完成：/complete-task --task {task-ref} --skip-pr
```

`required` + `pending`/`skipped` 的停止消息：
```
当前项目强制 PR 流程（prFlow: "required"），任务尚未创建 PR。
请先运行 /create-pr --task {task-ref} 创建 PR 后再完成；--skip-pr 在强制 PR 下不被接受。
```

生命周期前只验证硬门禁：
- [ ] task 身份、active 状态、并发锁和本地原子生命周期操作可用
- [ ] `prFlow=required` 时已满足 required-PR delivery
- [ ] 其余业务证据（工作流、审查、提交、测试、分歧账本、人工校验和平台同步）已记录或可在生命周期后校验

> **⚠️ 前置条件分支判断 — 你必须先判断“继续”还是“停止”：**
>
> - 如果硬门禁满足 → 继续步骤 3
> - 如果硬门禁不满足 → 停止并输出前置条件未满足的警告
> - 外围业务证据不满足不阻止生命周期；在生命周期后以 warning/pending steps 表示
>
> **禁止在前置条件未满足时继续执行步骤 3-8，也不要输出「任务 {task-id} 已完成，任务目录已转移到 completed/。」**

如果硬门禁未满足，警告用户：
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {缺失的前置条件}

Please satisfy the hard prerequisite first, then retry complete-task.
```

如果硬门禁未满足，立即停止，不执行步骤 3-8。

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

1. 调用 `agent-infra-internal platform-comment backfill {task-id} --agent {standard-agent-token}`，由 core 仅按 completion canonical inventory 固定顺序补发产物并在全部成功后精确恢复目标历史告警。
2. 调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --requirements --fields`。
3. 把业务摘要写入临时文件，并调用 `agent-infra-internal platform-comment sync {task-id} --kind summary --body-file {path} --agent {standard-agent-token}`。

若账本含合法的 `PRC-N` post-review 豁免，摘要正文必须镜像 task.md 中的裁决理由、提交范围、人工身份与时间，并明确这是人工覆盖而非自动校验成功。已有匹配 workflow warning 时，同时镜像其原始 failure code/message；尚无 warning 时只写“裁决已记录、最终门禁待验证”，不得提前宣称豁免已通过。summary marker 仍由同一 `--kind summary` intent 唯一维护。

不要在本步骤同步 task 评论；它依赖 lifecycle 写入后的完整终态 task.md。不要设置 `status:` label，平台自动化应在 Issue 关闭后清理状态标签。

任一操作失败时，任务仍必须位于 active 且短号仍有效；按失败类型调用以下结构化 warning intent，随后继续步骤 5。平台失败不会阻止本地生命周期。

```bash
agent-infra-internal task-warning {task-id} add --step complete-task --severity ACTION_REQUIRED --code {COMMENT_SYNC_FAILED|REQUIREMENTS_SYNC_FAILED|SUMMARY_SYNC_FAILED|NETWORK_RETRY_EXHAUSTED} --target {artifact|issue|summary|platform} --message "{error_code}: {error_message}" --action "修复平台同步问题后重跑 complete-task"
```

相同 `step/code/target` 组合由核心幂等去重；调用方不分配 warning id 或手写账本行。

### 5. 运行 active 预完成硬门禁

平台写入成功后、移动目录和释放短号之前运行：

```bash
agent-infra-internal task-verify {task-id} complete-task.preflight --format text
```

该事件只执行 required-PR delivery hard preflight；身份、并发和本地原子性仍由宿主 finalization 强制执行。外围 review/manual/platform 检查在 lifecycle 后由 `complete-task.completed` 处理，并投影为 warning/pending steps。硬门禁退出码非 0（fail/blocked）时，任务继续留在 active，记录稳定 code/target 后停止。

若需要在摘要中镜像 `post-review-commit` 的 human-decided exemption，在步骤 4 尽力同步原始 failure code/message、PRC id/evidence 和裁决信息；同步失败只记录 `SUMMARY_SYNC_FAILED` warning，仍继续生命周期。最终是否完成由生命周期后的 terminal verification 决定。

`--force` 不能解除身份、并发、本地原子性或 required-PR hard gate；这些能力失败时必须停止。其余审查、人工校验和平台证据由 terminal verification 记录为 warning/pending，并通过后续重试恢复。

### 6. 执行宿主 finalization 入口并验证终态

```bash
agent-infra-internal task-finalization {task-id} complete --agent {standard-agent-token}
```

finalization 按 lifecycle → task 评论 → `complete-task.completed` 校验的固定顺序执行，并将每一步的状态写入宿主 receipt。`result=completed` 即表示 lifecycle 已安全完成；若还有外围 warning，返回 `result=completed_with_warnings`、warnings 和 pending steps。`result=failed` 或 `result=blocked` 仅用于硬失败或 receipt/capability 失败，修复原因后以同一入口重试，不得宣称完成或手工补写局部状态。

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

仅在 finalization 返回 `status=completed` 后确认任务目录已成功移动。

### 7. 处理 finalization 重试与结果

场景 A 与场景 B `finalization-retry` 都从宿主执行同一个 `task-finalization` 入口。receipt 只是重入提示，不是 canonical truth：每次重入都要重新验证终态 task 评论和完成校验；只有任务已处于 `completed` 且短号 registry 已释放时，才可跳过不可逆的 lifecycle。不得拆开调用旧的 lifecycle、评论同步或完成校验命令。若 task 评论或校验因网络问题返回 `blocked`，保留 receipt 和已完成状态，修复网络后重跑 complete-task；若生命周期仍未完成，任务保持 active 并从 receipt 的待处理步骤继续。

完成结果必须包含本次 finalization 的结构化输出，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} complete-task.completed --format text
```

处理结果：
- `status=completed` / 退出码 0（全部通过）-> 继续到「告知用户」步骤
- `status=failed` / 退出码 1 -> 根据输出修复问题后重新运行 finalization
- `status=blocked` / 退出码 2 -> 保留 receipt 与已完成的步骤并停止；稍后重跑 complete-task 进入 `finalization-retry`

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> 完成时间收尾行（整段输出的最后一行）取值 `date "+%Y-%m-%d %H:%M:%S"`（本地时区、不带偏移），固定放在输出的绝对末尾，便于多窗口扫视。本 skill 不渲染「下一步」命令，但会在收尾行之前渲染一段**可选的沙箱清理提示**（见下方门控），且仍统一打印该收尾行。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中的「可选：清理本任务的沙箱」块；任一不满足则整段省略。清理时使用完整 `{task-id}`，不要改用 branch 名。该块独立于「下一步」语义，不是工作流后继命令。

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
（任务已完成，沙箱容器和 per-branch 配置目录不会自动回收。如果不再需要可执行：）

ai sandbox rm {task-id}

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
