# Label、Issue Type 和 Milestone 规则

在应用 label、Issue Type、milestone 或 `in:` label 之前先读取本文件。

## 默认正文格式（Fallback）

推荐 fallback：

```markdown
## Description

{task-description}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

将任务类型映射到 GitHub label 和 Issue Type，但只保留仓库里实际存在的 label。

Fallback label 映射：

| task.md type | GitHub label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `docs`, `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task`, `chore` | `type: task` |
| `refactor`, `refactoring` | `type: enhancement` |
| 其他值 | 跳过 |

Issue Type fallback 映射：

| task.md type | GitHub Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring` 以及其他所有值 | `Task` |

## 创建 Issue

创建 Issue 时，执行前先读取 `.agents/rules/issue-pr-commands.md`，并使用其中的 “创建 Issue” 命令模板。

如果最终没有有效 label，就省略 label 参数。

Milestone 推断规则见 `.agents/rules/milestone-inference.md` 的「阶段 1：`create-issue`」。推断前先读取该文件。

Issue Type 设置同样遵循 `.agents/rules/issue-pr-commands.md` 中的对应命令。

`in:` label（粗选）：

执行前先按 `.agents/rules/issue-pr-commands.md` 的 Issue 更新命令准备 label 编辑参数。

从查询结果中，根据 task.md 的标题和描述进行语义匹配：
- 任务描述**明确提及**某个模块（如"修复 CLI 参数解析"→ `in: cli`）→ 添加
- 任务描述**强烈暗示**某个模块 → 添加
- 无法确定或模糊 → **不添加**

原则：宁缺毋滥。粗选阶段不求精确，后续 implement-task / create-pr 阶段会基于实际改动文件精修。

只添加相关的 `in:` label。当 `in:` label 不可用或不相关时，不要让创建 Issue 流程失败。

当 label、Issue Type 或 milestone 不可用时，应跳过并继续，不要让 Issue 创建失败。
