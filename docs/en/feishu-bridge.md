# Feishu Bridge

[← Documentation](./README.md) · [中文](../zh-CN/feishu-bridge.md)

The local `ai server` daemon can host IM adapters. The Feishu adapter connects to the Feishu Open Platform over the official SDK long connection and routes received messages to the built-in command dispatcher. The current minimal command is `/ping`, which replies `pong v<VERSION>`.

## Create the App

1. In the [Feishu Open Platform](https://open.feishu.cn/app), create a self-built app.
2. Enable the Bot capability and add the bot to the test chat.
3. Under Events & callbacks, choose long connection mode and subscribe to `im.message.receive_v1`.

## Permissions

Use the narrowest set that matches the chat types you want to test:

| Scenario | Required permissions |
|----------|----------------------|
| Direct chat `/ping` | `im.message.p2p_msg:readonly`, `im:message:send_as_bot` |
| Group chat `@bot /ping` | `im.message.group_at_msg:readonly`, `im:message:send_as_bot` |
| Both direct and group chat | `im.message.p2p_msg:readonly`, `im.message.group_at_msg:readonly`, `im:message:send_as_bot` |

Some Feishu consoles may also show or auto-enable broader parent permissions such as `im:message`. The current adapter does not need chat metadata (`im:chat`) or message reaction permissions for `/ping`.

After changing permissions or event subscriptions, publish the app version and make sure the app is installed in the tenant before testing.

## Configure agent-infra

Put the app credentials in `.agents/server.local.json`. This file is git-ignored. Do not commit app secrets; committed `.agents/server.json` files that contain secrets are refused at startup.

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

`appId` must match `cli_[0-9a-fA-F]{16}`. The daemon fails fast if `appId` or `appSecret` is missing.

## References

- [Feishu long connection event subscription](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=en-US)
- [Feishu `im.message.receive_v1` event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=en-US)
- [Feishu bot FAQ](https://open.feishu.cn/document/faq/bot)
