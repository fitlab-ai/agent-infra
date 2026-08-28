# 通用检视方法

本规则定义 `analysis`、`plan` 和 `code` 三个审查阶段共用的轻量检视协议。阶段专属检查项留在各 skill 的 `reference/review-criteria.md`；finding 状态机、人工裁决和账本写入继续以 [review-handshake.md](review-handshake.md) 为准；风险镜头只承载命中某类风险后必须加载的专项 reference。

## 职责边界

- 本规则规定审查顺序、证据形状和完成条件，不复制阶段 checklist。
- 风险镜头由可观察证据触发；命中后必须读取全部对应 reference，并在报告留证。
- 自动化检查提供事实，reviewer 负责完整性、影响、严重度、置信度和反证等语义判断。
- 报告结构证明审查声明可追溯，不等于自动证明语义判断正确。

## Readiness

形成候选 finding 前必须确认：

1. 任务、输入 artifact、上游来源和审查范围已解析且可读。
2. skill 要求的状态快照、差异或其他事实证据已捕获。
3. 本轮实际审查的 artifact、基线和上下文边界可在报告中准确标识。

任一前置项缺失时，不得给出通过结论；按所属 skill 的阻塞或失败路径处理。

## 多遍检视协议

按顺序执行以下五遍；每遍都在报告的检视覆盖表中记录范围、证据、结果与缺口/假设。

1. **Pass 1 — 原始证据**：先读任务来源、上游 artifact、变更和测试等原始证据，独立形成候选问题，避免被执行方摘要锚定。
2. **Pass 2 — 追踪与边界**：建立来源—需求—方案—实现—测试追踪，识别遗漏、断链和意外范围扩张。
3. **Pass 3 — 风险镜头**：依据完整上下文逐项判断注册表触发器，加载所有命中的专项 reference，并记录命中证据与结果。
4. **Pass 4 — 反证**：主动寻找能推翻或降级每个候选 finding 的证据，并检查放行结论可能失败的反例。
5. **Pass 5 — 归类与收敛**：将问题归为 finding、manual-validation 或 advisory，核对证据契约、账本意图、未验证假设和 verdict。

## 风险镜头注册表

注册行使用稳定字段：`lens_id` 标识镜头，`stages` 限定阶段，`observable_trigger` 给出可观察触发条件，`required_reference` 是命中后必读路径，`report_evidence` 规定报告留证。

| lens_id | stages | observable_trigger | required_reference | report_evidence |
|---------|--------|--------------------|--------------------|-----------------|
| compatibility-budget | analysis, plan, code | 需求、方案或实现新增、延长、迁移或删除旧行为、旧 schema、旧入口、alias、adapter、wrapper、shim、双写或兼容读取 | `.agents/rules/compatibility-policy.md` | 记录兼容对象、必要性、期限、退出条件，或确认 current-only |
| documentation-antipatterns | code | 完整变更上下文触及描述当前行为的 Markdown、规则、skill、CLI 帮助或用户文档 | `.agents/skills/review-code/reference/documentation-antipatterns.md` | 记录触发文件、`loaded=yes` 与检视结果 |
| testing-discipline | code | 完整变更上下文触及测试、fixture、snapshot 或测试 helper | `.agents/rules/testing-discipline.md` | 记录触发文件、`loaded=yes` 与测试纪律结论 |
| security-risks | code | 认证授权、非可信输入、敏感数据、凭据、加密、依赖或系统边界发生变化 | `.agents/skills/review-code/reference/security-risks.md` | 记录安全边界变化、`loaded=yes` 与检视结果 |
| migration-risks | code | 持久化格式、schema、配置/frontmatter、兼容读取或迁移/回滚发生变化 | `.agents/skills/review-code/reference/migration-risks.md` | 记录兼容或迁移触发证据、`loaded=yes` 与检视结果 |
| concurrency-risks | code | 异步协调、共享状态、锁、重试、幂等、竞态、取消或超时发生变化 | `.agents/skills/review-code/reference/concurrency-risks.md` | 记录并发触发路径、`loaded=yes` 与检视结果 |
| cross-platform-risks | code | OS 分支、路径、shell、权限、符号链接、换行、信号或跨平台行为发生变化 | `.agents/skills/review-code/reference/cross-platform-risks.md` | 记录平台触发证据、`loaded=yes` 与检视结果 |

未命中镜头也必须记录可复核的未命中证据。`loaded` 只使用 `yes`、`no`、`not-applicable`；命中但未加载时不得给出通过结论。

## 自动化与语义判断

| 来源 | 可支持的事实 | 不可替代的语义判断 |
|------|--------------|--------------------|
| snapshot、diff、link、test、artifact gate | 文件、范围、命令结果、引用存在、章节存在 | 需求是否完整、设计是否合理、实现是否正确 |
| 追踪矩阵 | 显式映射及可见缺口 | 映射是否充分、缺口影响和优先级 |
| 风险镜头记录 | 触发证据、加载状态、专项结果入口 | 风险是否可接受、finding 严重度与置信度 |

自动化结果与语义结论冲突时，报告必须分别记录事实与推理，不得把结构 gate 的通过写成语义完整性的证明。

## 上下文覆盖与追踪契约

报告必须包含两张覆盖表：

| pass_id | scope | evidence | result | gaps_or_assumptions |
|---------|-------|----------|--------|---------------------|
| pass-1..5 | 本遍实际覆盖范围 | 可定位的 artifact、文件、命令或行号 | 发现或结论 | 未覆盖项、缺口或假设 |

| lens_id | trigger_evidence | loaded | result |
|---------|------------------|--------|--------|
| 注册表 token | 命中或未命中的可复核证据 | yes / no / not-applicable | 专项检视结论 |

并包含统一追踪矩阵：

| source_id | upstream | reviewed_target | verification | status_or_gap |
|-----------|----------|-----------------|--------------|---------------|
| 稳定来源标识 | 上游需求、决策或步骤 | 本阶段被审对象 | 自动化或人工证据 | covered / gap 及影响 |

analysis 阶段追踪来源到需求、验收、影响和风险；plan 阶段追踪已批准需求到设计决策、步骤和测试策略；code 阶段追踪需求/方案到 diff 与自动化测试或人工校验。

## Finding 证据契约

每个 blocker 或 major finding 必须包含：

1. **场景**：触发问题的前置条件和路径。
2. **影响**：对正确性、安全、交付或验收的具体后果。
3. **证据**：可复现的 artifact、`file:line`、命令和原始结果。
4. **置信度**：稳定 token `high`、`medium` 或 `low`。
5. **未验证假设**：尚未直接证明、若被推翻会改变结论的假设；没有则明确写无。
6. **修复方向**：可执行的最小修复目标，不替执行方越权重设计。

minor 保持轻量，但仍须提供具体位置和可执行建议。finding ledger 的 `evidence` 继续指向报告中的稳定锚点，不新增账本字段。manual-validation、advisory 和 `needs-human-decision` 按 review handshake 与阶段规则处理。

## Completion

只有同时满足以下条件才可形成最终 verdict：

- 五遍检视均已记录范围、证据、结果和缺口/假设。
- 所有风险触发器均有命中判断，命中镜头均已加载并留证。
- 追踪矩阵覆盖本阶段职责，缺口已进入 finding、manual-validation、advisory 或明确假设。
- 所有 blocker/major 满足统一证据契约，候选 finding 已完成反证检视。
- 账本意图、人工校验、待裁决项、未验证假设与问题计数一致。
