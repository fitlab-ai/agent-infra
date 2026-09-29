# 输出指引

向用户呈现最终结果前先读取本文件与 `.agents/rules/next-step-output.md`。`review-pr` 有且仅有三个出口，按本次运行结果选一个，不要输出多个。

## 出口选择

| 出口 | 触发条件 | 呈现内容 |
|------|----------|----------|
| A 本地审查完成 | 本地审查轮次闭合且校验通过；正式 Review 已发布或有持久化待恢复记录 | 结论、模式、被审 head SHA、实际发布状态、Review URL 或恢复动作、receipt、下一步 |
| B 阻塞要求关联 | `resolve-host` 返回 none 或 ambiguous | 关联指引（创建/关联 Issue 与 task），不自动创建 Issue；或显式选择一次性检视 |
| C 一次性检视 | 用户显式选择「仅一次性检视」 | 不可恢复提示、产物目录 `.agents/workspace/reviews/{pr-number}/`、Review URL 或发布失败 |

## 呈现要求

- 本地审查完成（出口 A）时报告：审查模式（verify/audit/reconstruct）、证据场景（S1/S2/S3）、被审 head SHA、finding 总数、正式 Review 发布状态、Review URL 或待恢复操作、receipt。待恢复时不得声称 Review 已发布。
- 阻塞（出口 B）时给出建立关联的具体命令或步骤；如果 `resolve-host` 返回 ambiguous，列出候选任务并要求人工指定。
- 一次性检视（出口 C）明确 `recoverable: false`，不承诺可恢复。
- 渲染下一步前读取 `.agents/rules/next-step-output.md`，并按其中的「下一步」命令约定生成。
