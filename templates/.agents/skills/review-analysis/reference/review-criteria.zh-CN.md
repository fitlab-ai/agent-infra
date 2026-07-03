# 审查标准

在审查需求分析或划分问题严重程度之前先读取本文件。

## 执行需求分析审查

遵循 `.agents/workflows/feature-development.yaml` 中的 `analysis-review` 步骤。

**必查范围**：
- [ ] 需求范围、目标和非目标是否清晰
- [ ] 验收标准是否可验证
- [ ] 受影响区域、依赖和约束是否识别充分
- [ ] 风险、边界情况和开放问题是否记录
- [ ] 后续设计阶段是否有足够输入
- [ ] 与原始 Issue / 用户需求是否一致
- [ ] 已复核执行方是否漏标应升级为 `[needs-human-decision]` 的关键设计决策
- [ ] 每条 blocker 都配可复现的 grep/sed/nl 证据，未直接验证的结论已在「自我质疑」声明

**常见反例**：
- 把实现方案当作需求分析，提前锁定技术细节
- 只复述 Issue 文案，没有补充影响范围、风险和验收标准
- 对无法确认的信息直接下结论，没有标记假设或开放问题
- 凭印象或记忆断言 `file:line`/行为，没有用 rg/nl 复核就下结论

## 通用审查原则

1. **严格但公正**：既要指出问题，也要承认做得好的部分
2. **具体**：引用准确的文件路径和行号
3. **可执行**：给出明确可落地的修复建议
4. **按严重程度分类**：明确区分 blocker、major 和 minor

## 人工校验项分类

某些发现项是 AI agent 在本执行环境**无法闭环**的，例如：

- 缺 Docker / 沙箱而无法跑端到端验证
- 缺特定 OS（macOS-only 行为）
- 缺第三方账号 / OAuth
- 缺特权操作（root、sudo、特殊网络）

**分类决策树**：「AI agent 能否在不改环境的前提下独立闭环这一项？」
- 是 -> blocker / major / minor 之一（按风险定档）
- 否 -> **manual-validation**（人工校验元类目，不参与严重程度排序）

manual-validation 项的去向：
- 写入 review 报告独立段落「人工校验项」
- 在 done note 中写入源字段 `Manual-validation: 1`；`ai task log` 归一化展示到 review 行
- **不**进入 code-task 修复循环；维护者在 PR description 中以「待人工验证」清单形式承接

同时检查最新需求分析产物和 `task.md` Activity Log，确保报告反映完整的分析上下文。
