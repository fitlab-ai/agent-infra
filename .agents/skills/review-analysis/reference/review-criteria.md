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

## 需求分析专项覆盖

### 角色视角

每轮必须逐项检视以下最低视角，并在报告中使用稳定的 `perspective_id`：

- `user`：业务目标、使用结果、非目标和验收
- `maintainer`：维护边界、依赖、兼容性和长期责任
- `operations`：部署、运行、可观测性、恢复和支持约束
- `security`：信任边界、权限、数据和滥用风险
- `testing`：可观察的输入、动作、结果、边界条件和验证环境

适用视角记录实际范围、证据和 `covered/gap`；`not-applicable` 必须附可复核依据，否则视为 gap。若任务来源或风险证据出现其他利益相关者，追加稳定 token；不要把可能角色扩张成固定全集。

### 质量属性

只记录由来源、约束或角色视角实际触发的质量属性，不使用固定名词全集。每项需有稳定 `quality_id`、来源与利益相关者、优先级或权衡状态、可验证表达及 `covered/gap`。缺少来源的候选项只能作为假设、开放问题或非阻塞建议，不能作为已确认需求。

### 演进场景

合理未来变化需有稳定 `evolution_id`、来源、`confirmed/unconfirmed` 状态、`design-input/assumption/open-question` 分类、边界证据及 `covered/gap`。`unconfirmed` 场景不得升级为当前需求，也不得直接驱动架构或实现选择。

### 验收标准

逐项记录稳定 `acceptance_id`、可观察输入、审查动作、预期结果和 `verifiable/open/gap`。非行为型约束可用可观察验证方式替代行为步骤；无法闭环时必须进入开放问题或 finding。

### 追踪与边界

共享追踪矩阵仍是来源到分析结论的唯一映射。其 `source_id` 应覆盖用户请求、Issue、任务事实/决策和验收标准；专项表通过来源或证据回指这些稳定标识。本阶段只判断分析是否足以进入设计，不选择架构风格、设计模式或实现技术，也不复制共享五遍协议和 finding 证据字段。

## 共享方法与分类边界

先读取 `.agents/rules/review-method.md`，按其五遍协议、风险镜头和 finding 证据契约执行；finding、manual-validation、advisory 与 `needs-human-decision` 的状态语义以 `.agents/rules/review-handshake.md` 为准。本文件只补充需求分析阶段的专项判断。

同时检查最新需求分析产物和 `task.md` Activity Log，确保报告反映完整的分析上下文。
