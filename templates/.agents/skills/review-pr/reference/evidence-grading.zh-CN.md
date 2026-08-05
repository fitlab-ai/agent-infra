# 证据分级参考

本文件固化 `review-pr` 的证据分级主决策流。判定全部由 typed core 纯函数（`lib/pr-review/evidence-grading.ts`）机械执行，skill 提示词层只做编排；本文件用于解释判据与理由，不替代 core。

## 主决策流

```text
解析 PR base/head 与关联 Issue/task（宿主解析）
   ├─ 唯一宿主 → 绑定任务，枚举 artifact 存在性 → 证据分类
   ├─ 多宿主歧义 → fail closed（decide 拒绝分类，要求人工指定）
   └─ 无宿主 → HDR-2 方案 A：默认阻塞要求关联；显式一次性检视 → reviews/{pr-number}/
        ↓
证据场景分类（S1/S2/S3）→ 新鲜度/对齐 → 风险分级 → 模式选择
```

## 宿主解析

- 唯一命中 → `unique`；多个且无法唯一 → `ambiguous`（候选列表）；零命中 → `none`。
- 多宿主歧义即 fail closed：不进入证据分类（AN-6），由 `pr-review-grade resolve-host --pr <N>` 返回 typed `HostResolution`，`decide` 对 `ambiguous` 显式拒绝。
- PR body 的 `Closes/Fixes #N`（大小写不敏感、逗号/空格分隔、支持列表）经 `extractClosingIssueNumbers` 解析；本地 `active/*/task.md` 的 `pr_number` 命中优先于 `issue_number` 反查，同一任务经两条路径命中按单候选去重。

## 证据场景分类（S1 → S2 → S3）

| 场景 | 判据 |
|------|------|
| S1 完整可信 | 唯一任务且 issue_number 与远端一致 + `analysis`/`plan`/`code` 及三族 review 齐全 + 最新 `pr-review*` 被审 head == 当前 head + 来源受信 |
| S2 部分/可疑 | 任务存在但 artifact 缺失关键产物，或 head 漂移，或来源不可信 / 无法证明与当前 head 对齐 |
| S3 仅 PR | 无宿主；或任务唯一但无任何生命周期 artifact 且无先前 `pr-review*` |

- S3(b) 判据（对称口径）：`!hasAnalysis && !hasPlan && !hasCode && !hasReviewAnalysis && !hasReviewPlan && !hasReviewCode && !hasPriorPrReview`。仅含任一 review 产物（review-analysis / review-plan / review-code）的畸形任务落 S2 → audit（PL-5/PL-9）。
- 首次审查（无先前 `pr-review*`）时 S1(c) 不满足，完整生命周期任务落入 S2 → audit（AN-7）。

## 新鲜度与对齐

- 新鲜度基准 = 上一轮 `pr-review*` 记录的被审 head SHA，与当前 head 逐字符比对：一致 → `fresh`，否则 → `stale`。
- 对齐 = freshness 为 fresh 且 `issue_number` / `pr_number` 与解析结果一致。
- 无先前 `pr-review*` → `n/a` / `n/a`（首轮特例）。

## 风险分级（纯证据口径）

| 因素 | LOW | HIGH |
|------|-----|------|
| 变更规模 | 文件少、净增行少 | 文件多、净增行大 |
| 变更敏感度 | 未触及受保护路径 | 触及 lifecycle / rule / skill / config / 安全 / 认证 / 幂等 / 并发路径 |
| 结构性变更 | 无 schema/frontmatter/迁移/接口契约变化 | 涉及 schema / frontmatter / 迁移 / 接口契约 |
| 测试覆盖 | 有配套测试且可通过 | 无测试或测试缺失/不可通过 |
| 证据来源可信度 | 存在可复核的受信生命周期且与当前 head 对齐 | 无受信记录，或来源不可复核 |
| 恢复/合并影响 | 不影响可恢复契约 | 可能破坏可恢复契约或形成双写真源 |

聚合：任一优先因素（敏感度 / 证据来源可信度）HIGH → HIGH；否则任一 HIGH → MEDIUM；全 LOW → LOW。身份因素不参与任何因素判定。

## 模式选择矩阵

| 证据场景 | 新鲜度/对齐 | 风险 | 模式 |
|----------|-------------|------|------|
| S1 | fresh + aligned | LOW/MEDIUM | verify（轻量复核） |
| S1 | fresh + aligned | HIGH | audit（证据审计） |
| S2 | stale / misaligned / 部分缺失 | 任意 | audit |
| S3 | n/a | 任意 | reconstruct（重建式审查） |

首次对完整生命周期任务运行 `review-pr` 因无先前 head 记录落入 S2 → audit；「已有可信生命周期记录 → verify」对应「存在上轮 `pr-review*` 且 head 未漂移」的再审查场景。

## 最低充分重建

模式为 `reconstruct`（或 `audit` 证据不足）时，在行级审查前形成重建记录，至少覆盖：需求边界、架构选择、影响面、验证覆盖；顺序保证「重建上下文 → 覆盖矩阵 → 行级 finding」。
