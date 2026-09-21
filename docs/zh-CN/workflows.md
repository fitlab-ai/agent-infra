# 预置工作流

[← 返回 README](../../README.zh-CN.md) · [English](../en/workflows.md)

agent-infra 内置 **4 个预置工作流**。功能开发、缺陷修复和重构都从分析开始，由分析根据可观察的任务事实记录一条规范路径：

| 路径 | 阶段链 | 选择规则 |
|------|--------|----------|
| 精简路径 | `analysis -> code（本地 checkpoint）-> code-review` | 范围和验收明确，不需要独立设计或文档审计决策 |
| 标准路径 | `analysis -> design -> code（本地 checkpoint）-> code-review` | 实现需要明确跨模块契约、数据流或测试策略 |
| 完整路径 | `analysis -> analysis-review -> design -> design-review -> code（本地 checkpoint）-> code-review` | 存在具体的验收争议、高代价接口/schema/迁移决策，或真实外部/安全边界，需要独立审查 |

三条路径都保留独立代码审查。文件数量、模块数量或可能存在的风险不能单独触发完整路径。后续 finding 可以根据证据把工作返回分析、设计、实现、人工裁决或证据不足暂停。第 4 个 `code-review` 工作流仍专门用于审查已有 PR 或分支。

| Workflow | 适用场景 | 步骤链 |
|----------|----------|--------|
| `feature-development` | 开发新功能或新能力 | 分析选择精简、标准或完整路径，之后执行交付与完成步骤 |
| `bug-fix` | 诊断并修复缺陷，同时补回归验证 | 分析选择精简、标准或完整路径，之后执行交付与完成步骤 |
| `refactoring` | 进行应保持行为稳定的结构性重构 | 分析选择精简、标准或完整路径，之后执行交付与完成步骤 |
| `code-review` | 审查已有 Pull Request 或分支 | `analysis -> review -> report` |

## 生命周期示例

下面的示例采用**标准路径**。精简任务会跳过设计；完整路径则会在相应检查点增加需求分析审查和方案审查。

```text
import-issue #42                    从 GitHub Issue 导入任务
(或: create-task "添加暗色模式")      或直接从描述创建任务；平台规则支持时会级联创建 Issue
         |
         |  --> 得到任务 ID，例如 T1
         v
  analyze-task T1                   需求分析
         |
         v
  plan-task T1                      设计方案
         |
         v
  code-task T1                      编写代码、测试，并创建本地 checkpoint
         |
         v
  +-> review-code T1                自动代码审查
  |      |
  |   有问题?
  |      +--NO-------+
  |     YES          |
  |      |           |
  |      v           |
  |  code-task T1 (fix mode)
  |      |           |
  +------+           |
                     |
         +-----------+
         |
         v
   create-pr T1                     将已通过审查的 checkpoint 发布到任务绑定目标分支
         |
         v
  complete-task T1                  合并并通过最终门禁后归档
```

每条路径中的 `code-task` 都会创建供 `review-code` 检视的本地 checkpoint。任务准备阶段会持久化交付 remote 与目标分支；`create-pr` 复用该绑定、验证已审查的 HEAD，且是任务路径中唯一推送分支的操作。
