# 飞书桥接

[← 文档](./README.md) · [English](../en/feishu-bridge.md)

本地 `ai server` 守护进程可托管 IM adapter。飞书 adapter 通过官方 SDK 长连接接入飞书开放平台，并把收到的消息路由到命令分发器。`/ping`、`/help`、`/version` 等内置命令在 daemon 内执行；任务与沙箱命令通过本机 `ai` CLI 执行。

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

部分飞书控制台可能会展示或自动开通更宽的父级权限，例如 `im:message`。命令路由不需要群信息权限 `im:chat`，也不需要消息表情回复权限。

修改权限或事件订阅后，需要发布应用版本，并确认应用已安装到当前企业，之后再测试。

## 配置 agent-infra

把应用凭证写入 `.agents/server.local.json`。该文件已被 git 忽略。不要提交密钥；如果已提交的 `.agents/server.json` 中包含密钥，启动时会被拒绝。

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

`appId` 必须符合 `cli_[0-9a-fA-F]{16}`。如果缺少 `appId` 或 `appSecret`，daemon 会 fail fast。

`auth.users` 是 IM 授权白名单。每个 key 的格式是 `<adapter>:<user-id>`。飞书场景使用 `feishu` adapter 前缀，用户 ID 来自 `im.message.receive_v1` 事件的发送者身份：adapter 优先使用 `open_id`，没有时依次回退到 `union_id`、`user_id`。例如 `feishu:ou_xxx` 表示给这个飞书发送者授予配置中的角色；`name` 只是便于人工识别的标签。

## 命令

| 命令 | 角色 | 执行路径 |
|------|------|----------|
| `/decide <task-ref> <HD-id> <裁定>` | `exec` | `ai decide ...` |
| `/help`、`/ping`、`/version` | 公开内置 | daemon |
| `/run create-task <描述> [--tui <name>]` | `exec` | 在宿主环境执行 `ai run create-task ...` |
| `/run <skill> <task-ref> [args...] [--tui <name>]` | `exec` | `ai run ...`；任务态 skill 在匹配沙箱中执行 |
| `/sandbox create <ref>`、`/sandbox start <ref>` | `write` | `ai sandbox ...` |
| `/sandbox ls`、`/sandbox show <ref>`、`/sandbox vm status` | `read` | `ai sandbox ...` |
| `/task decisions <ref>`、`/task log <ref>`、`/task ls`、`/task show <ref>`、`/task status <ref>` | `read` | `ai task ...` |

`/task` 命令只提供只读视图。任务推进统一走 `/run`。任务态 skill 会把 `<task-ref>` 解析到任务分支，再查找对应 sandbox；如果 sandbox 不存在，会提示先运行 `ai sandbox create <task-ref>`。`create-task` 是 v1 中唯一不要求已有任务和 sandbox 的 skill runner。沙箱删除仍需要本地交互确认，因此不通过 IM 暴露。

bridge 有意只暴露上表中的 v1 白名单，而不是每一个本地 `ai task` 或 `ai sandbox` 子命令。`/run <skill>` 接受 `ai run` 内置生命周期 skill 白名单；部署时可用 `command.allowedSkills` 进一步收窄。表中所有命令都有本地等价路径，因此可以先用 `ai decide ...`、`ai run ...`、`ai sandbox ...`、`ai task ...` 在本地验证；任务态 `ai run` 命令需要已有匹配 sandbox，并且已安装所选 TUI。本地验证通过后，再通过飞书验证同一组命令白名单。`/sandbox rm`、`/sandbox exec` 这类破坏性或任意执行命令有意不在 IM 中实现。

## TUI 选择

`ai run` 按以下顺序选择非交互 TUI：

1. 命令中的 `--tui <name>`
2. `command.skillTuiDefaults[skill]`
3. `command.defaultTui`
4. 内置默认 `codex`

内置支持 `claude`、`codex`、`gemini`、`opencode`。生成的 prompt 分别为 Claude Code/OpenCode 的 `/skill ...`、Codex 的 `$skill ...`、Gemini CLI 的 `/agent-infra:skill ...`。

## 授权

非内置命令默认 fail-closed。把 adapter-qualified 用户写入 `auth.users`，角色为 `read`、`write` 或 `exec`；高角色包含低角色权限。未知用户不能执行 `/decide`、`/run`、`/sandbox` 或 `/task`。内置命令保留给连通性检查。

## 参考

- [飞书长连接事件订阅](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [飞书 `im.message.receive_v1` 事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [飞书机器人常见问题](https://open.feishu.cn/document/faq/bot)
