# 审查报告模板

编写 `review-code.md` 或 `review-code-r{N}.md` 时使用本模板。

## 输出模板

```markdown
# 代码审查报告

- **审查轮次**：第 {review-round} 轮
- **产物文件**：`{review-artifact}`
- **审查输入**：
  - `{code-artifact}`
  - `{code-artifact}`（如存在）

## 状态核对

> 粘贴状态核对命令原文；每条命令以 `$ ` 开头。

## 审查摘要

- **审查者**：{reviewer-name}
- **审查时间**：{timestamp}
- **审查范围**：{file-count and major modules}
- **总体结论**：{通过 / 需要修改 / 拒绝}（恰取一个；禁止写组合短语，否则 verify gate 失败）
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **env-blocked**：0

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

## 环境性遗留

> AI agent 在本执行环境无法闭环的项；不参与下一轮 refine。维护者在 PR description 中以「待人工验证」清单承接。

#### 1. {环境性项标题}
**文件**：`{file-path}:{line-number}`（如适用）
**说明**：{details}
**所需环境**：{e.g. Docker 沙箱 / macOS host / 特权 root / 第三方账号}
**待人工执行的验证步骤**：{steps for the human verifier}

> 如本轮无 env-blocked 项，保留段落标题并写「（无）」。


## 证据原文

> 每条“我验证了 X”断言都要配对对应 tool output 原文；gate 仅校验本段存在和至少一行 `$ `。每条 Blocker 必须配可复现命令（rg/grep/sed/nl）及其原文；无法复现的判断须降级或移入「自我质疑」。

- 断言：{verified claim}
```text
$ {command}
{raw output}
```

## 自我质疑

> 显式声明本轮审查中**未直接验证**的结论、推断项与所作假设；下游据此可反驳。无则写「（无）」。

- {未直接验证的结论或推断；说明为何未验证、若被推翻的影响}

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
