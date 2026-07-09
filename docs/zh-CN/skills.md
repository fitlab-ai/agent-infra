# 内置 AI Skills

[← 返回 README](../../README.zh-CN.md) · [English](../en/skills.md)

agent-infra 提供 **丰富的内置 AI skills**。它们按使用场景分组，但共享同一个核心目标：无论使用哪种 AI TUI，都能在同一仓库里执行相同的工作流词汇和协作约定。

## 每个 skill 背后做了什么

这些不是简单的命令别名。每个 skill 都封装了手动操作时容易遗漏或不一致的标准化流程：

- **结构化产物** — 每个步骤都输出模板化的文档（`analysis.md`、`review-analysis.md`、`plan.md`、`review-plan.md`、`code.md`、`review-code.md`），格式统一，而非自由发挥的散文
- **多轮版本化** — 需求变了？再执行一次 `analyze-task` 会生成 `analysis-r2.md`，完整修订历史自动保留
- **分级审查机制** — `review-code` 按 Blocker / Major / Minor 分类问题，附带文件路径和修复建议，而非含糊的"看着没问题"
- **跨工具状态延续** — `task.md` 记录了谁在什么时间做了什么；Claude 分析、Codex 实现、Gemini 审查——上下文无缝衔接
- **审计轨迹与联合署名** — 每个步骤自动追加 Activity Log；最终提交包含所有参与 AI 的 `Co-Authored-By` 署名

## 任务生命周期

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `create-task` | 根据自然语言请求创建任务骨架，并在平台规则可用时级联创建 Issue。 | `description` | 从零开始记录新功能、缺陷或改进需求。 |
| `import-issue` | 将 GitHub Issue 导入本地任务工作区。 | `issue-number` | 把已有 Issue 转成可执行的任务目录。 |
| `analyze-task` | 为已有任务输出需求分析产物。 | `task-id` | 在设计前明确范围、风险和受影响文件。 |
| `review-analysis` | 审查需求分析产物，并按严重程度分类问题。 | `task-id` | 在设计前确认分析完整可用。 |
| `plan-task` | 编写技术实施方案，并设置审查检查点。 | `task-id` | 分析获批后定义具体实现路径。 |
| `review-plan` | 审查技术方案，并按严重程度分类问题。 | `task-id` | 在编码前确认方案可执行。 |
| `code-task` | 按批准方案实施，或修复代码审查问题，并生成实现报告。 | `task-id` | 在方案获批后编写代码、测试和文档，或处理 review 反馈。 |
| `review-code` | 审查实现结果，并按严重程度分类问题。 | `task-id` | 合入前执行结构化代码审查。 |
| `complete-task` | 在所有关卡通过后标记任务完成并归档。 | `task-id` | 测试、审查和提交都完成后收尾。 |

## 任务状态

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `check-task` | 查看当前任务状态、工作流进度和下一步建议。 | `task-id` | 不修改任务状态，仅检查当前进展。 |
| `block-task` | 将任务标记为阻塞并记录阻塞原因。 | `task-id`、`reason`（可选） | 缺少外部依赖、决策或资源时暂停任务。 |
| `restore-task` | 从 GitHub Issue 同步评论中还原本地任务文件。 | `issue-number`、`task-id`（可选） | 换机器或清空本地状态后恢复任务工作区。 |

## Issue 与 PR

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `create-pr` | 向推断出的目标分支或显式指定分支创建 Pull Request。 | `task-id`（可选）、`target-branch`（可选） | 变更准备合入时创建 PR；清空上下文后也可显式传入任务关联。 |
| `watch-pr` | 监控 PR 的 required checks，失败时自愈直到全绿。 | `task-id` 或 `--pr <number>`（可选；默认取当前分支的 PR） | create-pr 后监控 CI，合入前自动修复简单失败。 |

## 代码质量

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `commit` | 创建 Git 提交，并附带任务状态更新和版权年份检查。 | 无 | 在测试通过后固化一组完整变更。 |
| `test` | 运行项目标准验证流程。 | 无 | 修改后执行编译检查和单元测试验证。 |
| `test-integration` | 运行集成测试或端到端验证。 | 无 | 需要验证跨模块或整条流程行为时。 |

## 发布

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `release` | 执行版本发布流程。 | `version`（`X.Y.Z`） | 发布新版本时。 |
| `create-release-note` | 基于 PR 和 commit 生成发布说明。 | `version`、`previous-version`（可选） | 发布前准备 changelog 时。 |
| `post-release` | 执行版本发布后的收尾工作（版本 bump、产物重建、可选动图录制）。 | 无 | 推送发布标签后完成收尾。 |

## 安全

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `import-dependabot` | 导入 Dependabot 告警并创建修复任务。 | `alert-number` | 将依赖安全告警转入标准任务流程。 |
| `close-dependabot` | 关闭 Dependabot 告警并记录依据。 | `alert-number` | 告警经评估后无需处理时。 |
| `import-codescan` | 导入 Code Scanning 告警并创建修复任务。 | `alert-number` | 将 CodeQL 告警纳入常规修复流程。 |
| `close-codescan` | 关闭 Code Scanning 告警并记录依据。 | `alert-number` | 扫描告警可安全忽略时。 |

## 项目维护

| Skill | 描述 | 参数 | 推荐场景 |
|-------|------|------|---------|
| `upgrade-dependency` | 将依赖从旧版本升级到新版本并验证结果。 | `package`、`old-version`、`new-version` | 进行受控的依赖维护时。 |
| `refine-title` | 将 Issue 或 PR 标题重构为 Conventional Commits 格式。 | `number` | GitHub 标题格式不规范时。 |
| `init-labels` | 初始化仓库标准 GitHub labels 体系。 | 无 | 新仓库首次配置 labels 时。 |
| `init-milestones` | 初始化仓库 milestones 结构。 | 无 | 新仓库首次建立里程碑时。 |
| `archive-tasks` | 将已完成任务按日期归档到目录中，并生成 `manifest` 索引。 | `[--days N \| --before DATE \| TASK-ID...]` | 需要定期清理 `completed/` 目录时。 |
| `update-agent-infra` | 将项目协作基础设施升级到最新模板版本。 | 无 | 需要刷新共享 AI 工具层时。 |

> 所有 skills 都可跨支持的 AI TUI 复用。变化的只是命令前缀，工作流语义保持一致。
