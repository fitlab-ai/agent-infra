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
- [ ] 与已批准技术方案的一致性
- [ ] 已复核执行方是否漏标应升级为 `[needs-human-decision]` 的关键设计决策
- [ ] 每条 blocker 都配可复现的 grep/sed/nl 证据，未直接验证的结论已在「自我质疑」声明

**常见反例**：
- 只检查测试是否通过，没有阅读实际 diff
- 用自然语言措辞偏好替代可复现的代码问题
- 把环境缺失导致无法验证的事项误归类为 blocker
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

同时检查 `git diff`、最新实现产物、最新技术方案审查产物和 `task.md` Activity Log，确保报告反映完整的变更上下文。
