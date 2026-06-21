# 规则索引

`.agents/rules/` 收录本项目所有协作规则。各 SKILL 执行时按需加载其中若干篇；
本索引按业务域列出全部规则及其用途，便于快速定位「该读哪几篇」，无需逐文件翻阅。

> 维护提醒：新增或删除 `.agents/rules/*.md` 时，请同步更新本索引。

## 通用准则

- [`no-mid-flow-questions.md`](no-mid-flow-questions.md) — SKILL 执行期禁言：默认不向用户提问，及规则列明的例外。
- [`next-step-output.md`](next-step-output.md) — 「下一步」输出规则：任务短号渲染与 `Completed at` 收尾行。
- [`version-stamp.md`](version-stamp.md) — `agent_infra_version` 版本戳的取值命令与写入时机。
- [`debugging-guide.md`](debugging-guide.md) — 结构化调试流程：收集证据→形成假设→验证假设→修复根因，禁止盲目改代码重试。

## Issue / PR

- [`issue-pr-commands.md`](issue-pr-commands.md) — 验证平台认证、读写 Issue / PR 的 GitHub 命令集。
- [`pr-checks-commands.md`](pr-checks-commands.md) — 监控 PR required checks、拉取失败日志的命令集（`watch-pr`）。
- [`create-issue.md`](create-issue.md) — `create-task` 落盘后级联创建 Issue 的规则。
- [`issue-sync.md`](issue-sync.md) — task 产物与 Issue 评论 / 标签 / 字段的同步标记与流程。
- [`issue-fields.md`](issue-fields.md) — Issue Type pinned 字段（Priority/Effort/日期）的读写流程。
- [`pr-sync.md`](pr-sync.md) — 面向 reviewer 的唯一 PR 摘要评论的同步规则。

## 任务工作流

- [`task-management.md`](task-management.md) — 任务语义识别与工作流命令映射。
- [`review-handshake.md`](review-handshake.md) — 三阶段双向审查握手协议：四态处置、对称证据、分歧账本、收敛与 post-review commit 门禁。
- [`task-short-id.md`](task-short-id.md) — 任务短号 `#NN` / 裸数字的解析、分配与生命周期。
- [`milestone-inference.md`](milestone-inference.md) — create-task / code-task / create-pr 的 milestone 推断。
- [`label-milestone-setup.md`](label-milestone-setup.md) — 初始化 label / milestone 的平台命令集。
- [`security-alerts.md`](security-alerts.md) — 导入 / 关闭 Dependabot 与 Code Scanning 告警的命令集。

## 提交与发布

- [`commit-and-pr.md`](commit-and-pr.md) — Conventional Commits 提交信息与 PR 规范。
- [`release-commands.md`](release-commands.md) — 读取历史 release、查询已合并 PR、发布 Release notes。

## 测试

- [`testing-discipline.md`](testing-discipline.md) — 测试编写纪律：结构性断言优先，禁止脆弱的措辞匹配。

## CLI

- [`cli-help-format.md`](cli-help-format.md) — CLI help 文案约定：展示名统一 `ai`、`Usage:`+`Commands:` 结构、命令按字母序（仅顶层与命名空间级 help）。
