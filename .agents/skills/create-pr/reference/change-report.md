# PR 代码增减报告

<!-- pr-change-report-contract
{"source":"platform-pr-inspect","diff":"three-dot-find-renames","metrics":["numstat-lines","git-blob-bytes"],"publish":["pr-summary","user-response"]}
-->

PR 创建或复用成功后，使用 `platform-pr inspect` 返回的权威 `base.sha` 与 `head.sha` 统计完整 PR 差异，不以最后一个 commit 或工作树状态代替。统计范围是目标分支 merge-base 到当前 PR HEAD。任务意图 digest 只覆盖 `# 任务`/`# Task` 到 `## 上下文`/`## Context` 的语义区间。

## 证据命令

```bash
node .agents/skills/create-pr/scripts/change-report.mjs --base {base-sha} --head {head-sha}
git diff --find-renames --name-status {base-sha}...{head-sha}
git diff --find-renames --summary {base-sha}...{head-sha}
```

将脚本 JSON 和模型生成的六项 precheck candidate 交给 typed core：

```bash
agent-infra-internal platform-pr change-report {task-id} \
  --agent {standard-agent-token} --mechanical-file {mechanical-report-file} \
  --precheck-file {precheck-candidate-file}
```

脚本输出作为 mechanical bundle 的 `full` diff。当前 bundle 使用 schema v3，持久化 canonical report 使用 schema v5；两者都只承载完整 PR merge-base→HEAD 比较。core 会校验任务意图 digest、PR identity、完整 patch SHA、统计合计和固定顺序的六项 precheck。任一项为 `needs-review` 时路由到 `review-code`，`formalReview` 仍为 `false`。

生成 candidate 前，先根据任务目标与完整 PR diff 列出功能变化组；不得把文件职责概述或类别总数当作功能组。每个功能组作为现有 `change-composition` 检查中的 typed `groups[]` 对象，包含 `id`、`target`、`behaviorChange`、`necessity`、`files[]`、`locations:{full:[]}` 和 `tests:{coverage,cost}`。`rationale`/`Evidence[]` 仅补充判断和定位，不能替代组对象。每个位置对象包含 canonical `path`、`side`（新增 `new` / 删除 `old`）、`startLine` 和 `endLine`。

- `files[]` 只能引用完整 PR 正式 diff 中的 canonical 文件路径（机械报告的 `oldPath ?? newPath`）；同一混合文件可出现在多个功能组。rename 仍作为一条机械记录保留 old/new 两端。
- `locations.full` 完整覆盖实际变更行。每个位置只能属于一个功能组，或列入 `unassigned:{full:[]}` 并注明 `reason=shared|unconfirmed` 与解释。core 拒绝重复、越界、方向/路径错误和遗漏，并按坐标派生组及未归属项的新增/删除数；并与完整 PR totals 对账。候选不得提交组级数字。
- binary 的 `numstat=null` 不生成位置；文件继续出现在文件和类别报告中，功能归因标明行数不可计，不得填零或虚构范围。
- 每条 `Evidence[].detail` 可引用具体代码、测试或文档变更；`tests.coverage` 与 `tests.cost` 分别说明覆盖风险/已有覆盖依据，以及本次新增 fixture / 测试的成本。没有测试变更时说明现有覆盖依据。

`target-alignment` 只有在每个功能组都能对应任务目标或验收标准时才能判为 `pass`。`change-composition` 的 typed 结构、文件集合和机械计数通过结构校验后，仍须按现有语义判断组别、行为增减、必要性、测试覆盖/成本和证据是否充分；结构或解释缺项、矛盾、无法核实时保持 `needs-review` 并说明缺口，使 core 路由到 `review-code`。不得因结构完整或 CI 通过而自动判定内容充分。

其他四项检查仍分别给出实际结论；证据详情遵循当前已部署技能的语言，中文技能必须使用中文。canonical renderer 会展示全部 rationale 和 evidence。源码行数只说明文本增删；不能据此推断执行次数或流程统一。

## 完整 PR 范围

完整 PR 统计使用当前权威 snapshot 的 `base.sha...head.sha` 和 three-dot mechanical report。类别统计表后紧接功能模块数字表，详细行为、必要性、文件和测试说明随后展示。renderer 从 core 校验后的结构化报告生成 canonical 内容。

脚本在 merge base 与 head 之间同时计算 `numstat` 行数和 Git blob 的精确字节数。字节比字符具有稳定口径，也能覆盖二进制文件和同行内缩减；子模块不是 blob，按 0 字节贡献核算。新增文件的旧字节数为 0，删除文件的新字节数为 0，纯 rename 的净字节数为 0，copy 只计新增目标内容。

`numstat` 中的二进制文件计入文件数，但不虚构行数。rename/copy 依据脚本的逐文件记录、`name-status` 与 `summary` 单独说明，避免把移动误报为整文件重写。

## 分类与核算

结合仓库实际结构，把每个文件唯一归入以下最贴近的类别；不适用的类别省略：

- 运行时代码
- 测试与测试辅助设施
- Skill / workflow / 协作规则
- 模板或生成镜像
- 文档
- 配置、依赖与其他

canonical 汇总中的固定分类把 `docs/`、Markdown/MDX/reStructuredText 文档与其他文件分别统计；更具体的运行时代码、测试、模板及 `.agents/` 分类优先。其余文件进入“其他”。

输出表格必须包含“部分、文件数、新增行、删除行、净增行、旧字节、新字节、净字节”，并有合计行。字节列表示本次变更涉及文件的 blob 内容体积，不表示整个仓库或工作树的磁盘占用。使用精确整数；可附加 KiB/MiB 便于阅读，但不能替代字节数。

各类别的行数和字节数之和必须分别与脚本的 `totals` 一致。随后仅针对文本文件，分别列出行数变化和绝对净字节变化最大的文件，并区分源码、测试和模板镜像；二进制文件只保留在分类合计中，不参与代表性文件排序或内容判断。rename 只按路径变化展示，不推断“纯 rename”。

## 分析要求

用简短结论回答：

- 增长主要集中在哪里，运行时代码与测试/文档/模板各占多少；
- 行数净变化与净字节变化是否给出不同结论，尤其指出同行内明显缩减或膨胀；
- 哪些行数只是路径迁移、双语镜像或机械同步；
- 是否存在与 PR 目标无法直接对应、疑似不必要的变化；若没有，明确说明判断依据；每项结论必须给出文件和行号证据；
- 若某个测试 fixture 明显大于生产改动，解释它覆盖的风险，而不是仅以行数评价。

调用方不要自行写入 `### PR 代码增减`。把恰好包含一次 `<!-- canonical-pr-change-report -->` 的普通摘要正文交给 `summary-sync --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json --result {primary-result}`，由 core renderer 替换并发布。报告不另建第二条 PR 评论。
