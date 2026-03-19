---
name: commit
description: >
  提交当前变更到 Git，包含版权头年份检查和任务状态更新。
  当用户要求提交代码或保存变更时触发。
---

# 提交代码

提交当前变更到 Git。

## 步骤 0：检查本地修改（关键）

**强制步骤**：在任何编辑之前，你**必须**检查用户的本地修改以避免覆盖其工作。

```bash
git status --short
git diff
```

**规则**：
1. **仔细阅读 `git diff` 输出** —— 理解用户已经做了哪些修改
2. **在用户修改基础上进行增量编辑** —— 不要覆盖其实现
3. **如果你计划的编辑与用户修改冲突**，先询问用户：
   ```
   This file has local modifications:
   - Your changes: [描述用户的修改]
   - My planned changes: [描述计划的修改]
   Please confirm how to proceed.
   ```
4. **不要**重写用户已实现的代码
5. **不要**添加用户没有要求的"改进"

## 步骤 1：更新版权头年份（关键）

**强制步骤**：提交之前，检查并更新所有修改文件的版权头。

### 获取当前年份

```bash
date +%Y
```

**绝不硬编码年份。**

### 检查修改的文件

```bash
git status --short
```

### 对每个修改的文件

检查文件是否有版权头：
```bash
grep "Copyright.*[0-9]\{4\}" <modified_file>
```

如果有版权头且年份不是当前年份，更新年份。

**常见格式**：
- `Copyright (C) 2024-2025` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2024` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2025` -> `Copyright (C) {CURRENT_YEAR}`（如果已是当前年份）

### 版权检查清单

执行 `git commit` 之前：
- [ ] 使用 `date +%Y` 动态获取当前年份
- [ ] 检查了所有即将提交的文件
- [ ] 更新了所有有版权头的文件的版权年份
- [ ] **绝不**硬编码年份
- [ ] **仅**更新修改的文件，而非整个项目

## 步骤 2：分析变更并生成提交信息

```bash
git status
git diff
git log --oneline -5
```

生成 Conventional Commits 格式的提交信息：
- `<type>(<scope>): <subject>`（英文祈使语气，不超过 50 字符）
- Body：2-4 个要点说明修改了什么以及为什么
- 署名块：
  - `Co-Authored-By: {你的模型名称} <noreply@provider.com>`
  - 如果与任务相关，追加其他贡献 Agent 的 `Co-Authored-By` 行

### 多 Agent 协作署名（仅任务相关提交）

如果本次提交属于某个活动任务，且存在 `.agent-workspace/active/{task-id}/task.md`：

1. 读取 `task.md` 中的 `## Activity Log` 部分。
2. 从符合 `by {agent}` 的条目中提取所有唯一 Agent 名称；可使用较宽松的匹配模式，例如 `by (\S+)`。
3. 排除 `human`，因为 Git author 已经是人类用户。
4. 将 Agent 名称映射为 `Co-Authored-By` 行：

| Agent | 署名 |
|-------|------|
| `claude` | `Co-Authored-By: Claude <noreply@anthropic.com>` |
| `codex` | `Co-Authored-By: Codex <noreply@openai.com>` |
| `gemini` | `Co-Authored-By: Gemini <noreply@google.com>` |
| `opencode` | `Co-Authored-By: OpenCode <noreply@opencode.ai>` |

5. 构建署名块时遵循以下规则：
   - 保持当前执行提交的 Agent 署名在原有位置。
   - 将其他唯一参与 Agent 作为额外的 `Co-Authored-By` 行追加。
   - 如果当前 Agent 已在 `Activity Log` 中出现，不要重复追加。
   - 未知 Agent 名称使用兜底格式 `Co-Authored-By: {Agent} <noreply@unknown>`。

如果本次提交与任务无关，保持原有单行署名行为不变。

## 步骤 3：创建提交

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

- <要点 1>
- <要点 2>

