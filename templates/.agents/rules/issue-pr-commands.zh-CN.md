# Issue 和 PR 命令

当前代码平台未提供 Issue 或 Pull Request 适配器；internal intents 返回结构化 no-op/degraded 结果。

自定义平台会跳过平台专属自动化，除非你提供匹配的 `.{platform}.zh-CN.md` 规则模板。请以本地任务产物作为事实来源，或先安装平台专属模板包再运行工作流。
