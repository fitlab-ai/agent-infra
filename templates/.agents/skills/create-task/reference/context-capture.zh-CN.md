# 上下文捕获协议

## 范围

只捕获当前自然语言请求及当前上下文中可见、与任务直接相关的必要前序讨论。不读取上下文之外的信息，不保存完整聊天记录，也不执行需求分析、代码影响分析或技术设计。

## 分类

将已有信息忠实压缩并写入 task.md 的 `## 任务输入`：

- `### 来源`：注明用户当次请求、用户前序陈述、用户确认或 Agent 建议等来源。
- `### 已确认事实与证据`：只写用户提供或已核实的事实、复现步骤、错误和观察结果。
- `### 约束`：保留用户明确限制、安全边界和兼容要求。
- `### 已确认决策`：只写用户明确确认的方向；不得把 Agent 建议升级为已批准决策。
- `### 候选与否决方案`：注明每项是候选、Agent 建议、暂定假设或已否决方案，并保留来源。
- `### 验收标准`：保存用户已给出的可观察输入、动作和预期结果。
- `### 未决事项`：保存尚未回答的问题或仍需裁定的选择。

缺失类别保持为空，不推导补齐。相同信息去重，但不得丢失来源或状态语义。

## 可观察验收提取

以下语言无关契约是可观察验收信息的稳定捕获边界：

```text
# observable-acceptance-contract
sources: current-request,necessary-prior-discussion
scan-entire-visible-context: true
recognize-without-acceptance-label: true
components: observable-input,action,expected-result
combine-distributed-evidence: true
preserve-source-state: true
missing-components: preserve-as-gaps
agent-inference-as-confirmed: false
destination: task-input.acceptance-criteria
scenario-explicit: capture-supported-components
scenario-distributed: combine-supported-components
scenario-insufficient: preserve-supported-components-and-gaps
```

执行顺序：

1. 扫描当前请求及必要前序讨论的完整可见上下文；即使用户没有使用“验收标准”标签，也要识别其中的可观察信息。
2. 找出可观察输入、用户或系统执行的动作以及预期结果。这些组成可以分散在不同轮次。
3. 将描述同一行为且有上下文证据的组成合并为自足条目，并保留每项信息的来源和确认状态。
4. 未表达的组成保持为缺口；不得补造阈值、场景、动作或结果，也不得把 Agent 推导标记为用户已确认。
5. 将条目写入 `## 任务输入 / ### 验收标准`。如果上下文没有提供可观察标准，该分类保持为空，真实的待确认信息继续保留在既有分类中。

边界样例：

- **单轮显式信息**：当前请求同时给出输入、动作和结果时，捕获全部有证据的组成并注明来自当前请求。
- **跨轮分散信息**：当前请求描述动作、必要前序讨论提供输入或结果时，只合并属于同一行为的组成，并分别保留来源状态。
- **信息不足**：用户只说“应该更快”但没有可观察条件或阈值时，不得编造性能目标；保留已表达的关注点和缺口，无法形成标准则让验收分类为空。

## 安全与压缩

- 排除密钥、Token、凭据和与任务无关的个人信息。
- 使用自足摘要，不逐字复制完整 transcript。
- 保留命令、错误文本、路径或标识符时，只保留复现和验收所必需的部分。

## 完成检查

仅阅读生成的 task.md 时，应能区分已确认内容、候选或假设、否决内容和未决事项，并能理解任务目标与已有验收标准。
