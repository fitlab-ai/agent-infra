# Benchmark 契约与威胁模型

[← 返回文档](./README.md) · [English](../en/benchmark.md)

本文定义使用 agent-infra 评估软件工程 Agent 的公共契约：一次评估记录什么、哪些数据可以跨越各个信任边界，以及 MVP 能验证哪些安全声明。

英文文档是规范的人类可读主版本，[版本化 JSON Schema](../../lib/benchmark/schemas/v1.0.0/) 是机器可读结构契约，本文为同步中文翻译。

## 目标与范围

本契约支持：

- 一个 Subject 执行一个 Case；
- 同一 Subject 和 Case 的重复运行；
- 直接修复与 agent-infra 工作流的 A/B 对比；
- 在 Subject 不可见环境外执行确定性隐藏评分；
- 输出脱敏、可复现的公开结果。

本契约不实现 Dataset Provider、挑战工作区、Runner、Grader、报告器、网络控制或私有数据集，也不定义随机变异、多语言 Case、LLM Judge、Dashboard 或排行榜。

## 规范来源与术语

Initiative 级路线图与决策记录位于组织 [Benchmark RFC](https://github.com/orgs/fitlab-ai/discussions/1)，仓库 [Issue #742](https://github.com/fitlab-ai/agent-infra/issues/742) 跟踪本公共契约。

**必须**、**不得**、**应当**和**可以**等规范词表示契约要求。

| 术语 | 含义 |
|------|------|
| Subject | 被评模型、Agent Client、工作流模式、工具、权限、网络策略和预算的组合。 |
| Case | 由 Dataset Provider 管理的版本化评估输入。 |
| Agent-visible | 唯一允许进入 Subject 环境的 Case 投影。 |
| Grader-only | 只能留在可信侧的不透明引用和元数据，不得进入 Subject 环境或公开输出。 |
| Run | 一个 Subject 针对一个 Case 和 seed 的一次执行。 |
| Grader result | 可信隐藏评分的脱敏公开投影。 |
| 可信编排器 | 可以解析私有 Provider 和 Grader 引用的组件。 |
| 报告器 | 从 allowlist 构造公开输出的可信组件。 |

## 角色与信任边界

```text
Private Dataset Provider
  │ Case manifest + opaque graderRef
  ▼
Trusted Orchestrator ── agentVisible only ──► Disposable Subject Workspace
  │                                           │
  │ final patch or snapshot                   │ no private mounts or credentials
  ▼                                           ▼
Hidden Grader ── raw trusted result ──► Sanitizing Reporter
                                       │ allowlisted projection
                                       ▼
                            Grader result + Run manifest
```

相对于私有 Benchmark 数据和结果完整性，Subject 属于非可信角色。Provider、编排器、隐藏 Grader 和报告器对各自拥有的数据承担可信职责。

公开框架可以传递可信侧不透明引用，但不得要求私有答案、隐藏测试源码、Gold patch 或包含答案的 trace 出现在公共 manifest 或报告中。

## 契约版本

契约 v1.0.0 使用 JSON Schema Draft-07：

- [共享定义](../../lib/benchmark/schemas/v1.0.0/common.schema.json)
- [Subject](../../lib/benchmark/schemas/v1.0.0/subject.schema.json)
- [Case manifest](../../lib/benchmark/schemas/v1.0.0/case-manifest.schema.json)
- [Grader result](../../lib/benchmark/schemas/v1.0.0/grader-result.schema.json)
- [Run manifest](../../lib/benchmark/schemas/v1.0.0/run-manifest.schema.json)

每个顶层对象都携带 `contractVersion: "1.0.0"`。已发布的版本目录不可原地修改；不兼容变更必须创建新版本目录和契约版本。核心对象拒绝未知顶层字段，显式命名空间扩展只能放在 `extensions`。

以下身份彼此独立，不得互相替代：

| 身份 | 用途 |
|------|------|
| `frameworkVersion` | 执行 Run 的 agent-infra 版本。 |
| `contractVersion` | 本公共数据契约版本。 |
| `datasetVersion` + `datasetDigest` | 私有或公开数据集快照身份。 |
| `caseVersion` | 数据集中单个 Case 的版本。 |
| `sourceRevision` + `sourceDigest` | 构造挑战的输入代码基线。 |

`.airc.json.templateVersion` 只表示已安装模板包，不是 Benchmark 身份。

## Subject

[Subject Schema](../../lib/benchmark/schemas/v1.0.0/subject.schema.json) 记录完整被评条件。

| 字段 | 必填 | 语义 |
|------|------|------|
| `subjectId` | 是 | 被评条件的稳定身份。 |
| `model` | 是 | Provider、模型 ID 和可选不可变版本/快照。 |
| `agentClient` | 是 | Agent Client ID 与版本。 |
| `executionMode` | 是 | `direct-repair`、`agent-infra-workflow` 或 `custom`。 |
| `workflowRef` | 条件必填 | workflow 和 custom 模式必须提供。 |
| `tools` | 是 | 工具 ID、版本和声明能力。 |
| `permissions` | 是 | 文件系统、凭证与命令权限。 |
| `networkPolicy` | 是 | `none`、`allowlist` 或 `unrestricted`，以及可选执行证据。 |
| `budget` | 否 | 实验已定义的时间、token 或成本上限。 |

`unrestricted` 用于忠实记录不合格 Run。符合私有 Case MVP 要求的 Run 不得授予不受限网络。

A/B 两个 Subject 可以有意改变 `executionMode` 和 `workflowRef`。除非报告明确声明另一种实验，模型、Agent Client、工具版本、权限、网络策略和预算必须保持等价。

## Case manifest

[Case Manifest Schema](../../lib/benchmark/schemas/v1.0.0/case-manifest.schema.json) 是可信侧对象，并明确区分：

- `agentVisible`：任务文本、允许的挑战制品和非敏感构造参数；
- `graderOnly`：不透明 `graderRef` 和输入摘要。

只有 `agentVisible` 可以复制到一次性 Subject 工作区。`graderOnly` 不得出现在 Subject 文件、挂载、环境变量、prompt、工具状态、异常、dry-run 输出或公开日志中。

Manifest 记录独立 Dataset/Case 身份、来源 revision/digest、seed、验题状态和可选挑战摘要。它刻意不提供答案正文、隐藏测试源码、Gold patch、私有仓库地址或原始验题 trace 字段。

## Grader result

[Grader Result Schema](../../lib/benchmark/schemas/v1.0.0/grader-result.schema.json) 是隐藏评分的脱敏公开投影，不是原始 Grader 进程结果。

`status` 有三个互斥终态：

| 状态 | 含义 | 必需类别 |
|------|------|----------|
| `passed` | 所有必需隐藏测试、回归测试和构建检查通过。 | 无 |
| `failed` | 已完成评分，但提交物未满足某个必需检查。 | `failureCategory` |
| `blocked` | 基础设施无法给出评分结论。 | `blockCategory` |

`blocked` 不得计为 Subject 失败，报告必须单独公布。

每个 `checks` 条目只包含 ID、公开状态、稳定类别、脱敏摘要和可选耗时。隐藏断言、源码、预期 patch、私有路径和原始 stdout/stderr 留在可信侧。

`sanitization` 记录 allowlist 版本，并且必须声明 `sanitized: true`。

## Run manifest 与比较规则

[Run Manifest Schema](../../lib/benchmark/schemas/v1.0.0/run-manifest.schema.json) 记录一次执行：

- framework、contract、dataset、Case 和 Subject 身份；
- seed 和重复位置；
- `comparisonGroupId`；
- `conditionsDigest`；
- 开始和结束时间；
- `resultRef` 或内嵌脱敏 `graderResult`；
- 可选耗时、轮数、token 和成本。

`repetitionIndex` 从 1 开始且不得超过 `repetitionCount`。MVP 对每个 Subject/Case 使用 `repetitionCount: 3`。Draft-07 无法直接比较两个数值属性，因此跨字段大小关系由 Runner 验证。

报告器先保留每条 Run，再计算聚合。成功率只使用已评分 Run：

```text
success rate = passed / (passed + failed)
```

`blocked` 单独报告；缺失效率指标保持缺失，不推断为零。

A/B 配对要求：

- `comparisonGroupId`、Dataset/Case 身份、seed 和重复位置一致；
- `conditionsDigest` 覆盖受控的模型、Agent Client、工具、权限、网络策略和预算；
- 只有声明的 Subject 维度可以不同；
- 不匹配的 Run 不可比较，但仍需保留原始记录。

## 数据暴露策略

| 公开或 Subject 可见 | 仅可信侧可见 |
|----------------------|--------------|
| 契约和字段语义 | 私有 Case 定义 |
| 公开示例 Case | 隐藏测试与断言 |
| Agent-visible 任务输入 | Gold patch 和 mutation 元数据 |
| Dataset/Case ID、版本和摘要 | 答案历史和 trace |
| 脱敏检查摘要与类别 | 原始 Grader stdout/stderr |
| 声明的运行条件 | 私有仓库位置与凭证 |

结构隔离和输出 allowlist 是主要控制。基于模式的秘密脱敏只能作为纵深防御，不能证明任意私有文本都不会泄漏。

## MVP 保证、前提与不保证

### 自动可验证保证

- Subject 工作区清单不包含 Grader-only 资产。
- 挑战仓库具有新的根历史且没有 remote。
- Subject 挂载和环境变量不含数据集凭证、GitHub token 或 Grader 路径。
- 相同 Case version 和 seed 产生相同挑战摘要。
- 隐藏 Grader 在 Subject 执行结束后启动，且其输入从未挂载给 Subject。
- 公开结果从显式 allowlist 构造。
- 中断和重复 Run 执行清理与残留数据检查。

只有下游实现提供对应证据后，这些条目才能成为已满足声明。

### 部署或人工前提

- 操作者配置声明的网络策略并验证其执行证据。
- Provider、编排器、Grader 和报告器存储留在可信侧。
- 模型 Provider 和 Agent Client 的保留策略适合对应数据集。
- 实验开始前记录资源预算和 A/B 重复策略。

### 明确不保证

MVP 不承诺防御：

- 恶意内核或容器运行时逃逸；
- 已入侵宿主机或宿主权限操作者；
- 硬件侧信道；
- Runner 无法控制的外部模型 Provider 数据保留；
- 依靠正则实现任意秘密检测；
- 在目标平台实现并验证 egress 控制前，声称统一完全断网。

## 脱敏示例

以下 Subject 与 A/B 对端只在执行模式和工作流引用上不同：

```json
{
  "contractVersion": "1.0.0",
  "subjectId": "example-workflow",
  "model": { "provider": "example", "modelId": "model-x", "version": "snapshot-1" },
  "agentClient": { "clientId": "codex", "version": "example-version" },
  "executionMode": "agent-infra-workflow",
  "workflowRef": "feature-development",
  "tools": [{ "toolId": "git", "version": "example-version" }],
  "permissions": {
    "filesystem": "challenge-workspace-write",
    "credentials": "none",
    "commands": ["git", "npm"]
  },
  "networkPolicy": { "mode": "none", "enforcementEvidence": "example-evidence-id" },
  "budget": { "timeLimitMs": 1800000, "tokenLimit": 100000 }
}
```

针对一个 Case，六条 Run manifest 构成 MVP A/B 样本：

| Subject | 重复 | 共享比较身份 |
|---------|------|--------------|
| `example-direct` | 3 次中的 1、2、3 | 相同 group、Case、seed 和受控条件摘要 |
| `example-workflow` | 3 次中的 1、2、3 | 相同 group、Case、seed 和受控条件摘要 |

以上所有标识和值均为虚构内容，不包含私有数据集材料。

## 下游职责

| Issue | 职责 |
|-------|------|
| #743 | 加载并校验 Case manifest，且不记录 Grader-only 值。 |
| #744 | 生成一次性、无答案的挑战工作区和可复现摘要。 |
| #745 | 执行可信隐藏评分并输出脱敏 Grader result。 |
| #746 | 记录 Run manifest、验证比较兼容性并发布脱敏聚合。 |
| #747 | 测试实现所声明的每项隔离保证。 |
| #748 | 在等价条件下运行三题、三次重复的 A/B MVP。 |

消费者遇到不支持的契约版本、身份字段缺失、状态/类别组合无效或 Grader-only 暴露时，必须闭合失败。
