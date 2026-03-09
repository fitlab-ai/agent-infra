---
name: implement-task
description: >
  根据技术方案实施任务，编写代码和测试，输出实现报告。当用户在技术方案审查通过后要求实施任务或编码时触发。
  参数：task-id。
---

# 实施任务

## 行为边界 / 关键规则

- 严格遵循 `plan.md` —— 不要偏离，除非记录了偏离原因
- 不要自动提交。绝不自动执行 `git commit` 或 `git add`
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.ai-workspace/active/{task-id}/task.md` - 任务文件
- `.ai-workspace/active/{task-id}/plan.md` - 技术方案

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 2. 阅读技术方案

仔细阅读 `plan.md` 以理解：
- 技术方法和解决策略
- 详细实施步骤
- 需要创建/修改的文件
- 测试策略
- 任何约束或风险

### 3. 执行代码实现

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

### 4. 运行测试验证

执行项目的测试命令。参考 `test` 技能获取项目特定的测试命令：

```bash
# 查看 .agents/skills/test/SKILL.md 获取项目测试命令
# 常见模式：
# npm test          (Node.js)
# mvn test          (Maven)
# pytest            (Python)
# go test ./...     (Go)
```

确保所有测试通过。如果测试失败，在继续之前修复问题。

### 5. 输出实现报告

创建 `.ai-workspace/active/{task-id}/implementation.md`。

### 6. 更新任务状态

更新 `.ai-workspace/active/{task-id}/task.md`：
- `current_step`：implementation
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 标记 implementation.md 为已完成
- 在工作流进度中标记 implementation 为已完成

### 7. 告知用户

输出格式：
```
Implementation complete for task {task-id}.

Summary:
- Modified files: {数量}
- New files: {数量}
- Tests passed: {数量}/{总数}

Output file:
- Implementation report: .ai-workspace/active/{task-id}/implementation.md

Next step - code review:
  execute the review-task skill with {task-id}
```

## 输出模板

```markdown
# 实现报告

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
- [ ] 创建了实现报告 `.ai-workspace/active/{task-id}/implementation.md`
- [ ] 所有测试通过
- [ ] 更新了 task.md 中的 `current_step` 为 implementation
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 在工作流进度中标记了 implementation 为已完成
- [ ] 告知了用户下一步（review-task）

## 停止

完成检查清单后，**停止**。不要自动提交。等待代码审查后再提交。

## 注意事项

1. **前置条件**：必须有已审查的技术方案（plan.md 存在且已获批准）
2. **禁止自动提交**：不要自动执行 `git commit` 或 `git add`。提醒用户手动提交
3. **测试要求**：所有新代码必须有单元测试；测试覆盖率不得下降
4. **代码质量**：遵循项目编码规范
5. **计划偏离**：如果需要偏离计划，在实现报告中记录原因

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少计划：提示 "Technical plan not found, please run the plan-task skill first"
- 测试失败：输出测试错误，询问用户是否继续
- 构建失败：输出构建错误，停止实现
