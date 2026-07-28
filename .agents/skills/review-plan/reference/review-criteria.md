# 审查标准

在审查技术方案或划分问题严重程度之前先读取本文件。

## 执行技术方案审查

遵循 `.agents/workflows/feature-development.yaml` 中的 `design-review` 步骤。

**必查范围**：
- [ ] 方案是否覆盖已批准的需求分析
- [ ] 实现步骤是否具体、顺序合理且可验证
- [ ] 架构边界、数据流和接口变化是否清晰
- [ ] 测试策略是否覆盖关键路径、回归风险和边界情况
- [ ] 风险、迁移、回滚或兼容性处理是否充分
- [ ] 方案是否避免过度设计和无关扩张
- [ ] 已复核执行方是否漏标应升级为 `[needs-human-decision]` 的关键设计决策
- [ ] 本轮所有 `needs-human-decision` 详情均符合 `.agents/rules/human-decision-context.md` 的自足结构
- [ ] 每条 blocker 都配可复现的 grep/sed/nl 证据，未直接验证的结论已在「自我质疑」声明

**常见反例**：
- 方案只写“修改相关代码”，没有可执行步骤和验证点
- 设计没有回应分析中列出的风险或约束
- 为单次需求引入不必要的新抽象、配置或框架
- 凭印象或记忆断言 `file:line`/行为，没有用 rg/nl 复核就下结论

## 共享方法与分类边界

先读取 `.agents/rules/review-method.md`，按其五遍协议、风险镜头和 finding 证据契约执行；finding、manual-validation、advisory 与 `needs-human-decision` 的状态语义以 `.agents/rules/review-handshake.md` 为准。本文件只补充技术方案阶段的专项判断。

同时检查最新技术方案产物、最新需求分析审查产物和 `task.md` Activity Log，确保报告反映完整的设计上下文。

## 技术方案架构专项覆盖

每轮先用可定位证据记录 `architecture-significance` 分类。以下任一项发生实质变化即分类为 `architecture-significant`：

- 职责或组件边界；
- 跨组件数据流或控制流；
- 公开接口或兼容接口；
- 数据所有权或持久化；
- 部署或运维拓扑；
- 信任边界；
- 优先质量属性之间的权衡；
- 高成本或不可逆决策。

未命中时分类为 `ordinary`，使用 `proportional` 深度，只记录分类证据以及 Mini-ATAM `not-applicable` 的可复核理由。命中时使用 `mini-atam` 深度并完成以下检视：

1. 从已批准需求和约束追踪业务驱动及有来源的优先质量属性。
2. 为质量属性场景记录 stimulus、context、expected response 和可验证 measure。
3. 对所选架构决策与至少一个合理替代方案比较 benefit、cost、assumption 和 rejection reason；不得以架构风格或设计模式数量代替适配性判断。
4. 识别风险、敏感点及质量属性间的 trade-off，并记录缓解或验证方式。
5. 将关键决策标记为 `two-way` 或 `one-way`，记录逆转成本以及迁移或回滚路径。
6. 逐项考虑 `evolution`、`migration`、`rollback`、`compatibility`、`operations` 场景，并映射影响范围、验证方式和持续验证入口。

不适用的生命周期场景必须写 `not-applicable` 及证据。`unconfirmed` 的未来场景不得升级为当前硬性需求。`one-way` 只描述可逆性；只有同时满足既有来源测试和影响测试时，才升级为 `needs-human-decision`。
