# 修复报告模板

编写 `refinement.md` 或 `refinement-r{N}.md` 时，使用以下结构。

## 输出模板

```markdown
# 修复报告

- **修复轮次**: Round {refinement-round}
- **产物文件**: `{refinement-artifact}`
- **审查输入**: `{review-artifact}`
- **实现上下文**: `{implementation-artifact}`

### 审查反馈处理

#### 阻塞项修复
1. **{issue-title}**
   - **修复**: {what changed}
   - **文件**: `{file-path}:{line-number}`
   - **验证**: {validation}

#### 主要问题修复
1. **{issue-title}**
   - **修复**: {what changed}
   - **文件**: `{file-path}:{line-number}`

#### 次要问题处理
1. **{issue-title}**
   - **修复**: {what changed}

#### 未解决问题
- {issue}: {reason}

### 修复后的测试结果
- 所有测试通过: {yes/no}
- 测试输出: {summary}
```
