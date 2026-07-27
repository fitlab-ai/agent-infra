# 审查报告模板

编写 `review-analysis.md` 或 `review-analysis-r{N}.md` 时使用本模板。

## 输出模板

```markdown
# 需求分析审查报告

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

## 检视覆盖声明

| pass_id | scope | evidence | result | gaps_or_assumptions |
|---------|-------|----------|--------|---------------------|
| pass-1..5 | {本遍实际范围} | {artifact / file:line / command} | {发现或结论} | {缺口或假设} |

| lens_id | trigger_evidence | loaded | result |
|---------|------------------|--------|--------|
| {registry token} | {命中或未命中证据} | {yes / no / not-applicable} | {专项结论} |

## 需求分析专项覆盖

| perspective_id | applicability | reviewed_scope | evidence | result_or_gap |
|----------------|---------------|----------------|----------|---------------|
| user | {applicable / not-applicable} | {业务目标、使用结果、非目标与验收} | {source_id / artifact / file:line} | {covered / gap} |
| maintainer | {applicable / not-applicable} | {维护边界、依赖、兼容性与长期责任} | {source_id / artifact / file:line} | {covered / gap} |
| operations | {applicable / not-applicable} | {部署、运行、可观测性、恢复与支持约束} | {source_id / artifact / file:line} | {covered / gap} |
| security | {applicable / not-applicable} | {信任边界、权限、数据与滥用风险} | {source_id / artifact / file:line} | {covered / gap} |
| testing | {applicable / not-applicable} | {输入、动作、结果、边界与验证环境} | {source_id / artifact / file:line} | {covered / gap} |

| quality_id | source | stakeholder | priority_or_tradeoff | verification | result_or_gap |
|------------|--------|-------------|----------------------|--------------|---------------|
| {稳定标识} | {source_id} | {利益相关者} | {优先级或权衡状态} | {可观察验证方式} | {covered / gap} |

| evolution_id | source | confirmation_status | classification | boundary_evidence | result_or_gap |
|--------------|--------|---------------------|----------------|-------------------|---------------|
| {稳定标识} | {source_id} | {confirmed / unconfirmed} | {design-input / assumption / open-question} | {不扩张为当前需求的证据} | {covered / gap} |

| acceptance_id | observable_input | action | expected_result | status_or_gap |
|---------------|------------------|--------|-----------------|---------------|
| {稳定标识} | {可观察输入} | {审查或验证动作} | {预期结果} | {verifiable / open / gap} |

## 追踪矩阵

| source_id | upstream | reviewed_target | verification | status_or_gap |
|-----------|----------|-----------------|--------------|---------------|
| {来源标识} | {上游需求或事实} | {需求/验收/影响/风险} | {验证证据} | {covered / gap} |

## 问题清单

### 阻塞项（必须修复）

#### 1. {问题标题}
**文件**：`{file-path}:{line-number}`
**场景**：{scenario}
**影响**：{impact}
**证据**：{reproducible evidence}
**置信度**：{high / medium / low}
**未验证假设**：{assumptions or none}
**修复方向**：{fix direction}

### 主要问题（建议修复）

#### 1. {问题标题}
**文件**：`{file-path}:{line-number}`
**场景**：{scenario}
**影响**：{impact}
**证据**：{reproducible evidence}
**置信度**：{high / medium / low}
**未验证假设**：{assumptions or none}
**修复方向**：{fix direction}

### 次要问题（低影响但需闭环）

#### 1. {改进点}
**文件**：`{file-path}:{line-number}`
**建议**：{improvement suggestion}

## 非阻塞建议

> 仅记录不影响当前产物完整性、正确性和验收的后续优化；不写入审查分歧账本，不计入 blocker / major / minor，也不影响结论。

- {future optimization}

## 人工校验项

> AI agent 在本执行环境无法闭环的项；不参与下一轮 refine。维护者在 PR description 中以「待人工验证」清单承接。

#### 1. {人工校验项标题}
**文件**：`{file-path}:{line-number}`（如适用）
**说明**：{details}
**所需环境**：{e.g. Docker 沙箱 / macOS host / 特权 root / 第三方账号}
**待人工执行的验证步骤**：{steps for the human verifier}

> 如本轮无人工校验项，保留段落标题并写「（无）」。


## 审查分歧账本回写

> 本段记录将提交的结构化意图：新 finding 用 `task-ledger finding-upsert`，上一轮响应复核用 `finding-review`；由核心分配 `AN-N` 并校验状态机，禁止手写 task.md 表格。
> 凡升级为 `needs-human-decision` 的 finding，必须按 `.agents/rules/human-decision-context.md` 在本报告中提供自足详情块，并让 evidence 指向该稳定锚点。

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
