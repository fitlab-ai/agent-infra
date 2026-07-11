# 分支管理

在确保任务分支之前先读取本文件。

## 分支名规则

- 格式：`{{project}}-{type}-{slug}`
- 项目前缀：读取 `.agents/.airc.json` 中的 `project`
- `{type}`：读取 `task.md` frontmatter 中的 `type`
- `{slug}`：根据任务标题提取 3-6 个英文关键词，转为 kebab-case

## 分支检测流程

先读取：
- `task.md` 中 `## 上下文` 下的 `- **分支**：`
- 当前分支：`git branch --show-current`

有效已记录分支：
- 有值，且不是 `待定`、`待创建`、`N/A` 或空字符串

场景 A：`task.md` 已记录任务分支
- 当前分支与记录值一致：直接继续
- 当前分支不一致：按下方”创建与切换命令”章节切换到已记录分支

场景 B：`task.md` 未记录任务分支
- 判断当前分支是否符合项目分支命名规范（`{{project}}-{type}-{slug}`）且语义上属于当前任务
- 符合：将当前分支名回写到 `task.md`，继续
- 不符合：生成新的任务分支名，按下方”创建与切换命令”章节创建并切换，回写到 `task.md`

## 创建与切换命令

按以下顺序处理：

```bash
git branch --list {branch-name}
git ls-remote --heads origin {branch-name}
```

- 本地分支已存在：`git switch {branch-name}`
- 仅远程分支存在：`git switch --track origin/{branch-name}`
- 本地和远程都不存在：`git switch -c {branch-name}`

如果切换失败，立即停止并提示用户先处理工作区冲突或未解决的分支问题。

## task.md 回写要求

- 更新 `## 上下文` 中的 `- **分支**：{branch-name}`
- 不修改其他上下文字段
- 若本步骤已回写 `task.md`，后续更新任务状态时保留该分支值
