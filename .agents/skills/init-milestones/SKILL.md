---
name: init-milestones
description: >
  初始化仓库的 milestones 体系。
  当初始化仓库、需要创建标准 milestone 体系时使用。
---

# 初始化 milestones

一次性初始化仓库的标准 milestones 体系。

## 执行流程

### 1. 验证前置条件

确认以下条件成立：
- 执行前先读取 `.agents/rules/label-milestone-setup.md`
- 请求的 milestone 参数已准备完成

如果任一条件失败，停止并输出对应错误。

### 2. 运行 milestones runtime intent

执行以下命令，完成整套里程碑初始化流程：

```bash
agent-infra-internal platform-metadata init-milestones $ARGUMENTS
```

runtime intent 与 `.agents/rules/label-milestone-setup.md` 共同负责：
- 接收 `--history` 请求并规划目标里程碑
- 按既定基线、history、状态和标题幂等契约生成结果
- 由 runtime/provider 读取并写入当前里程碑
- 输出最终执行摘要

### 3. 标准里程碑定义

按固定描述创建以下里程碑：
- `General Backlog`：`All unsorted backlogged tasks may be completed in a future version.`（state=`open`）
- `{major}.{minor}.x`：`Issues that we want to resolve in {major}.{minor} line.`（state=`open`）
- 具体版本：兼容默认来源使用基线 `0.1.0`；合法 tag 来源使用 `{major}.{minor}.{patch+1}`。描述为 `Issues that we want to release in v{version}.`（state=`open`）

当传入 `--history` 时，每个历史 `vX.Y.Z` tag 还会额外贡献：
- `X.Y.x` 作为开启状态的线里程碑
- `X.Y.Z` 作为关闭状态的版本里程碑（`state=closed`）

### 4. 输出与行为保证

摘要必须包含：
- 版本基线
- 版本基线来源
- 是否启用 `--history`
- 创建与跳过的里程碑数量
- 新创建的里程碑标题
- 已存在的里程碑标题

执行说明：
- Milestone titles are treated as the idempotency key.
- General Backlog 是未分类工作的兜底里程碑。
- 不带 `--history` 时，只创建一个标准版本里程碑：兼容默认来源使用基线 `0.1.0`，合法 tag 来源使用下一次 patch 版本。
- 历史 `X.Y.Z` tag 会生成开启状态的 `X.Y.x` 和关闭状态的 `X.Y.Z`。
- 标签较多的仓库可能触发平台 API rate limit。

### 5. 告知用户

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

输出 milestones 初始化摘要后，提示：

使用 `agent-infra-internal agent-client next-steps --skill init-labels` 生成本场景的 `{next-step-commands}`。

```
下一步 - 初始化 Labels（可选）：
{next-step-commands}
```

## 错误处理

- 平台能力、认证或仓库访问失败：如实报告 runtime 的非零退出状态和诊断输出；不得声称远端已变更。
- 版本解析失败：报告 runtime 返回的版本基线错误
- `--history` 模式下未找到合法 SemVer `v*` git tags：报告 runtime 返回的 history 诊断
- 权限不足：提示 "No permission to manage milestones in this repository"
- API 限流：提示 "platform API rate limit reached, please retry later"
