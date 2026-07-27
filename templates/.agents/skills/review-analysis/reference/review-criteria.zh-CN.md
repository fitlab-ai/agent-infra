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
- [ ] 本轮所有 `needs-human-decision` 详情均符合 `.agents/rules/human-decision-context.md` 的自足结构
- [ ] 每条 blocker 都配可复现的 grep/sed/nl 证据，未直接验证的结论已在「自我质疑」声明

**常见反例**：
- 把实现方案当作需求分析，提前锁定技术细节
- 只复述 Issue 文案，没有补充影响范围、风险和验收标准
- 对无法确认的信息直接下结论，没有标记假设或开放问题
- 凭印象或记忆断言 `file:line`/行为，没有用 rg/nl 复核就下结论

## 共享方法与分类边界

先读取 `.agents/rules/review-method.md`，按其五遍协议、风险镜头和 finding 证据契约执行；finding、manual-validation、advisory 与 `needs-human-decision` 的状态语义以 `.agents/rules/review-handshake.md` 为准。本文件只补充需求分析阶段的专项判断。

同时检查最新需求分析产物和 `task.md` Activity Log，确保报告反映完整的分析上下文。
