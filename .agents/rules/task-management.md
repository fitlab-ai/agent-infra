# 通用规则 - 任务管理

## 任务语义识别

根据用户意图自动映射到对应工作流命令：
- “分析 issue #123” -> `import-issue`
- “分析任务 TASK-20260306-143022” -> `analyze-task`
- “审查需求分析” -> `review-analysis`
- “设计方案” -> `plan-task`
- “审查方案/审查技术方案” -> `review-plan`
- “实施/实现” -> `code-task`
- “审查代码/代码审查” -> `review-code`
- “修复审查问题” -> `code-task`

## 任务状态管理

- 每次执行工作流命令后，必须立即更新对应任务的 `task.md`
- 至少同步 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`，以及本轮产物引用
- 更新 `agent_infra_version` 前，先读取 `.agents/rules/version-stamp.md`
- Activity Log 只能追加，不能覆盖历史记录

## 合作者 token 规范

`--agent` 取值必须收敛到标准 AI 合作者 token，禁止填入 OS 系统用户名（如 `devuser`）或 git 用户名（如 `季聿阶`）。标准集合（短名为活动日志唯一事实来源）：

- AI 短名：`claude` / `codex` / `antigravity` / `opencode` / `cursor`
- 长名映射（写入前归一化为短名）：`claude-code` → `claude`、`antigravity-cli` → `antigravity`
- 历史 `gemini` / `gemini-cli` 仅保留 `ai task log` 渲染兼容，不接受写入
- 人工步骤例外：无论使用哪个 Agent，只要是人做的决定，统一声明 `human`

七个内部命令（`task-event` / `task-lifecycle` / `task-finalization` / `platform-issue` / `platform-comment` / `platform-pr` / `task-orchestration`）对 `--agent` 做白名单硬校验：接受短名、长名或 `human`，非标准值返回对应 `*_PAYLOAD_INVALID` 错误；长名在落库/透传前归一化为短名。渲染端 `ai task log` 对无法识别的 token 保留 `human` 归类并附加 `(unknown)` 标记。

## 状态快照与完成验证入口

- 运行时 SKILL 需要记录 git、任务目录和 task.md tail 证据时，统一调用 `agent-infra-internal task-snapshot {task-id} --format text`；不得自行解析短号、扫描 workspace 或重新拼接三段状态命令。
- 运行时 SKILL 需要执行完成门禁时，统一调用 `agent-infra-internal task-verify {task-id} <verification-event> [--artifact <artifact>] --format text`；业务事件到 skill、workspace、gate/check 顺序和产物族的映射由 typed verification catalog 唯一维护。
- `task-verify` 在进程内执行 typed catalog/check registry；SKILL 只声明业务事件，不传 task-dir、skill 名或特殊 check 序列。
- 两个入口均保持只读；验证退出码固定为 `0=pass`、`1=fail`、`2=blocked`，网络或平台阻塞不得降格为成功。

## 常见命令的状态更新要求

- `create-task`：创建 `branch`、`workflow`、`status`、`created_at`、`updated_at`、`assigned_to`、`agent_infra_version`
- `import-issue`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `import-codescan`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `import-dependabot`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `restore-task`：更新 `status`、`updated_at`、`assigned_to`、`agent_infra_version`
- `analyze-task`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `review-analysis`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `plan-task`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `review-plan`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `code-task`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `review-code`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `create-pr`：更新 `pr_number`、`updated_at`、`agent_infra_version`
- `commit`：更新 `updated_at`、`agent_infra_version`；必要时更新 `current_step`（详见 `commit/reference/task-status-update.md`）
- `complete-task`：更新 `status`、`current_step`、`completed_at`、`updated_at`、`agent_infra_version`
- `block-task`：更新 `status`、`blocked_at`、`updated_at`、`agent_infra_version`
- `cancel-task`：更新 `status`、`cancelled_at`、`cancel_reason`、`updated_at`、`agent_infra_version`

## Activity Log started / done 双标记约定（单一事实源）

`analyze-task`、`review-analysis`、`plan-task`、`review-plan`、`code-task`、`review-code` 必须通过 `agent-infra-internal task-event` 声明业务事件；事件核心统一生成 `current_step`、`assigned_to`、`updated_at`、`agent_infra_version` 和下述日志文本。其余尚未迁移的生命周期 SKILL 继续遵循本节文本协议。

> 本节是 started/done 双标记的唯一权威定义。各 SKILL、渲染器与 typed verification check 都以本节为准。

**行语法不变**：started 与 done 都沿用既有条目语法
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **{action}** by {agent} — {note}`，因此解析正则
（`log.ts:ENTRY_RE` 与 verification activity parser）无需改动。

