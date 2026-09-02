# Commit 阶段 Issue 元数据同步

## 触发条件

仅当以下条件同时满足时执行：
- `{task-id}` 有效
- `task.md` frontmatter 中存在有效 `issue_number`

任一条件不满足时，跳过本步骤。

调用单一声明式 intent；diff、仓库 label 过滤、权限降级、正文保真与幂等写入由 internal core 处理：

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --in-labels from-diff --base {base-branch} --requirements
```

`--base`（如保留）必须与 task.md 的 `delivery_base_ref` 完全一致；core 以 task-bound base 作为唯一 diff evidence，不回退到 `main` 或仓库默认分支。`in:` target 只来自 `labels.in` 映射与仓库实际 labels 的交集，并保留其他 labels。

## 错误处理

同步失败只记为警告，不阻塞已完成的 `git commit`。
