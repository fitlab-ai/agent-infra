# 预置工作流

[← 返回 README](../../README.zh-CN.md) · [English](../en/workflows.md)

agent-infra 内置 **4 个预置工作流**。其中 3 个共享同一条分阶段交付链路：

`analysis -> analysis-review -> design -> design-review -> code（本地 checkpoint）-> code-review -> delivery -> complete`

第 4 个 `code-review` 则更轻量，专门用于审查已有 PR 或分支。

| Workflow | 适用场景 | 步骤链 |
|----------|----------|--------|
| `feature-development` | 开发新功能或新能力 | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> delivery -> complete` |
| `bug-fix` | 诊断并修复缺陷，同时补回归验证 | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> delivery -> complete` |
| `refactoring` | 进行应保持行为稳定的结构性重构 | `analysis -> analysis-review -> design -> design-review -> code -> code-review -> delivery -> complete` |
| `code-review` | 审查已有 Pull Request 或分支 | `analysis -> review -> report` |

## 生命周期示例

最简单的端到端交付回路如下：

```text
import-issue #42                    从 GitHub Issue 导入任务
(或: create-task "添加暗色模式")      或直接从描述创建任务；平台规则支持时会级联创建 Issue
         |
         |  --> 得到任务 ID，例如 T1
         v
  analyze-task T1                   需求分析
         |
         v
  review-analysis T1                审查需求分析
         |
     有问题?
      +--YES----> analyze-task T1
      |
         v
    plan-task T1                    设计方案
         |
         v
  review-plan T1                    审查技术方案
         |
     有问题?
      +--YES----> plan-task T1
      |
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

`code-task` 创建供 `review-code` 检视的本地 checkpoint。任务准备阶段会持久化交付 remote 与目标分支；`create-pr` 复用该绑定、验证已审查的 HEAD，且是任务路径中唯一推送分支的操作。
