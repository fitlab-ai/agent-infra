---
name: plan-task
description: >
  为任务设计技术方案并输出详细的实施计划。当用户要求为已完成需求分析的任务设计方案或技术计划时触发。
  这是一个强制性的人工审查检查点。参数：task-id。
---

# 设计技术方案

## 行为边界 / 关键规则

- 本技能仅产出 `plan.md` —— 不修改任何业务代码
- 这是一个**强制性的人工审查检查点** —— 不要自动进入实现阶段
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.ai-workspace/active/{task-id}/task.md` - 任务文件
- `.ai-workspace/active/{task-id}/analysis.md` - 需求分析

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 2. 阅读需求分析

仔细阅读 `analysis.md` 以理解：
- 需求及其背景
- 相关文件和代码结构
- 影响范围和依赖关系
- 已识别的技术风险
- 工作量和复杂度评估

### 3. 理解问题

- 阅读分析中识别的相关源码文件
- 理解当前架构和模式
- 识别约束条件（向后兼容性、性能等）
- 考虑边界情况和错误场景

### 4. 设计技术方案

遵循 `.agents/workflows/feature-development.yaml` 中的 `technical-design` 步骤：

**必要任务**：
- [ ] 定义技术方法和理由
- [ ] 考虑备选方案并说明权衡
- [ ] 按顺序详细列出实施步骤
- [ ] 列出所有需要创建/修改的文件
- [ ] 定义验证策略（测试、手动检查）
- [ ] 评估方案的影响和风险

**设计原则**：
1. **简洁性**：优先选择满足需求的最简方案
2. **一致性**：遵循现有代码模式和规范
3. **可测试性**：设计易于测试的方案
4. **可逆性**：优先选择易于回退的变更

### 5. 输出计划文档

创建 `.ai-workspace/active/{task-id}/plan.md`。

### 6. 更新任务状态

更新 `.ai-workspace/active/{task-id}/task.md`：
- `current_step`：technical-design
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 标记 plan.md 为已完成
- 在工作流进度中标记 technical-design 为已完成

### 7. 告知用户

输出格式：
```
Technical plan complete for task {task-id}.

Plan summary:
- Approach: {简要描述}
- Files to modify: {数量}
- Files to create: {数量}
- Estimated complexity: {评估}

Output file:
- Technical plan: .ai-workspace/active/{task-id}/plan.md

IMPORTANT: Human review checkpoint.
Please review the technical plan before proceeding to implementation.

Next step:
  execute the implement-task skill with {task-id}
```

## 输出模板

```markdown
# 技术方案

## 问题理解
{总结需要解决的问题和关键约束}

## 约束条件
- {约束 1}
- {约束 2}

## 方案对比

### 方案 A：{名称}
- **方法**：{描述}
- **优点**：{优势}
- **缺点**：{劣势}

### 方案 B：{名称}
- **方法**：{描述}
- **优点**：{优势}
- **缺点**：{劣势}

### 决策
{选择哪个方案以及原因}

## 技术方法
{所选方案的详细描述}

## 实施步骤

### 步骤 1：{标题}
- **文件**：`{file-path}`
- **操作**：{要做什么}
- **详情**：{具体细节}

### 步骤 2：{标题}
...

## 文件清单

### 新建文件
- `{file-path}` - {用途}

### 修改文件
- `{file-path}` - {修改内容}

## 验证策略

### 单元测试
- {测试用例 1}
- {测试用例 2}

### 手动验证
- {验证步骤}

## 影响评估
- 破坏性变更：{是/否 - 详情}
- 性能影响：{评估}
- 安全考量：{评估}

## 风险控制
- {风险 1}：{缓解措施}
- {风险 2}：{缓解措施}
```

## 完成检查清单

- [ ] 阅读并理解了需求分析
- [ ] 考虑了备选方案
- [ ] 创建了计划文档 `.ai-workspace/active/{task-id}/plan.md`
- [ ] 更新了 task.md 中的 `current_step` 为 technical-design
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 在 task.md 中标记了 plan.md 为已完成
- [ ] 在工作流进度中标记了 technical-design 为已完成
- [ ] 告知了用户这是人工审查检查点
- [ ] 告知了用户下一步（implement-task）

## 停止

完成检查清单后，**立即停止**。
这是一个**强制性的人工审查检查点** —— 用户必须审查并批准计划后才能继续实现。

## 注意事项

1. **前置条件**：必须已完成需求分析（analysis.md 存在）
2. **人工审查**：这是强制性检查点 —— 不要自动进入实现阶段
3. **计划质量**：计划应足够具体，使另一个 AI 代理无需额外上下文即可实现

## 错误处理

- 任务未找到：提示 "Task {task-id} not found, please check the task ID"
- 缺少分析：提示 "Analysis not found, please run the create-task or analyze-issue skill first"
