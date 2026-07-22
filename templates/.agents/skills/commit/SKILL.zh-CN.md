---
name: commit
description: >
  提交当前变更到 Git。
  当需要把已完成的工作落为一次 Git 提交时使用。
---

# 提交代码

在不覆盖用户本地工作的前提下创建 Git commit，并在需要时更新关联任务状态。

更新关联 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 常见违规借口与反驳

| 借口 | 反驳 |
|------|------|
| 「测试之前跑过了，不用重跑」 | 暂存内容是最新现实；提交前必须重新核对 `git status`/`git diff`，不能凭记忆。 |
| 「`git add -A` 更省事」 | 禁止 `git add -A`/`git add .`；只暂存明确列出的文件，避免带入无关改动。 |
| 「改了带版权头的文件，年份先不动」 | 改了就更新版权年份（动态取 `date +%Y`），这是提交前的硬性检查。 |

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

未显式指定 task scope 时，只有 `TASK_CONTEXT_NOT_FOUND` 可继续既有纯提交路径；detached HEAD、损坏候选或多匹配属于歧义，必须失败。显式 task scope 解析失败时一律失败。

## 步骤开始：写入 started 标记

开始检查本地修改之前，向 task.md `## 活动日志` 追加一条 started 标记（与本步骤 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Commit [started]** by {agent} — started
```

`ai task log` 会把它与提交完成时写入的 done 条目配对成一行（进行中 → 已完成）。格式与配对规则见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。仅当本任务存在 task.md 时写入（无任务上下文的纯提交可跳过）。

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

先判断是否命中受限 push-only 场景：工作树与暂存区均干净、最高轮 `review-code` 为 Approved、`HEAD == last_reviewed_commit`、当前分支绑定开放 PR 且 PR head != HEAD。命中时不创建空 commit，不进入下方暂存流程，直接转步骤 5 做普通 `git push`；不得 force push。否则只暂存明确列出的文件并执行 `git commit`。

如果本次提交关联任务且存在 `review-code` 产物，在提交前读取最高轮 `review-code` 产物：
- 若该产物 `总体结论` / `Overall Verdict` 为 Approved，解析 `R`、`F` 与 `审查快照树` / `Reviewed Snapshot Tree`（`T`）
- 暂存明确文件后记录 `pre_head=$(git rev-parse HEAD)`，并以 helper 的 JSON 模式生成当前完整工作区树 `W` 与规范化暂存树 `S`
- 在 `git commit` 前要求 `pre_head == R && W == T && S == T`；分别运行 helper 的 `compare` 模式生成 worktree/staged 的 added、missing、different 路径诊断
- 任一条件不满足时进入 `reference/task-status-update.md` 的“场景 4：提交前快照阻断”，不得执行 `git commit`、push、成功状态更新、PR 摘要同步或完成 gate
- 全部相等并成功提交后，在 task.md frontmatter 写入 `last_reviewed_commit: <new_head>`
- 不向后扫描更早的 Approved 产物；最高轮 `review-code` 产物是唯一权威来源

## 5. 推送到已有 PR（按需）

新提交完成或步骤 4 命中 push-only 后，如果当前分支已存在开放的 Pull Request，则把 HEAD 普通推送上去让 PR 自动更新；否则保持现状（首次推送仍由 `create-pr` 负责）。本步骤不创建额外/空 commit，也不在无 PR 时推送；与是否关联任务无关。

> 检测当前分支是否有开放 PR、以及平台认证，统一按 `.agents/rules/issue-pr-commands.md` 执行；该规则不可用或检测失败时，按下方降级处理。

a. 按 `.agents/rules/issue-pr-commands.md` 检测当前分支（head）是否存在开放 PR。

b. 命中开放 PR -> 推送当前分支：

```bash
git push
```

c. 安全降级（不阻塞已完成的 `git commit`，仅提示用户）：
   - 平台不可用 / 未认证 / 检测失败 / 未命中开放 PR -> 不推送，继续后续步骤。
   - `git push` 失败（如需 `git pull --rebase`、无 upstream、网络异常）-> 保留本地提交，提示用户手动推送。

把推送结果（pushed / skipped(no PR) / failed）并入下一步「更新任务状态」的 Activity Log 说明或用户输出。

## 6. 按需更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

> 完整的 5 种状态分支、前置条件检查和多 TUI 下一步命令见 `reference/task-status-update.md`。更新任务状态前，先读取 `reference/task-status-update.md`。

> **重要**：向用户展示下一步时，必须完整输出所有 TUI 命令格式，并直接使用 `reference/task-status-update.md` 中对应场景的标准模板。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

追加 Commit 的 Activity Log，并且只能选择一个下一步分支：
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

## 注意事项

- 不要提交 `.env`、凭据、密钥等敏感文件
- 协作署名中当前代理必须排在最前面
- 不要使用 `git add -A` 或 `git add .`

## 错误处理

- 如果任务状态更新失败，警告用户，但不要因此阻止提交
