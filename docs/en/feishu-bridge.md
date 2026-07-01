# Feishu Bridge

[← Documentation](./README.md) · [中文](../zh-CN/feishu-bridge.md)

The local `ai server` daemon can host IM adapters. The Feishu adapter connects to the Feishu Open Platform over the official SDK long connection and routes received messages to the command dispatcher. Built-ins such as `/ping`, `/help`, and `/version` run in the daemon; task and sandbox commands are routed through the local `ai` CLI.

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

Some Feishu consoles may also show or auto-enable broader parent permissions such as `im:message`. The adapter does not need chat metadata (`im:chat`) or message reaction permissions for command routing.

After changing permissions or event subscriptions, publish the app version and make sure the app is installed in the tenant before testing.

## Configure agent-infra

Put the app credentials in `.agents/server.local.json`. This file is git-ignored. Do not commit app secrets; committed `.agents/server.json` files that contain secrets are refused at startup.

```json
{
  "command": {
    "defaultTui": "codex",
    "skillTuiDefaults": {
      "code-task": "codex",
      "review-code": "claude"
    }
  },
  "auth": {
    "users": {
      "feishu:ou_xxx": { "role": "exec", "name": "maintainer" }
    }
  },
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

## Commands

| Command | Role | Execution |
|---------|------|-----------|
| `/ping`, `/help`, `/version` | public built-in | daemon |
| `/task ls`, `/task status <ref>`, `/task show <ref>`, `/task log <ref>`, `/task decisions <ref>` | `read` | `ai task ...` |
| `/sandbox ls`, `/sandbox show <ref>`, `/sandbox vm status` | `read` | `ai sandbox ...` |
| `/sandbox create <ref>`, `/sandbox start <ref>` | `write` | `ai sandbox ...` |
| `/run create-task <description> [--tui <name>]` | `write` | `ai run create-task ...` on the host |
| `/run <skill> <task-ref> [args...] [--tui <name>]` | `exec` | `ai run ...`; task skills run in the matching sandbox |
| `/decide <task-ref> <HD-id> <decision>` | `write` | `ai decide ...` |

`/task` commands are read-only views. Lifecycle progress goes through `/run`. Task skills resolve `<task-ref>` to the task branch, find the matching sandbox, and fail with an instruction to run `ai sandbox create <task-ref>` if no sandbox exists. `create-task` is the only v1 skill runner that does not require an existing task or sandbox. Sandbox removal is intentionally not exposed through IM because local deletion still requires interactive confirmation.

## TUI Selection

`ai run` chooses the non-interactive TUI in this order:

1. `--tui <name>` on the command
2. `command.skillTuiDefaults[skill]`
3. `command.defaultTui`
4. built-in default `codex`

Supported built-ins are `claude`, `codex`, `gemini`, and `opencode`. The generated prompts are `/skill ...` for Claude Code/OpenCode, `$skill ...` for Codex, and `/agent-infra:skill ...` for Gemini CLI.

## Authorization

Non-built-in commands are fail-closed. Add adapter-qualified users under `auth.users` and assign one of `read`, `write`, or `exec`; higher roles include lower roles. Unknown users cannot run `/task`, `/sandbox`, `/run`, or `/decide`. Built-ins remain available for connectivity checks.

## References

- [Feishu long connection event subscription](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=en-US)
- [Feishu `im.message.receive_v1` event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=en-US)
- [Feishu bot FAQ](https://open.feishu.cn/document/faq/bot)
