---
name: complete-task
description: >
  标记任务完成并归档。
  当任务工作已完成并验证、需要收尾归档时使用。
---

# 完成任务

## 行为边界 / 关键规则

- 本命令更新任务元数据并物理移动任务目录
- 除非强制执行，不要转移有未完成工作流步骤的任务

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认任务存在后、本轮第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本轮 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Complete Task [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。格式与配对规则见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤
### 1. 验证任务存在

检查任务是否存在于 `.agents/workspace/active/{task-id}/`。

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果在 `active/` 中未找到，检查 `blocked/` 和 `completed/`：
- 如果在 `completed/`：告知用户任务已完成
- 如果在 `blocked/`：告知用户任务被阻塞；建议先解除阻塞

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
- [ ] 审查分歧账本无未关闭分歧，且无未复审的 post-review 提交（由下方「预完成硬门禁」机械校验）

**预完成硬门禁（在移动目录、释放短号之前运行）**：步骤 7 的 `gate complete-task` 在目录已 `mv` 到 `completed/`、短号已释放之后才运行；为避免门禁失败发生在不可逆操作之后，必须在 **active 目录**上预先运行新增的两项完成门禁：

```bash
node .agents/scripts/validate-artifact.js check review-ledger .agents/workspace/active/{task-id} --skill complete-task --format text
node .agents/scripts/validate-artifact.js check post-review-commit .agents/workspace/active/{task-id} --skill complete-task --format text
```

任一退出码非 0（fail/blocked）→ 按前置条件未满足处理，**停止**，不执行步骤 3-7。`--force` **不解除**本硬门禁：未关闭分歧必须先在账本闭合（`confirmed`/`closed`/`human-decided`），未复审 post-review 提交必须重新 `review-code` 或在账本追加 `post-review-commit` / `human-decided` 豁免行。

> **⚠️ 前置条件分支判断 — 你必须先判断“继续”还是“停止”：**
>
> - 如果以上所有条件都满足 → 继续步骤 3
> - 如果任意一个条件不满足 → **默认停止**，输出前置条件未满足的警告
> - 只有用户明确要求 `--force` 时，才可以在前置条件未满足时继续
>
> **禁止在前置条件未满足时继续执行步骤 3-7，也不要输出「任务 {task-id} 已完成，任务目录已转移到 completed/。」**

如果任何前置条件未满足，警告用户：
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {缺失的前置条件}

Please complete the missing steps first, or use --force to override.
```

如果前置条件未满足且用户未明确提供 `--force`，立即停止，不执行步骤 3-7。

### 3. 更新任务元数据

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `status`：completed
- `current_step`：completed
- `completed_at`：{当前时间戳}
- `target_date`：仅当为空时写入 `completed_at` 的日期部分（`YYYY-MM-DD`）；已有值（人工填写）则保留
- `updated_at`：{当前时间戳}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- 新增或更新 `## 状态核对` 段，粘贴第 0 步审计命令原文（含 `$ ` 前缀行），放在 `## 活动日志` 之前
- 标记所有工作流步骤为已完成
- 逐项验证并勾选 `## 完成检查清单` 中的所有条目（将 `- [ ]` 改为 `- [x]`）
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Complete Task** by {agent} — Task moved to completed/
  ```

### 4. 转移任务

将任务目录从 active 移动到 completed：

```bash
mv .agents/workspace/active/{task-id} .agents/workspace/completed/{task-id}
```

### 5. 验证转移

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

确认任务目录已成功移动。

### 6. 同步到 Issue

检查 `task.md` 中是否存在有效的 `issue_number`。如果没有，跳过此步骤且不输出任何内容。

> Issue 同步规则见 `.agents/rules/issue-sync.md`。执行同步前先读取该文件，完成 upstream 仓库检测和权限检测。

如果存在有效的 `issue_number`：
- 先按 `.agents/rules/issue-sync.md` 的补发规则扫描并补发未发布的 `task.md`、`analysis*.md`、`review-analysis*.md`、`plan*.md`、`review-plan*.md`、`code*.md`、`review-code*.md` 评论（`task.md` 走幂等更新路径）
- 按 issue-sync.md 的需求复选框同步步骤，兜底同步 `## 需求` 中已勾选的条目到 Issue body
- 不要设置 `status:` label — Issue 关闭后 status label 会被自动清除
- 最后创建或更新 `.agents/rules/issue-sync.md` 中定义的 summary 评论标记对应的 summary 评论
- 读取 `.agents/rules/issue-fields.md`，按流程 A 把 `task.md` 中所有非空的 Issue 字段（`priority`/`effort`/`start_date`/`target_date`）同步到 Issue（幂等；`has_push=false` 或取数/写入失败时跳过，不阻断）

### 7. 完成校验

**释放短号**（先 `mv` 目录已成功，再 release；脚本幂等，未在注册表也返回 0）：

```bash
node .agents/scripts/task-short-id.js release "$task_id" || true
```

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate complete-task .agents/workspace/completed/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

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
