# 双向审查握手协议

> 三阶段（analysis / plan / code）的执行方与检视方在执行 `review-*` 与 `*-task` 技能时共用本协议。
> 这是协议的**单一事实源**；各 SKILL 只 `Read` 本文件，不重复抄写词表。

## 核心原则

- **检视意见是待验证输入，不是执行命令**。执行方必须逐条核实后再处置，不默认认账、不盲目反驳。
- **对称证据负担**：无论接受还是反驳，每条处置都要附**相称证据**。"接受"不是零成本默认路径。
- **达成一致再推进**：存在未关闭分歧、替代修法、无法判断或 review 后新增提交时，不得静默进入下一阶段、归档或合并。

## 执行方四态处置（`*-task` 技能，Round ≥ 2 响应上一轮审查时）

对上一轮 `review-*` 的每条 finding，先 Read/Grep 核实其引用的 `file:line` / 命令，再落一个状态：

| 状态 | 含义 | 必附证据 |
|------|------|----------|
| `accepted` | 成立，将按建议修复 | 指向修复点的 `file:line` 或本轮将施加的改动说明 |
| `adjusted` | 成立，但采用替代修法 | 替代修法说明 + 为何更优；待检视方确认 |
| `refuted` | 核实后判定不成立 / 幻觉 / 基于错误 `file:line` | 反证（`file:line` 或命令原文）；待检视方确认 |
| `cannot-judge` | 证据不足，无法判断 | 已尝试的核实路径；交检视方/人工 |

## 检视方回交义务（`review-*` 技能，对执行方响应复核时）

执行方给出 `adjusted` / `refuted` / `cannot-judge` 后，检视方必须逐条回应，不得复读原意见或无视：

- **撤回 finding** → 账本置 `confirmed`（接受反驳）。
- **接受替代修法** → 账本置 `confirmed`。
- **补充新证据后坚持** → 账本置回 `open`（带新证据，回到执行方）。
- **升级人工裁决** → 账本置 `needs-human-decision`。

## 收敛终止语义（防死循环）

- 单条 finding 的握手轮次上限 `MAX_HANDSHAKE_ROUNDS`，默认 **3**，可在 `.agents/.airc.json` 的 `review.maxHandshakeRounds` 覆盖。
- 某条 finding 的 `round` 达到上限仍未进入终态，必须强制置 `needs-human-decision`；gate 会拦截"达限却未升级"的行。
- `needs-human-decision` 持续阻塞完成，直到人工在 task.md `## 人工裁决` 段记录裁定并把该行翻为 `human-decided`。

## 同源模型收敛偏差缓解（文档级纪律）

执行方与检视方常由相近模型承担，天然容易互相同意。检视时遵守：

1. **先看证据再看结论**：先读 `git diff` / 产物本体并独立形成 findings，**再**读执行方的结论与响应，避免被其结论锚定。
2. **默认怀疑框架**：把"看起来没问题"视为未验证；每条放行都要有可复现证据支撑（见各 `review-*` 的 `证据原文` 段硬门禁）。

> 唯一的机械杠杆是**对称证据 gate**（账本非 `open` 行必须有证据）；模型同源性本身不可机械校验，故本节为纪律而非门禁。

## 机械账本（task.md `## 审查分歧账本`）

分歧状态的**单一事实源**是 task.md 的固定段 `## 审查分歧账本`，单张可解析表。阶段推进与 `complete-task` 的 gate 读取本段。

```markdown
## 审查分歧账本

<!-- 每条 review finding 一行；状态机/证据规则见 .agents/rules/review-handshake.md。阶段推进与 complete-task gate 读取本段。 -->

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|
| CD-1 | code | 1 | blocker | open | review-code.md#1 |
```