- **started 行**（步骤开始时写）：action 在既有基名末尾加后缀 ` [started]`，note 用 `started`：
  `- {time} — **{基名} [started]** by {agent} — started`
- **done 行**（步骤完成时写，与现状一致）：action 即基名本身：
  `- {time} — **{基名}** by {agent} — {完成说明}`
- **Commit 专用 attempt**：commit 技能不得手写 started。`commit-start` 在任务锁内写入带 `attempt`、`baseline`、`agent` 的结构化 `Commit [started]`；无副作用放弃时由 `commit-terminate` 写匹配的 `Commit [aborted]`。aborted 只闭合活动日志，不构成提交成功证据。
- `{基名}` 指该 SKILL 既有 done 条目的 action 文本，含 `(Round {N})`（如 `Plan Task (Round 1)`）。
  started 与 done 共用同一 `{基名}` 才能配对。

**配对与渲染**（`ai task log`）：按 `{基名}` 把 started 与其后最近的同名 done 配成一行（同基名多次执行按时间升序 FIFO 配对）。STARTED 列显示 started 时间、DONE 列显示 done 时间；只有 started 无 done = 进行中（DONE 显示 `(in progress)`）；只有 done 无 started（历史日志）= 单态完成行。三种形态都合法、不报错。

**人工计数**（`ai task log`）：审查步骤行把两项人工计数并入 NOTE 的 verdict 文本，逗号分隔、紧随 `blockers/major/minor`，固定英文标签 `Manual-validation: {e}, Human-decision: {h}`。`Human-decision`（`{h}`）按 canonical 步骤名前缀（`Review Analysis` / `Review Plan` / `Review Code`）映射到 `analysis` / `plan` / `code`，统计 `## 审查分歧账本` 中对应阶段 `status = needs-human-decision` 的当前待裁决数量，不包含已 `human-decided` 的行；`Manual-validation`（`{e}`）解析 review done note 中的 `Manual-validation: {n}` 源字段（展示时归一化为同一字段），缺失为 `0`。非审查步骤不附加人工计数。

**gate**（`checkActivityLog`）：计算「最新 action / freshness」时跳过 `[started]` 行（升序与格式校验仍覆盖全部行），故 started 标记不会污染各 SKILL 的 `expected_action_pattern`。

**写 started 的 SKILL**：所有**会向某个任务的 `## 活动日志` 追加条目**的工作流 SKILL 都写 started，保证 `ai task log` 整张表的 STARTED 列一致完整。两种写法按技能是否已有 task.md 区分：

- **常规写法（task.md 已存在）**——在「该轮实质工作开始时」（前置条件确认后、第一个产出动作前）追加 started 行，完成时写 done 行：
  `analyze-task`、`plan-task`、`code-task`、`review-analysis`、`review-plan`、`review-code`、`commit`、`complete-task`、`create-pr`、`watch-pr`、`block-task`、`cancel-task`、`restore-task`、`close-codescan`、`close-dependabot`。
- **延迟补写（本技能创建 task.md，开始时无文件可写）**——开始执行前先在内存记录 `started_at`，最后写活动日志时**一次性补两条**（started 行用 `started_at`、done 行用完成时间）：
  `create-task`、`import-issue`、`import-codescan`、`import-dependabot`。

- **宿主解析后写入**——`review-pr` 只有在唯一任务宿主、canonical round 与被审 head 确定后才通过 `task-activity pr-review-start` 写 started；成功以 `pr-review-complete` 闭合，已知未发布的受控失败或 head 漂移以 `pr-review-terminate` 写 `aborted` / `superseded` 终态。同一 task/round/head/terminal payload 重放为 no-op；一次性检视不写任务日志。

**例外**：`check-task` 等只读巡检类、不代表实质工作推进的技能不写 started。无 task.md 上下文的纯操作（如无关联任务的 `commit`）同样跳过。
