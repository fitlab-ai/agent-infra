# PR 审查报告模板

创建 `pr-review.md` 或 `pr-review-r{N}.md` 时使用以下结构。

```markdown
# PR 审查报告

- **审查轮次**：Round {round}
- **产物文件**：`pr-review.md` / `pr-review-r{N}.md`
- **可恢复**：true（任务锚定路径）/ false（一次性检视路径）

## 状态核对

> 粘贴状态核对命令原文；每条命令以 `$ ` 开头。

## 身份信息

- **PR 编号**：{pr-number}
- **Base 分支**：{base-ref}（SHA `{base-sha}`）
- **Head 分支**：{head-ref}
- **被审 head SHA**：{40 位 hex}
- **关联 Issue**：{issue-number 或 N/A}
- **关联任务**：{task-id 或 N/A}
- **关联任务目录**：{task-dir 或 N/A}

## 证据清单

- **宿主解析结果**：`unique` / `ambiguous` / `none`
- **证据场景**：S{1|2|3}
- **新鲜度**：`fresh` / `stale` / `n/a`
- **对齐**：`aligned` / `misaligned` / `n/a`
- **审查模式**：`verify` / `audit` / `reconstruct`
- **风险等级**：`LOW` / `MEDIUM` / `HIGH`
- **是否首次审查**：true / false
- **receipt**：{receipt}
- **决策输入与输出**：粘贴 `pr-review-grade decide` 的完整输入 JSON 与输出 DecisionRecord（decision 输入含宿主、artifact 存在性、head 状态、六个风险因素）。

### 重建上下文（reconstruct / audit 证据不足时）

在行级 finding 之前按以下顺序落盘，不冒充标准生命周期产物：

1. **需求边界**：PR 要实现什么、不做什么。
2. **架构选择**：关键技术路径与取舍。
3. **影响面**：改动波及的模块 / 规则 / 契约。
4. **验证覆盖**：应有哪些测试、现有测试能否覆盖。

## 覆盖矩阵

| 检视面 | 证据 | 结论 | 未覆盖/缺口 |
|--------|------|------|-------------|
| 需求边界 | {证据} | {结论} | {缺口} |
| 架构选择 | {证据} | {结论} | {缺口} |
| 影响面 | {证据} | {结论} | {缺口} |
| 验证覆盖 | {证据} | {结论} | {缺口} |

## 问题清单

### 阻塞项（必须修复）

- **{标题}**：{描述} · `{file}:{line}` · 证据：{evidence} · 影响：{impact} · 建议：{suggestion}

### 主要问题（建议修复）

- **{标题}**：{描述} · `{file}:{line}` · 证据：{evidence} · 影响：{impact} · 建议：{suggestion}

### 次要问题（低影响但需闭环）

- **{标题}**：{描述} · `{file}:{line}` · 证据：{evidence} · 影响：{impact} · 建议：{suggestion}

## 发布结果

- **正式 Review 状态**：{applied / no-op / blocked / failed}
- **Review ID**：{review-id 或 N/A}
- **Review URL**：{review-url 或 N/A}
- **Issue artifact 评论 URL**：{comment-url 或 N/A}

## 证据原文

> 每条「我验证了 X」断言都要配对对应 tool output 原文；gate 仅校验本段存在和至少一行 `$ `。

- 断言：{verified claim}
```text
$ {command}
{raw output}
```
