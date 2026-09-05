# 规则索引

`.agents/rules/` 收录本项目所有协作规则。各 SKILL 执行时按需加载其中若干篇；
本索引按业务域列出全部规则及其用途，便于快速定位「该读哪几篇」，无需逐文件翻阅。

> 维护提醒：新增或删除 `.agents/rules/*.md` 时，请同步更新本索引。

## 通用准则

- [`no-mid-flow-questions.md`](no-mid-flow-questions.md) — SKILL 执行期禁言：默认不向用户提问，及规则列明的例外。
- [`next-step-output.md`](next-step-output.md) — 「下一步」输出规则：任务短号渲染与 `Completed at` 收尾行。
- [`version-stamp.md`](version-stamp.md) — `agent_infra_version` 版本戳的取值命令与写入时机。
- [`debugging-guide.md`](debugging-guide.md) — 结构化调试流程：收集证据→形成假设→验证假设→修复根因，禁止盲目改代码重试。
- [`compatibility-policy.md`](compatibility-policy.md) — 兼容性默认关闭：准入证据、实现边界、退出条件与生命周期审查要求。
- [`evidence-reporting.md`](evidence-reporting.md) — 生命周期报告的状态核对、成功摘要、异常证据、身份字段和敏感信息边界。
- [`sync-content-generation.md`](sync-content-generation.md) — 同步到 Issue 的任务和生命周期 Markdown 生成约束。

## Issue / PR

- [`issue-pr-commands.md`](issue-pr-commands.md) — PR 命令集与 Issue intent 入口说明。
- [`pr-checks-commands.md`](pr-checks-commands.md) — 监控 PR 全部 checks、拉取失败日志的命令集（`watch-pr`）。
- [`create-issue.md`](create-issue.md) — `create-task` 落盘后的声明式 Issue 创建 intent。
- [`issue-sync.md`](issue-sync.md) — Issue 评论 marker 与声明式元数据 intent 契约。
- [`issue-fields.md`](issue-fields.md) — 动态 Issue Type pinned 字段映射边界。
- [`pr-sync.md`](pr-sync.md) — 面向 reviewer 的唯一 PR 摘要评论的同步规则。

## 任务工作流

- [`task-management.md`](task-management.md) — 任务语义识别与工作流命令映射。
- [`lifecycle-orchestration.md`](lifecycle-orchestration.md) — `run-task` 的 fresh executor/reviewer、一次性 receipt、暂停恢复与安全终点规则。
- [`review-handshake.md`](review-handshake.md) — 三阶段双向审查握手协议：四态处置、对称证据、分歧账本、收敛与 post-review commit 门禁。
- [`review-method.md`](review-method.md) — 三阶段共享检视方法：多遍检视、风险镜头、追踪与 finding 证据契约。
- [`local-artifact-repair.md`](local-artifact-repair.md) — analysis/plan/code completed 前的本地产物校验、review artifact 失败后的模型逐例修复、机械安全门与收敛契约。
- [`human-decision-context.md`](human-decision-context.md) — 新建人工裁决详情的自足上下文与规范结构。
- [`task-short-id.md`](task-short-id.md) — 裸数字任务短号的解析、分配与生命周期。
- [`milestone-inference.md`](milestone-inference.md) — create-task / code-task / create-pr 的 milestone 推断。
- [`label-milestone-setup.md`](label-milestone-setup.md) — 初始化 label / milestone 的共享入口。
- [`security-alerts.md`](security-alerts.md) — 导入 / 关闭依赖与代码扫描告警的共享入口。

## 提交与发布

- [`commit-and-pr.md`](commit-and-pr.md) — Conventional Commits 提交信息与 PR 规范。
- [`release-commands.md`](release-commands.md) — 读取历史 release、查询已合并 PR、发布 Release notes。

## 测试

- [`testing-discipline.md`](testing-discipline.md) — 测试编写纪律：结构性断言优先，禁止脆弱的措辞匹配。

## CLI

- [`cli-help-format.md`](cli-help-format.md) — CLI help 文案约定：展示名统一 `ai`、`Usage:`+`Commands:` 结构、命令按字母序（仅顶层与命名空间级 help）。
