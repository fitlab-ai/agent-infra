# 实现报告模板

创建 `implementation.md` 或 `implementation-r{N}.md` 时，使用以下结构。

## 输出模板

```markdown
# 实现报告

- **实现轮次**: Round {implementation-round}
- **产物文件**: `{implementation-artifact}`

## 变更文件

### 新建文件
- `{file-path}` - {description}

### 修改文件
- `{file-path}` - {change summary}

## 关键代码说明

### {模块/功能名称}
**文件**: `{file-path}:{line-number}`

**实现逻辑**:
{important logic summary}

**关键代码**:
```{language}
{key-code-snippet}
```

## 测试结果

### 单元测试
- 测试文件: `{test-file-path}`
- 测试用例数: {count}
- 通过率: {percentage}

**测试输出**:
```
{test-run-output}
```

## 与方案的差异

{describe any deviation from the approved plan}

## 供审查关注的内容

**建议审查者重点关注**:
- {item 1}
- {item 2}

## 已知问题

{known issues or follow-up ideas}

## 下一步

{recommended follow-up}
```
