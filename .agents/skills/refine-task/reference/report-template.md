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

#### 环境性遗留处理

> 这些项不在 AI 修复范围；不计入修复总数。仅原样保留并指明维护者后续验证路径。

1. **{issue-title}**
   - **状态**：跳过（不在 AI 修复范围）
   - **所需环境**：{e.g. Docker 沙箱 / macOS host / 第三方账号}
   - **维护者验证步骤**：{steps}

> 如本轮无 env-blocked 项，保留小节标题并写「（无）」。

#### 未解决问题
- {issue}: {reason}

### 修复后的测试结果
- 所有测试通过: {yes/no}
- 测试输出: {summary}
```
