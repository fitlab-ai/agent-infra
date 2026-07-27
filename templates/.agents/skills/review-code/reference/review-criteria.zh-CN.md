# 审查标准

在审查代码或划分问题严重程度之前先读取本文件。

## 执行代码审查

遵循 `.agents/workflows/feature-development.yaml` 中的 `code-review` 步骤。

**必查范围**：
- [ ] 代码质量和编码规范
- [ ] bug 与风险识别
- [ ] 测试覆盖率和测试质量
- [ ] 错误处理和边界情况
- [ ] 性能与安全风险
- [ ] 代码注释和文档
  - [ ] 新增或修改的文档准确反映变更后的当前行为
  - [ ] 文档变更由共享风险镜头注册表确定性路由到必读专项 reference
- [ ] 与已批准技术方案的一致性
- [ ] 已复核执行方是否漏标应升级为 `[needs-human-decision]` 的关键设计决策
- [ ] 本轮所有 `needs-human-decision` 详情均符合 `.agents/rules/human-decision-context.md` 的自足结构
- [ ] 每条 blocker 都配可复现的 grep/sed/nl 证据，未直接验证的结论已在「自我质疑」声明

**常见反例**：
- 只检查测试是否通过，没有阅读实际 diff
- 用自然语言措辞偏好替代可复现的代码问题
- 把环境缺失导致无法验证的事项误归类为 blocker
- 凭印象或记忆断言 `file:line`/行为，没有用 rg/nl 复核就下结论

## 共享方法与分类边界

先读取 `.agents/rules/review-method.md`，按其五遍协议、风险镜头和 finding 证据契约执行；finding、manual-validation、advisory 与 `needs-human-decision` 的状态语义以 `.agents/rules/review-handshake.md` 为准。本文件只补充代码实现阶段的专项判断。

同时检查 `git diff`、最新实现产物、最新技术方案审查产物和 `task.md` Activity Log，确保报告反映完整的变更上下文。
