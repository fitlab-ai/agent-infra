---
name: review-task
description: >
  审查任务实现代码并输出代码审查报告，按严重程度分类（Blocker / Major / Minor）。
  当用户在实现完成后要求代码审查时触发。参数：task-id。
---

# 代码审查

## 行为边界 / 关键规则

- 本技能仅读取代码并产出审查报告（`review.md` 或 `review-r{N}.md`）—— 不修改业务代码
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.ai-workspace/active/{task-id}/task.md` - 任务文件
- 至少一个实现报告：`implementation.md` 或 `implementation-r{N}.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 1.5 确定审查轮次

扫描 `.ai-workspace/active/{task-id}/` 目录中的审查产物文件：
- 如果不存在 `review.md` 且不存在 `review-r*.md` → 本轮为第 1 轮，产出 `review.md`
- 如果存在 `review.md` 且不存在 `review-r*.md` → 本轮为第 2 轮，产出 `review-r2.md`
- 如果存在 `review-r{N}.md` → 本轮为第 N+1 轮，产出 `review-r{N+1}.md`

记录：
- `{review-round}`：本轮审查轮次
- `{review-artifact}`：本轮审查报告文件名

### 2. 阅读实现报告

扫描任务目录中的实现报告文件（`implementation.md`、`implementation-r{N}.md`），读取最高轮次的文件以理解：
- 修改的文件列表
- 实现的关键功能
- 测试情况
- 实现者标记的需关注事项

### 3. 执行代码审查

遵循 `.agents/workflows/feature-development.yaml` 中的 `code-review` 步骤：

**必要审查领域**：
- [ ] 代码质量和编码规范（按项目指南）
- [ ] Bug 和潜在问题检测
- [ ] 测试覆盖率和测试质量
- [ ] 错误处理和边界情况
- [ ] 性能和安全问题
- [ ] 代码注释和文档
- [ ] 与技术方案的一致性

**审查原则**：
1. **严格但公正**：指出问题的同时也肯定做得好的地方
2. **具体**：提供准确的文件路径和行号
3. **提供建议**：不仅指出问题，还要提供解决方案
4. **按严重程度分类**：区分必须修复和可优化项

同时审查 `git diff` 以查看所有变更的上下文。

### 4. 输出审查报告

创建 `.ai-workspace/active/{task-id}/{review-artifact}`。

### 5. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.ai-workspace/active/{task-id}/task.md`：
- `current_step`：code-review
- `assigned_to`：{审查者}
- `updated_at`：{当前时间}
- 记录本轮审查产物：`{review-artifact}`（Round `{review-round}`）
- 在工作流进度中标记 code-review 为已完成，并注明实际轮次（如果任务模板支持）
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Code Review (Round {N})** by {agent} — 结论：{已批准/需要修改/拒绝}，阻塞项：{n}，主要问题：{n}，次要问题：{n} → {artifact-filename}
  ```

### 6. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

根据审查结果输出：

**如果通过**：
```
任务 {task-id} 代码审查完成。结论：通过。
- 阻塞项：0 | 主要问题：{n} | 次要问题：{n}

下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/{{project}}:commit
  - Codex CLI：$commit
```

**如果需要修改**：
```
任务 {task-id} 代码审查完成。结论：需要修改。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n}
- 审查报告：.ai-workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题：
  - Claude Code / OpenCode：/refine-task {task-id}
  - Gemini CLI：/{{project}}:refine-task {task-id}
  - Codex CLI：$refine-task {task-id}
```

**如果拒绝**：
```
任务 {task-id} 代码审查完成。结论：拒绝，需要重大返工。
- 审查报告：.ai-workspace/active/{task-id}/{review-artifact}

下一步 - 重新实现：
  - Claude Code / OpenCode：/implement-task {task-id}
  - Gemini CLI：/{{project}}:implement-task {task-id}
  - Codex CLI：$implement-task {task-id}
```

## 输出模板

```markdown
# 代码审查报告

- **审查轮次**：Round {review-round}
- **产物文件**：`{review-artifact}`
- **实现输入**：`{implementation-artifact}`

## 审查摘要

- **审查者**：{审查者名称}
- **审查时间**：{时间戳}
- **审查范围**：{文件数量和主要模块}
- **总体结论**：{已批准 / 需要修改 / 拒绝}

## 发现的问题

### 阻塞项（必须修复）

#### 1. {问题标题}
**文件**：`{file-path}:{line-number}`
**描述**：{详细描述}
**建议修复**：{具体建议}
**严重程度**：高

### 主要问题（应该修复）

#### 1. {问题标题}
**文件**：`{file-path}:{line-number}`
**描述**：{详细描述}
**建议修复**：{具体建议}
**严重程度**：中

### 次要问题（可选优化）

#### 1. {优化点}
**文件**：`{file-path}:{line-number}`
**建议**：{优化建议}

## 亮点

- {做得好的方面 1}
- {做得好的方面 2}

## 规范符合度

### 编码规范
- [ ] 命名规范
- [ ] 代码风格
- [ ] 注释规范
- [ ] 测试规范

### 代码质量指标
- 圈复杂度：{评估}
- 代码重复：{评估}
- 测试覆盖率：{百分比或评估}

## 测试审查

### 测试覆盖率
- 单元测试：{评估}
- 边界情况：{是否覆盖？}
- 错误场景：{是否覆盖？}

### 测试质量
- 测试命名：{评估}
- 断言充分性：{评估}
- 测试独立性：{评估}

## 安全审查

- SQL 注入风险：{检查结果}
- XSS 风险：{检查结果}
- 访问控制：{检查结果}
- 敏感数据暴露：{检查结果}

## 性能审查

- 算法复杂度：{评估}
- 资源管理：{检查结果}
- 潜在瓶颈：{评估}

## 与方案的一致性

- [ ] 实现与技术方案一致
- [ ] 没有偏离设计意图
- [ ] 没有添加计划外的功能

## 结论和建议

### 审批决定
- [ ] 通过 - 无阻塞问题
- [ ] 需要修改 - 有需要解决的问题
- [ ] 拒绝 - 需要重大返工

### 后续步骤
{基于审查结果的建议}
```

## 完成检查清单

- [ ] 完成了所有修改文件的代码审查
- [ ] 创建了审查报告 `.ai-workspace/active/{task-id}/{review-artifact}`
- [ ] 更新了 task.md 中的 `current_step` 为 code-review
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to` 为审查者名称
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 在工作流进度中标记了 code-review 为已完成
- [ ] 根据审查结果告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）

## 注意事项

1. **前置条件**：必须已完成至少一轮实现（`implementation.md` 或 `implementation-r{N}.md` 存在）
2. **客观性**：严格但公正；在指出问题的同时肯定优秀的工作
3. **具体性**：始终引用准确的文件路径和行号
4. **严重程度分类**：阻塞项必须修复；主要问题应该修复；次要问题为可选
5. **版本化规则**：首轮审查使用 `review.md`；后续轮次使用 `review-r{N}.md`

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少实现报告：提示 "Implementation report not found, please run the implement-task skill first"
