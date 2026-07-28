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
- [ ] 每条 blocker/major 都配与问题相称的语义证据，未直接验证的结论已在「自我质疑」声明

**常见反例**：
- 只检查测试是否通过，没有阅读实际 diff
- 用自然语言措辞偏好替代可复现的代码问题
- 把环境缺失导致无法验证的事项误归类为 blocker
- 凭印象或记忆断言 `file:line`/行为，没有用 rg/nl 复核就下结论

## 共享方法与分类边界

先读取 `.agents/rules/review-method.md`，按其五遍协议、风险镜头和 finding 证据契约执行；finding、manual-validation、advisory 与 `needs-human-decision` 的状态语义以 `.agents/rules/review-handshake.md` 为准。本文件只补充代码实现阶段的专项判断。

同时检查 `git diff`、最新实现产物、最新技术方案审查产物和 `task.md` Activity Log，确保报告反映完整的变更上下文。

## 代码阶段五遍动作

| pass_id | code-stage action |
|---------|-------------------|
| pass-1 | 读取完整 diff、未跟踪文件、实现/方案产物、任务来源和测试原始结果 |
| pass-2 | 建立验收/方案—实现—验证映射，并记录 changed lines、调用上下文、状态/数据流和未覆盖区域 |
| pass-3 | 先检查整体设计，再检查逐文件语义；判断共享注册表的每个触发器并完整加载命中 reference |
| pass-4 | 检查保护条件、调用约束、测试覆盖和更窄影响范围等反证 |
| pass-5 | 核对 finding、manual-validation、advisory、证据类型、未验证假设、账本和 verdict |

逐行 diff 阅读不能替代必要的调用链、状态转换或数据流检查。

## 结构设计镜头

| quality_id | review focus |
|------------|--------------|
| responsibility | 单个模块或函数的职责边界是否清晰 |
| cohesion | 同一单元内的行为和数据是否共同服务一个目的 |
| coupling | 依赖数量、知识泄漏和跨模块协调成本是否合理 |
| dependency-direction | 依赖是否指向已批准的稳定边界 |
| abstraction-fit | 抽象是否匹配实际变化点，避免不足或过度抽象 |
| pattern-cost | 模式解决的问题、适用条件、成本和更简单替代是否相称 |
| change-locality | 同一业务变化是否能局部完成 |
| testability | 关键行为和失败路径能否被可靠观察与控制 |
| architecture-boundary | 实现是否遵守已批准架构，不在代码审查阶段首次重选重大架构 |

## 证据类型

blocker/major 可使用 `test`、`call-chain`、`state-transition`、`data-flow`、`specification-conflict` 或 `file-location`。命令和 `file:line` 是定位手段，不是唯一有效证据；证据必须能复现问题场景并解释影响。
