---
name: commit
description: >
  提交当前变更到 Git。
  当需要把已完成的工作落为一次 Git 提交时使用。
---

# 提交代码
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`antigravity`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`antigravity-cli`→`antigravity`）或人工例外 `human`。


在不覆盖用户本地工作的前提下创建 Git commit，并在需要时更新关联任务状态。

更新关联 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

若入口业务操作数包含字面 `--orchestrated`，绑定 `{execution-flag}` = `--orchestrated`；否则绑定为空。不得从 run 文件或环境推断来源。

直接调用仍要求用户显式授权。编排调用只有在副作用前通过 commit intent 对 activated receipt 与一次性 `commitAuthorization` 的联合校验后才可继续，其他提交门禁保持不变。

## 常见违规借口与反驳

| 借口 | 反驳 |
|------|------|
| 「测试之前跑过了，不用重跑」 | 暂存内容是最新现实；提交前必须重新核对 `git status`/`git diff`，不能凭记忆。 |
| 「`git add -A` 更省事」 | 禁止 `git add -A`/`git add .`；只暂存明确列出的文件，避免带入无关改动。 |
| 「改了带版权头的文件，年份先不动」 | 改了就更新版权年份（动态取 `date +%Y`），这是提交前的硬性检查。 |

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

未显式指定 task scope 时，只有 `TASK_CONTEXT_NOT_FOUND` 可继续既有纯提交路径；detached HEAD、损坏候选或多匹配属于歧义，必须失败。显式 task scope 解析失败时一律失败。

## 步骤开始：恢复或创建受控 attempt

已解析出 `{task-id}` 时，先调用 `agent-infra-internal task-orchestration {task-id} commit-status`：

- `recoverable`：调用 `commit-recover --agent {standard-agent-token}` 完成收尾，不得重复 commit 或 push。
- `prepared`：调用 `commit-recover --agent {standard-agent-token}` 安全清理 intent，再次查询 status 并复用返回的 `retryable-start` attempt。
- `retryable-start`：调用 `commit-recover --agent {standard-agent-token}` 取得原 attempt，不追加第二条 started。
- `invalid` / `conflict` / `orphaned-start`：输出结构化 code 与状态证据并停止。
- `idle`：调用 `commit-start --agent {standard-agent-token}`，由核心在任务锁内原子写入结构化 started 并返回 attempt/baseline。

只从 `commit-start` / `commit-recover` 的结构化输出读取 `{commit-attempt}`；不得手写、复制或猜测 attempt。无任务上下文的纯提交跳过本协议。

## 1. 检查本地修改（关键）

在任何编辑前先检查：

```bash
git status --short
git diff
```

必须尊重现有用户改动；如果你的计划与之冲突，先停止并征求确认。

## 2. 更新版权头年份

动态获取当前年份，只更新已经改动过的文件。

> 完整版权检查流程见 `reference/copyright-check.md`。修改任何版权头前，先读取 `reference/copyright-check.md`。

## 3. 生成提交信息

检查状态、diff 和最近历史，然后按 Conventional Commits 生成 message，并补齐正确的协作署名。

> 提交信息规则、示例和多代理署名细节见 `reference/commit-message.md`。写 commit message 前先读取 `reference/commit-message.md`。

## 4. 创建提交

已解析出 `{task-id}` 时，执行本步骤前先读取 `reference/commit-orchestration.md`，并在任何 Git/平台成功副作用前完成 `commit-begin`；无任务上下文的纯 Git 提交完全跳过 intent 协议。

先判断受限 push-only 场景；否则把 message、显式路径、expected HEAD/tree 写入临时 JSON，并调用 `agent-infra-internal git-workflow commit --input {file}`。core 负责范围、敏感文件、暂存树和幂等校验。

普通 commit 成功后必须立即按该 reference 执行 committed checkpoint；checkpoint 失败时保留 intent 并停止，不得继续 push 或写成功状态。

如果本次提交关联任务且存在 `review-code` 产物，在提交前读取最高轮 `review-code` 产物：
- 若该产物 `总体结论` / `Overall Verdict` 为 Approved，解析 `R`、`F` 与 `审查快照树` / `Reviewed Snapshot Tree`（`T`）
- 暂存明确文件后记录 `pre_head=$(git rev-parse HEAD)`，并以 helper 的 JSON 模式生成当前完整工作区树 `W` 与规范化暂存树 `S`
- 在 `git commit` 前要求 `pre_head == R && W == T && S == T`；分别运行 helper 的 `compare` 模式生成 worktree/staged 的 added、missing、different 路径诊断
- 任一条件不满足时进入 `reference/task-status-update.md` 的“场景 4：提交前快照阻断”，不得执行 `git commit`、push、成功状态更新、PR 摘要同步或完成 gate
- 全部相等并成功提交后，由步骤 6 的 `commit-complete` 核心收尾原子写入 `last_reviewed_commit` 与 Commit done；调用方不得手写
- 不向后扫描更早的 Approved 产物；最高轮 `review-code` 产物是唯一权威来源

