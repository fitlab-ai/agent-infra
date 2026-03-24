---
name: implement-task
description: >
  根据技术方案实施任务，编写代码和测试，输出实现报告。当用户在技术方案审查通过后要求实施任务或编码时触发。
  参数：task-id。
---

# 实施任务

## 行为边界 / 关键规则

- 严格遵循最新技术方案产物（`plan.md` 或 `plan-r{N}.md`）—— 不要偏离，除非记录了偏离原因
- 不要自动提交。绝不自动执行 `git commit` 或 `git add`
- 本技能产出实现报告（`implementation.md` 或 `implementation-r{N}.md`）—— 不覆盖已有轮次产物
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.agents/workspace/active/{task-id}/task.md` - 任务文件
- 至少一个技术方案产物：`plan.md` 或 `plan-r{N}.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 2. 确定输入方案与实现轮次

扫描 `.agents/workspace/active/{task-id}/` 目录中的技术方案文件（`plan.md`、`plan-r{N}.md`）：
- 读取最高轮次的方案文件，记为 `{plan-artifact}`

扫描 `.agents/workspace/active/{task-id}/` 目录中的实现报告文件：
- 如果不存在 `implementation.md` 且不存在 `implementation-r*.md` → 本轮为第 1 轮，产出 `implementation.md`
- 如果存在 `implementation.md` 且不存在 `implementation-r*.md` → 本轮为第 2 轮，产出 `implementation-r2.md`
- 如果存在 `implementation-r{N}.md` → 本轮为第 N+1 轮，产出 `implementation-r{N+1}.md`

记录：
- `{plan-artifact}`：本次实现遵循的技术方案文件
- `{implementation-round}`：本轮实现轮次
- `{implementation-artifact}`：本轮实现报告文件名

注意：仅在审查结论为“拒绝”后重新执行时才会进入多轮。正常首次实现始终产出 `implementation.md`。

### 3. 阅读技术方案

仔细阅读 `{plan-artifact}` 以理解：
- 技术方法和解决策略
- 详细实施步骤
- 需要创建/修改的文件
- 测试策略
- 任何约束或风险

### 4. 执行代码实现

遵循 `.agents/workflows/feature-development.yaml` 中的 `implementation` 步骤：

**必要任务**：
- [ ] 按照计划实现功能代码
- [ ] 编写全面的单元测试
- [ ] 在本地运行测试以验证功能
- [ ] 更新相关文档和注释
- [ ] 遵循项目编码规范（参见项目指南）

**实现原则**：
1. **严格遵循计划**：不偏离技术方案
2. **逐步执行**：按顺序执行计划步骤
3. **持续测试**：每完成一个步骤后运行测试
4. **保持简单**：不过度设计，不添加计划外的功能

### 5. 运行测试验证

执行项目的测试命令。参考 `test` 技能获取项目特定的测试命令：

```bash
# 查看 .agents/skills/test/SKILL.md 获取项目测试命令
# 常见模式：
# npm test          (Node.js)
# mvn test          (Maven)
# pytest            (Python)
# go test ./...     (Go)
```

如果测试失败：
- 先分析失败原因，优先修复由本次实现引入的问题，以及为匹配已批准方案而需要同步调整的测试或文档
- 修复后重新运行测试，直到测试通过，或明确确认存在超出当前任务范围的外部阻塞
- 仅当问题属于外部阻塞、环境缺失或需求不明确且无法在当前任务内解决时，才向用户报告阻塞并停止；此时不要创建实现报告，不要更新 task.md 为实现完成，也不要输出步骤 8 的完成模板

只有全部测试通过后，才可以继续步骤 6、7 和 8。

### 6. 输出实现报告

创建 `.agents/workspace/active/{task-id}/{implementation-artifact}`。

要求：
- 不要覆盖已有的实现报告
- 在报告中明确记录本轮轮次编号和实际产物文件名
- 如果本轮是重实现，说明其触发原因（例如上一轮审查结论为 Rejected）

### 7. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：implementation
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 记录本轮实现产物：`{implementation-artifact}`（Round `{implementation-round}`）
- 在工作流进度中标记 implementation 为已完成，并注明实际轮次（如果任务模板支持）
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Implementation (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {artifact-filename}
  ```

### 8. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务 {task-id} 实现完成。

摘要：
- 修改文件：{数量}
- 新建文件：{数量}
- 测试通过：{数量}/{总数}

产出文件：
- 实现报告：.agents/workspace/active/{task-id}/{implementation-artifact}（Round {implementation-round}）

下一步 - 代码审查：
  - Claude Code / OpenCode：/review-task {task-id}
  - Gemini CLI：/agent-infra:review-task {task-id}
  - Codex CLI：$review-task {task-id}
```

## 输出模板

```markdown
# 实现报告

- **实现轮次**：Round {implementation-round}
- **产物文件**：`{implementation-artifact}`

## 修改文件

### 新建文件
- `{file-path}` - {描述}

### 修改文件
- `{file-path}` - {变更摘要}

## 关键代码说明

### {模块/功能名称}
**文件**：`{file-path}:{line-number}`

**实现逻辑**：
{重要逻辑的说明}

**关键代码**：
```{language}
{关键代码片段}
```

## 测试结果

### 单元测试
- 测试文件：`{test-file-path}`
- 测试用例数：{数量}
- 通过率：{百分比}

**测试输出**：
```
{测试运行结果}
```

## 与计划的差异

{如果实现与计划有差异，说明原因}

## 审查关注点

**需要审查者注意的要点**：
- {关注点 1}
- {关注点 2}

## 已知问题

{实现过程中发现的问题或后续需要优化的事项}

## 后续步骤

{代码审查或后续工作的建议}
```

## 完成检查清单

- [ ] 完成了所有代码实现
- [ ] 创建了实现报告 `.agents/workspace/active/{task-id}/{implementation-artifact}`
- [ ] 所有测试通过
- [ ] 更新了 task.md 中的 `current_step` 为 implementation
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 在工作流进度中标记了 implementation 为已完成
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）

## 停止

完成检查清单后，**停止**。不要自动提交。等待代码审查后再提交。

## 注意事项

1. **前置条件**：必须有已审查的技术方案（`plan.md` 或 `plan-r{N}.md` 存在且已获批准）
2. **禁止自动提交**：不要自动执行 `git commit` 或 `git add`。提醒用户手动提交
3. **测试要求**：所有新代码必须有单元测试；测试覆盖率不得下降
4. **代码质量**：遵循项目编码规范
5. **计划偏离**：如果需要偏离计划，在实现报告中记录原因
6. **版本化规则**：首轮实现使用 `implementation.md`；后续重实现使用 `implementation-r{N}.md`

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少计划：提示 "Technical plan not found, please run the plan-task skill first"
- 测试失败：先尝试修复并重新运行测试；只有在存在外部阻塞、环境缺失或需求不明确时才停止，并输出阻塞原因
- 构建失败：输出构建错误，停止实现
