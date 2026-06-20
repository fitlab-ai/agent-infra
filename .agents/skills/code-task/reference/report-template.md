# 实现报告模板

创建 `code.md` 或 `code-r{N}.md` 时，使用以下结构。

## 输出模板

```markdown
# 实现报告

- **实现轮次**: Round {code-round}
- **产物文件**: `{code-artifact}`

## 状态核对

> 粘贴状态核对命令原文；每条命令以 `$ ` 开头。

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


## 证据原文

> 每条“我验证了 X”断言都要配对对应 tool output 原文；gate 仅校验本段存在和至少一行 `$ `。

- 断言：{verified claim}
```text
$ {command}
{raw output}
```

## 与方案的差异

{describe any deviation from the approved plan}

## 对审查发现的逐条核实

> 仅修复模式填写；初次实现写「（本轮为初次实现，无审查发现）」。对上一轮 `review-code` 的每条发现先 Read/Grep 核实，再按 `.agents/rules/review-handshake.md` 的四态处置；并把处置与**相称证据**回写 task.md `## 审查分歧账本` 对应行（stage=code，round +1）。对称证据：accepted/adjusted 附修复点 file:line，refuted/cannot-judge 附反证 file:line 或命令原文。

| 发现 | 处置状态 | 相称证据 |
|------|----------|----------|
| {finding} | {accepted / adjusted / refuted / cannot-judge} | {修复点 file:line，或反证 file:line / 命令原文} |

## 供审查关注的内容

**建议审查者重点关注**:
- {item 1}
- {item 2}

## 已知问题

{known issues or follow-up ideas}

## 下一步

{recommended follow-up}
```
