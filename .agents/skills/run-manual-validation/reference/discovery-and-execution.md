# 自动发现与逐项执行

在解析输入、发现人工校验项或构造验证动作前读取本文件。

## 输入模式

| 输入 | 处理 |
|------|------|
| literal `--` 前后分别有非空验证目标和命令 | 显式模式；命令为该目标的权威动作 |
| 存在 literal `--`，但目标或命令为空 | 非法输入；在 `validation-run.started` 前停止 |
| 不存在 `--`，且只有 task ref | 自动模式 |
| 不存在 `--`，但还有位置参数 | 非法/半截输入；不得忽略参数或猜测命令 |

显式模式也要读取可用来源以映射覆盖范围，但不得为同一目标另行合成命令。自动模式才为发现项构造动作。

## 工作门禁矩阵

| mode | source state | gate |
|------|--------------|------|
| `explicit` | `any` | `continue` |
| `automatic` | `items` | `continue` |
| `automatic` | `empty` | `stop` |
| `automatic` | `unreadable-only` | `stop` |

合法显式模式的用户命令本身就是有效工作；来源为空或不可读只影响覆盖映射和报告，不得触发早退。自动模式必须依赖可靠发现结果。

## 发现来源

1. 从 `task-artifact` 返回的最新 `review-code` 读取人工校验项，作为 canonical 本地来源。只读取该轮结构化的人工校验清单，不扫描 task.md 自由文本、旧审查轮次、活动日志或评论历史。
2. 运行 `agent-infra-internal platform-pr inspect {task-id}`，从成功返回的绑定 PR 正文读取待人工验证清单，作为补充来源。
3. 按目标、所需环境和预期断言语义去重。相同项合并来源并优先采用 review-code 细节；PR 独有项追加；关键要求冲突的项标为 `unresolved`。
4. 为本轮清单分配局部 ID `MV-1..N`，记录来源、目标、预期断言、所需能力和候选步骤；不得写入 task ledger。

## PR 来源状态

| PR inspect 结果 | 本地有项目 | 本地无项目 |
|-----------------|------------|------------|
| 成功 | 合并清单；PR 空清单时仅用本地项 | 使用 PR 清单；两边均为空时 started 前正常停止 |
| `no-op` + `PR_NOT_LINKED` | 仅使用本地项 | started 前正常停止 |
| `failed` 或 `blocked` | 继续本地项；在报告记录 typed 状态、稳定错误码和来源覆盖缺口 | started 前 fail closed，提示恢复平台访问后重试 |

显式模式在 PR 检查失败时仍可执行权威命令，但必须记录无法核对 PR 清单。不要把读取失败当作空清单，也不要记录原始远端响应。

## 分类与安全动作

逐项选择一种分类：

- `executable`：宿主能力已有充分证据；动作最小、非交互且作用域受限。
- `unavailable`：明确缺少所需平台、文件系统语义、权限、容器或账号。
- `unknown`：仅有弱信号，安全探测也无法证明能力。
- `unsafe`：只能通过破坏性、泄密或无法去敏的动作验证。
- `unresolved`：来源对环境或预期断言存在关键冲突。

只有 `executable` 可以运行。命令不得输出凭据、环境变量、完整 argv、绝对用户路径或原始 transcript；不能证明安全就保留覆盖缺口。

## 逐项执行

1. 每个可执行项分别调用：

   ```bash
   agent-infra-internal task-validate {task-ref} --scope snapshot --format json -- {command...}
   ```

2. 仅当项目要求或首次证据证明依赖未提交内容、原挂载或原位权限时，再为该项显式调用一次 `--scope inplace`，并记录升级理由。
3. 单项失败不阻止其余独立项；分别记录退出状态、cleanup 和去敏 JSON allowlist。
4. 清单非空但没有 `executable` 项时，仍在 started 后生成 validation-run 产物并完成 lifecycle，不运行占位或伪造命令。
5. 输入非法时始终在 started 前停止。自动模式下，两来源可靠地确认无项，或唯一可能来源不可读且本地无项时，也在 started 前停止且不写产物；合法显式模式不适用这两个来源停止条件。
