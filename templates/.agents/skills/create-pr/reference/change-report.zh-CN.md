# PR 代码增减报告

<!-- pr-change-report-contract
{"source":"platform-pr-inspect","diff":"three-dot-find-renames","metrics":["numstat-lines","git-blob-bytes"],"publish":["pr-summary","user-response"]}
-->

PR 创建或复用成功后，使用 `platform-pr inspect` 返回的权威 `base.sha` 与 `head.sha` 统计完整 PR 差异，不以最后一个 commit 或工作树状态代替。

## 证据命令

```bash
node .agents/skills/create-pr/scripts/change-report.mjs --base {base-sha} --head {head-sha}
git diff --find-renames --name-status {base-sha}...{head-sha}
git diff --find-renames --summary {base-sha}...{head-sha}
```

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

各类别的行数和字节数之和必须分别与脚本的 `totals` 一致。随后分别列出行数变化和绝对净字节变化最大的文件，并区分源码、测试、模板镜像和纯 rename。

## 分析要求

用简短结论回答：

- 增长主要集中在哪里，运行时代码与测试/文档/模板各占多少；
- 行数净变化与净字节变化是否给出不同结论，尤其指出同行内明显缩减或膨胀；
- 哪些行数只是路径迁移、双语镜像或机械同步；
- 是否存在与 PR 目标无法直接对应、疑似不必要的变化；若没有，明确说明判断依据；
- 若某个测试 fixture 明显大于生产改动，解释它覆盖的风险，而不是仅以行数评价。

将完整报告以 `### PR 代码增减` 段落写入 reviewer 摘要正文，并在 create-pr 的用户可见完成回复中原样保留同一张统计表与结论。不要把报告另建成第二条 PR 评论。
