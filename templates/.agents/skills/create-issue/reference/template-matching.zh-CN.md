# Issue 模板匹配

在决定如何从 `.github/ISSUE_TEMPLATE` 构建 Issue 正文之前先读取本文件。

## 探测 Issue 模板

用下面的命令搜索项目模板：

```bash
rg --files .github/ISSUE_TEMPLATE -g '*.yml' -g '!config.yml'
```

如果模板存在，检查其顶层 `name:` 字段，并为当前任务标题和描述选择最匹配的模板。

常见候选模板：
- `bug_report.yml`：用于 bug 类工作
- `question.yml`：用于问题排查或调研类工作
- `feature_request.yml`：用于功能类工作
- `documentation.yml`：用于文档类工作
- `other.yml`：通用 fallback

如果没有明显匹配的模板，选择最接近的候选项。如果模板缺失、不可读取或解析失败，就回退到默认正文路径。

## 使用匹配到的模板构建正文

读取匹配模板中的：
- `name`
- `type:`
- `labels:`
- `body:`

字段处理规则：
- `textarea` 和 `input`：使用 `attributes.label` 作为 Markdown 标题，并从 task.md 填充值
- `markdown`：跳过模板解释性文字
- `dropdown` 和 `checkboxes`：跳过
- 当 task.md 没有合适值时，写入 `N/A`

建议字段映射：

| 模板字段提示 | task.md 来源 |
|---|---|
| `summary`, `title` | 任务标题 |
| `description`, `problem`, `what happened`, `issue-description`, `current-content` | 任务描述 |
| `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` | 需求列表 |
| 其他 `textarea` / `input` 字段 | 优先使用任务描述，否则写 `N/A` |
