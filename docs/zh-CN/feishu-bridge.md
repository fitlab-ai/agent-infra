# 飞书桥接

[← 文档](./README.md) · [English](../en/feishu-bridge.md)

本地 `ai server` 守护进程可托管 IM adapter。飞书 adapter 通过官方 SDK 长连接接入飞书开放平台，并把收到的消息路由到内置命令分发器。当前最小命令是 `/ping`，回复 `pong v<VERSION>`。

## 创建应用

1. 在[飞书开放平台](https://open.feishu.cn/app)创建自建应用。
2. 启用机器人能力，并把机器人加入测试会话。
3. 在事件与回调中选择长连接模式，并订阅 `im.message.receive_v1`。

## 权限

按要验证的会话类型使用最小权限：

| 场景 | 必需权限 |
|------|----------|
| 单聊 `/ping` | `im.message.p2p_msg:readonly`、`im:message:send_as_bot` |
| 群聊 `@机器人 /ping` | `im.message.group_at_msg:readonly`、`im:message:send_as_bot` |
| 同时支持单聊和群聊 | `im.message.p2p_msg:readonly`、`im.message.group_at_msg:readonly`、`im:message:send_as_bot` |

部分飞书控制台可能会展示或自动开通更宽的父级权限，例如 `im:message`。当前 `/ping` adapter 不需要群信息权限 `im:chat`，也不需要消息表情回复权限。

修改权限或事件订阅后，需要发布应用版本，并确认应用已安装到当前企业，之后再测试。

## 配置 agent-infra

把应用凭证写入 `.agents/server.local.json`。该文件已被 git 忽略。不要提交密钥；如果已提交的 `.agents/server.json` 中包含密钥，启动时会被拒绝。

```json
{
  "adapters": {
    "feishu": {
      "enabled": true,
      "appId": "<your-app-id>",
      "appSecret": "<your-app-secret>"
    }
  }
}
```

`appId` 必须符合 `cli_[0-9a-fA-F]{16}`。如果缺少 `appId` 或 `appSecret`，daemon 会 fail fast。

## 参考

- [飞书长连接事件订阅](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [飞书 `im.message.receive_v1` 事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [飞书机器人常见问题](https://open.feishu.cn/document/faq/bot)
