# 审查报告模板

编写 `review-analysis.md` 或 `review-analysis-r{N}.md` 时使用本模板。

## 输出模板

```markdown
# 代码审查报告

- **审查轮次**：第 {review-round} 轮
- **产物文件**：`{review-artifact}`
- **审查输入**：
  - `{analysis-artifact}`（本轮实际检视的最高轮需求分析产物，如 `analysis-r2.md`；无法可靠取得则留空）

## 状态核对

> 粘贴状态核对命令原文；每条命令以 `$ ` 开头。

## 审查摘要

- **审查者**：{reviewer-name}
- **审查时间**：{timestamp}
- **审查范围**：{file-count and major modules}
- **总体结论**：{通过 / 需要修改 / 拒绝}
- **发现（AI 可处理）**：0 阻塞项，0 主要，0 次要 / **人工校验**：0

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

## 人工校验项

> AI agent 在本执行环境无法闭环的项；不参与下一轮 refine。维护者在 PR description 中以「待人工验证」清单承接。

#### 1. {人工校验项标题}
**文件**：`{file-path}:{line-number}`（如适用）
**说明**：{details}
**所需环境**：{e.g. Docker 沙箱 / macOS host / 特权 root / 第三方账号}
**待人工执行的验证步骤**：{steps for the human verifier}

> 如本轮无人工校验项，保留段落标题并写「（无）」。


## 审查分歧账本回写

> 把本轮每条 finding upsert 到 task.md `## 审查分歧账本`：新 finding 追加 `open` 行（id 前缀 `AN-`，stage=analysis），对执行方上一轮响应按回交义务改 `confirmed` / 置回 `open` / `needs-human-decision`。状态机与证据规则见 `.agents/rules/review-handshake.md`。

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
