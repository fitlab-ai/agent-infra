# agent-infra 文档

[← 返回 README](../../README.zh-CN.md) · [English](../en/README.md)

agent-infra 的深度文档。定位、安装和快速上手请见 [主 README](../../README.zh-CN.md)。

## 主题

- [架构概览](./architecture.md) — 引导 CLI、端到端流程、分层架构
- [平台支持](./platform-support.md) — macOS、Linux、Windows；沙箱引擎与资源配置
- [沙箱](./sandbox.md) — 沙箱 aliases、宿主-沙箱文件交换、用户级 dotfiles 通道
- [飞书桥接](./feishu-bridge.md) — 配置飞书长连接 adapter 并验证 `/ping`
- [内置 AI Skills](./skills.md) — 按使用场景分组的完整 skill 清单
- [自定义 Skills](./custom-skills.md) — 创建并同步项目专属 skill
- [自定义 TUI 配置](./custom-tui.md) — 适配非内置的 AI TUI
- [预置工作流](./workflows.md) — 分阶段交付链路与示例流程
- [配置参考](./configuration.md) — `.agents/.airc.json`、外部源、版本管理
- [文件管理策略](./file-management.md) — managed / merged / ejected 更新策略