- `id`：阶段前缀 + 序号——analysis→`AN-`、plan→`PL-`、code→`CD-`；执行方自提的人工裁决行使用 `HD-`。
- `stage` ∈ `{analysis, plan, code}`（外加保留值 `post-review-commit`，仅用于 post-review 豁免行）。
- `status` 合法枚举：`open` / `accepted` / `adjusted` / `refuted` / `cannot-judge` / `confirmed` / `needs-human-decision` / `closed` / `human-decided`。
- **终态集合（gate 放行）**：`{confirmed, closed, human-decided}`；其余为阻塞态。
- **同轮 fix-and-close**：仅当检视方在当前审查轮当场修复 `minor` finding 时，可通过 `finding-review` 将该行从 `open` 直接置为 `closed`。此转换不增加 `round`，`evidence` 必须指向当前 review 产物中的修复证据；`blocker` / `major` 不适用。
- **severity 与推进解耦**：`blocker` / `major` / `minor` 只表示影响大小。任何正式 finding 只要尚未进入终态就阻止当前阶段通过；review 结论、事件计数与下一步必须在全部写入后通过 `task-ledger stage-status --stage {stage}` 从同一语义导出。
- **非阻塞 advisory**：仅限不影响当前产物完整性、正确性和验收的后续优化。advisory 只写入报告的独立段落，不进入本账本、不进入 finding 计数、不影响 verdict；manual-validation 仍是独立分类。
- **写入责任**：调用方只提交结构化意图，不扫描编号、不拼表格行、不自行判断机械状态迁移。`review-*` 用 `agent-infra-internal task-ledger {task-id} finding-upsert|finding-review ...`；`*-task` 用 `finding-respond ...`；人工裁决由 `ai decide` 原子完成。核心统一校验并通过一次任务写入提交。
- **向后兼容**：task.md 无此段时，gate 视为无未决分歧而放行。

### 执行方自提人工裁决行

当执行方判定某项为需人工裁定的关键设计决策时，必须按 `.agents/rules/human-decision-context.md` 把自足详情块写入产物的 `## 人工裁决待办` 段，标题形如 `### HD-N：<标题> [needs-human-decision]`，并在 task.md `## 审查分歧账本` upsert 对应 `HD-` 行：

```markdown
| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |
```

- `id`：`HD-N` 编号**全局唯一**。先调用 `agent-infra-internal task-ledger {task-id} decision-next-id` 取得 `entityId`，产出稳定标题后调用 `decision-upsert --id {HD-N} --stage {stage} --artifact {artifact}`；不得由模型扫描或分配编号。
- `stage` 填该决策产生的阶段：`analysis` / `plan` / `code`。
- `round` 填 `-`，因为它不是 review finding 的握手轮次。
- `severity` 固定填 `decision`。
- `status` 初始填 `needs-human-decision`，因此会被现有 gate 阻塞。
- `evidence` 指向稳定锚点 `<artifact>#HD-N`（如 `plan-r2.md#HD-1`），不依赖易漂移的行号。
- 人工使用 `ai decide <task-ref> <序号|账本ID> <裁决内容>` 记录裁定；命令把目标行翻为 `human-decided`，并让 `evidence` 指向独立 `HDR-N` 裁定记录。

> 查看、裁决与 typed verification 共用 `lib/task/ledger.ts` 的领域语义。

## post-review commit 门禁（仅 code 阶段）

- `review-code` 一次性捕获审查基线 `R`（diff base）、完整工作区差异指纹 `F` 与规范化快照树 `T`；Approved 且快照干净时可令 `B=R`，Approved 且含未提交差异时清除/不写 `B`。
- `commit` 只读取最高轮 Approved `review-code` 产物；提交前比较 `pre_head == R`、完整工作区树 `W == T`、规范化暂存树 `S == T`，任一失配都在 `git commit` 前阻断并报告两组 added/missing/different 路径。
- 成功提交后令 `B=last_reviewed_commit=<new_head>`；`B` 只表示已经落到 Git commit 的审查锚点。
- `complete-task` 的 `post-review-commit` gate 只使用 B；B 缺失、畸形或对象不存在时报告 `reviewed snapshot was not anchored`，不得回退 R。
- 若 B 之后代码 / 规则路径出现新提交，gate 会拦截，要求重新 `review-code`。唯一自动例外是绑定 GitHub PR 已合并，且平台快照证明 B 是原 PR head、merge commit 位于本地 HEAD 历史中、受审查变更与单父 squash commit 的规范化补丁完全一致，并且 merge 后受保护路径没有新提交；缺少任一平台或 Git 证据时 fail closed。
- `required-checks` 复用同一严格 / squash 等价判定，并始终读取原 PR head 的 required checks；checks 未通过不因合并而放宽。
- **豁免**：在账本追加一行 `| PRC-1 | post-review-commit | - | - | human-decided | <裁定说明> |`，记录人工明确允许该批提交免复审。

## gate 行为速查

| 调用方 | `review-ledger` 作用域 | `post-review-commit` |
|--------|------------------------|----------------------|
| `plan-task` | 仅 `analysis` 阶段行须终态 | 不挂 |
| `code-task` | `analysis` + `plan` 阶段行须终态 | 不挂 |
| `complete-task` | 全部阶段行须终态 | 挂（见上） |
| `analyze-task` | 不挂（首阶段） | 不挂 |
