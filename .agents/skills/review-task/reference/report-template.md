# 审查报告模板

编写 `review.md` 或 `review-r{N}.md` 时使用本模板。

## 输出模板

```markdown
# 代码审查报告

- **审查轮次**：第 {review-round} 轮
- **产物文件**：`{review-artifact}`
- **审查输入**：
  - `{implementation-artifact}`
  - `{refinement-artifact}`（如存在）

## 审查摘要

- **审查者**：{reviewer-name}
- **审查时间**：{timestamp}
- **审查范围**：{file-count and major modules}
- **总体结论**：{通过 / 需要修改 / 拒绝}

## 问题清单

### 阻塞项（必须修复）

#### 1. {问题标题}
**文件**：`{file-path}:{line-number}`
**说明**：{details}
**修复建议**：{fix suggestion}

### 主要问题（建议修复）

#### 1. {问题标题}
**文件**：`{file-path}:{line-number}`
**说明**：{details}
**修复建议**：{fix suggestion}

### 次要问题（可选改进）

#### 1. {改进点}
**文件**：`{file-path}:{line-number}`
**建议**：{improvement suggestion}

## 亮点

- {what went well}

## 与方案一致性

- [ ] 实现与技术方案一致
- [ ] 没有意外的范围扩张

## 结论与建议

### 审查决定
- [ ] 通过
- [ ] 需要修改
- [ ] 拒绝

### 下一步
{recommended next step}
```
