# 决策资格与约束审计

涉及“是否需要人工裁决”的分析、方案、实现或审查，必须先基于 `task.md` 的规范化约束和候选表完成资格审计，再决定是否创建 `HD-N`。

## 唯一事实源

- `task.md` 的 `### 约束` 和 `### 候选与否决方案` 是唯一约束/候选事实源。
- 约束表必须使用 `constraint_id`、`statement`、`status`、`authority`、`source`、`evidence`、`derived_from`、`approval_evidence`；候选表必须使用 `candidate_id`、`statement`、`status`、`constraint_ids`、`impact`、`evidence`。
- 六类阶段产物都要在 `## 资格审计` 中声明实际约束依赖、候选资格、分类结果、上游关系和依赖快照。上游关系必须保存 artifact 的 family、文件名、round 和 SHA-256。

## 状态与确认

- `confirmed` 约束必须有来源证据、当前语义 digest 和 `资格确认记录`；旧 digest 的确认不能复用。
- `derived`、`assumption`、`open`、`conflicted`、`superseded` 只能作为待审事实，不能自动排除候选。
- 内部 proposal 入口只能写入非 confirmed 约束和 `pending` 候选，不能写 actor、QCR、confirmed 或 approval 字段。
- `ai qualify` 是流程声明式人工确认、替代和撤销入口；`human-declared` 是审计标签，不是身份认证。确认时 QCR 由核心生成并绑定确认写入后的当前单约束 digest、request id、时间和单行理由；替代与撤销分别把约束转为 `superseded` 与 `open`，清空当前 approval evidence，并保留历史 QCR。

## 失效与审查

约束变化时，只有声明受影响 `C-N` 的 artifact 才能成为直接失效种子，并沿真实上游关系的下游闭包传播；六类 artifact（含 review）对等处理。快照、关系图或变化分类无法证明为纯约束变化时，回退既有全量失效路径。新完成的 source artifact、自身 receipt 和派生快照不作为旧图目标。

缺失、未知引用、digest 不匹配、悬空关系或环都必须 fail closed。排版变化不应改变语义 digest；语义、来源、状态、候选或上游 identity 变化必须触发重新审计。