Co-Authored-By: {你的模型名称} <noreply@provider.com>
<其他任务参与者的额外 Co-Authored-By 行（如有）>
EOF
)"
```

**重要**：
- 按名称添加特定文件 —— 不要使用 `git add -A` 或 `git add .`
- 不要提交可能包含密钥的文件（.env、凭据、密钥）
- 对于任务相关提交，保持当前 Agent 署名在前，并在其后追加上面生成的额外署名行

## 步骤 4：更新任务状态（如果与任务相关）

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

提交后，根据情况更新任务状态：

对于以下所有情况，**追加**到 task.md 的 `## Activity Log`（不要覆盖之前的记录）：
```
- {yyyy-MM-dd HH:mm:ss} — **Commit** by {agent} — {commit hash short} {commit subject}
```

> **⚠️ 情况判断 — 你必须先核对任务状态，再从下面 4 种情况中精确匹配唯一分支：**
>
> - 检查 `task.md` 的 `current_step`、工作流进度和 `## Activity Log` 最新记录
> - 检查是否存在最新 `review.md` / `review-r{N}.md`，以及最新审查是否为“通过且无问题”
> - 检查是否仍有待处理的修复、审查或 PR 创建步骤
>
> | 判断依据 | 必须选择的情况 |
> |---------|---------------|
> | 所有工作流步骤完成 + 最新审查通过且无问题 + 所有测试通过 | 情况 1：最终提交 |
> | 仍有未完成步骤、待修复问题或等待他人动作 | 情况 2：还有后续工作 |
> | 当前提交的目的就是把实现/修复结果送入代码审查 | 情况 3：准备审查 |
> | 代码已提交且审查已完成，下一步应创建 PR | 情况 4：准备创建 PR |
>
> **禁止同时套用多个情况。必须先判断，再输出唯一匹配的下一步。**

### 情况 1：最终提交（触发条件：所有工作已完成，下一步是归档任务）

如果这是最后一次提交且所有工作已完成：

前置条件：
- [ ] 所有代码已提交
- [ ] 所有测试通过
- [ ] 代码审查通过
- [ ] 所有工作流步骤完成

建议下一步：

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
下一步 - 完成并归档任务：
  - Claude Code / OpenCode：/complete-task {task-id}
  - Gemini CLI：/{{project}}:complete-task {task-id}
  - Codex CLI：$complete-task {task-id}
```

### 情况 2：还有后续工作（触发条件：仍有未完成步骤、待修复项或待协作事项）

如果有后续工作（等待审查、需要更多修复）：
- 更新 `task.md`：设置 `updated_at` 为当前时间
- 在 task.md 中记录此次提交的内容和下一步

### 情况 3：准备审查（触发条件：下一步应执行 `review-task`）

如果提交已准备好进行代码审查：
- 更新 `task.md`：设置 `current_step` 为 `code-review`
- 更新 `task.md`：设置 `updated_at` 为当前时间
- 在工作流进度中标记 implementation 步骤为已完成

建议下一步：

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
下一步 - 代码审查：
  - Claude Code / OpenCode：/review-task {task-id}
  - Gemini CLI：/{{project}}:review-task {task-id}
  - Codex CLI：$review-task {task-id}
```

### 情况 4：准备创建 PR（触发条件：下一步应执行 `create-pr`）

如果提交应该创建 Pull Request：
- 更新 `task.md`：设置 `updated_at` 为当前时间
- 在 task.md 中记录 PR 计划

建议下一步：

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
下一步 - 创建 Pull Request：
  - Claude Code / OpenCode：/create-pr
  - Gemini CLI：/{{project}}:create-pr
  - Codex CLI：$create-pr
```

## 注意事项

- 不要提交包含敏感信息的文件（.env、凭据等）
- 确保提交信息清晰描述变更内容
- 遵循项目的 Conventional Commits 规范
- 如果任务状态更新失败，警告用户但不要阻止提交
