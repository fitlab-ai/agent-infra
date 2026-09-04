# PR 代码增减报告

<!-- pr-change-report-contract
{"source":"platform-pr-inspect","diff":"three-dot-find-renames","metrics":["numstat-lines","git-blob-bytes"],"publish":["pr-summary","user-response"]}
-->

PR 创建或复用成功后，使用 `platform-pr inspect` 返回的权威 `base.sha` 与 `head.sha` 统计完整 PR 差异，不以最后一个 commit 或工作树状态代替。任务意图 digest 只覆盖 `# 任务`/`# Task` 到 `## 上下文`/`## Context` 的语义区间，因此生命周期日志、收据和版本元数据不会使同一 head 的 sidecar 失效。

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

core 校验任务意图 digest、PR identity、完整 patch SHA、统计合计和固定顺序的 `target-alignment`、`change-composition`、`compatibility-policy`、`legacy-path-cleanup`、`redundancy`、`scope-discipline`。任一项为 `needs-review` 时路由到 `review-code`，`formalReview` 仍为 `false`。

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

输出表格必须包含“部分、文件数、新增行、删除行、净增行、旧字节、新字节、净字节”，并有合计行。字节列表示本次变更涉及文件的 blob 内容体积，不表示整个仓库或工作树的磁盘占用。使用精确整数；可附加 KiB/MiB 便于阅读，但不能替代字节数。

各类别的行数和字节数之和必须分别与脚本的 `totals` 一致。随后仅针对文本文件，分别列出行数变化和绝对净字节变化最大的文件，并区分源码、测试和模板镜像；二进制文件只保留在分类合计中，不参与代表性文件排序或内容判断。rename 只按路径变化展示，不推断“纯 rename”。

## 分析要求

用简短结论回答：

- 增长主要集中在哪里，运行时代码与测试/文档/模板各占多少；
- 行数净变化与净字节变化是否给出不同结论，尤其指出同行内明显缩减或膨胀；
- 哪些行数只是路径迁移、双语镜像或机械同步；
- 是否存在与 PR 目标无法直接对应、疑似不必要的变化；若没有，明确说明判断依据；每项结论必须给出文件和行号证据；
- 若某个测试 fixture 明显大于生产改动，解释它覆盖的风险，而不是仅以行数评价。

调用方不要自行写入 `### PR 代码增减`。把恰好包含一次 `<!-- canonical-pr-change-report -->` 的普通摘要正文交给 `summary-sync --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json --result {primary-result}`，由 core renderer 替换并发布。报告不另建第二条 PR 评论。