## 5. 推送到已有 PR（按需）

新提交完成或步骤 4 命中 push-only 后，如果当前分支已存在开放的 Pull Request，则把 HEAD 普通推送上去让 PR 自动更新；否则保持现状（首次推送仍由 `create-pr` 负责）。本步骤不创建额外/空 commit，也不在无 PR 时推送；与是否关联任务无关。

> 检测当前分支是否有开放 PR、以及平台认证，统一按 `.agents/rules/issue-pr-commands.md` 执行；该规则不可用或检测失败时，按下方降级处理。

a. 按 `.agents/rules/issue-pr-commands.md` 检测当前分支（head）是否存在开放 PR。

b. 命中开放 PR -> 推送当前分支：

通过 `agent-infra-internal git-workflow push --input {file}` 逐 ref 普通推送并复核，禁止 force push。

推送成功并完成远端复核后，必须立即按 `reference/commit-orchestration.md` 执行 pushed checkpoint。

c. 安全降级（不阻塞已完成的 `git commit`，仅提示用户）：
   - 平台不可用 / 未认证 / 检测失败 / 未命中开放 PR -> 不推送，继续后续步骤。
   - `git push` 失败（如需 `git pull --rebase`、无 upstream、网络异常）-> 保留本地提交，提示用户手动推送。

把推送结果（pushed / skipped(no PR) / failed）并入下一步「更新任务状态」的 Activity Log 说明或用户输出。

## 6. 按需更新任务状态

普通 commit/push checkpoint 完成后，先调用核心收尾；它在同一任务锁内写入审查锚点、Commit done 与 orchestration planned bytes，最后删除 intent：

```bash
agent-infra-internal task-orchestration {task-id} commit-complete --token "$commit_intent_token" --agent {standard-agent-token}
```

失败时保留 intent，输出 `commit-status` 后停止；重跑本技能由开头的 status/recover 路由恢复。调用方不得重复追加 Commit done 或修改 `last_reviewed_commit`。

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

> 完整的 5 种状态分支、前置条件检查和多 TUI 下一步命令见 `reference/task-status-update.md`。更新任务状态前，先读取 `reference/task-status-update.md`。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，并按 `reference/task-status-update.md` 的已选场景调用统一 helper。

核心收尾成功后只能选择一个下一步分支：
- 已有开放 PR 且 push 成功 -> `watch-pr {task-ref}`；该分支优先于最终提交的 `prFlow` 路由
- push 失败 -> 保持任务 active，只输出推送/同步诊断，不输出 `watch-pr` 或 `complete-task`
- 最终提交 -> 按 `.agents/.airc.json` 的 `prFlow` 渲染下一步（`disabled` → 单选 `complete-task`；`required` → 单选 `create-pr`；缺省 → 二选一 `create-pr` / `complete-task`），详见 `reference/task-status-update.md` 场景 1
- 还有后续工作 -> 更新 task.md 后停止
- 准备审查 -> `review-code {task-id}`

## 7. 同步 Issue 元数据（按需）

当 `{task-id}` 存在且 task.md 包含有效 `issue_number` 时，同步 `in:` label 和需求复选框到关联 Issue；否则跳过。

> 触发条件与声明式 `platform-issue` 调用见 `reference/issue-metadata-sync.md`。执行前先读取该文件。
>
> 如果本步骤会访问代码托管平台，则先按 `.agents/rules/issue-pr-commands.md` 完成前置检测。

失败处理与「按需更新任务状态」一致：警告但**不**阻塞已完成的 `git commit`。

## 8. 同步 PR 摘要（按需）

当 `{task-id}` 存在且 task.md 包含有效 `pr_number` 时，刷新 PR 上由 `.agents/rules/pr-sync.md` 中定义的 PR 摘要评论标记对应的摘要评论；否则跳过。

> 完整的触发条件、聚合规则、PATCH/POST 流程、Shell 安全约束和错误处理见 `reference/pr-summary-sync.md`（其内联引用 `.agents/rules/pr-sync.md`）。执行此步骤前先读取 `reference/pr-summary-sync.md`。
>
> 如果本步骤会访问代码托管平台，则先按 `.agents/rules/issue-pr-commands.md` 完成前置检测，确保 `.agents/rules/pr-sync.md` 所需的运行时上下文已就绪。

失败处理与「按需更新任务状态」一致：警告但**不**阻塞已完成的 `git commit`。

## 9. 完成校验

如果本次操作关联了 `{task-id}`，运行完成校验，确认任务元数据和同步状态符合规范；如果没有任务上下文，跳过本步骤。

```bash
agent-infra-internal task-verify {task-id} commit.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续后续收尾步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

本 gate 只在步骤 6 核心收尾成功后运行；不得把完成校验放在 `commit-complete` 之前。

## 注意事项

- 不要提交 `.env`、凭据、密钥等敏感文件
- 协作署名中当前代理必须排在最前面
- 不要使用 `git add -A` 或 `git add .`

## 错误处理

- 如果任务状态更新失败，警告用户，但不要因此阻止提交
