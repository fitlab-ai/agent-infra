# PR 代码增减报告

<!-- pr-change-report-contract
{"version":1,"source":"platform-pr-inspect","diff":"three-dot-find-renames-numstat","publish":["pr-summary","user-response"]}
-->

PR 创建或复用成功后，使用 `platform-pr inspect` 返回的权威 `base.sha` 与 `head.sha` 统计完整 PR 差异，不以最后一个 commit 或工作树状态代替。

## 证据命令

```bash
git diff --find-renames --numstat {base-sha}...{head-sha}
git diff --find-renames --name-status {base-sha}...{head-sha}
git diff --find-renames --summary {base-sha}...{head-sha}
```

`numstat` 中的二进制文件计入文件数，但不虚构行数。rename/copy 依据 `name-status` 与 `summary` 单独说明，避免把移动误报为整文件重写。

## 分类与核算

结合仓库实际结构，把每个文件唯一归入以下最贴近的类别；不适用的类别省略：

- 运行时代码
- 测试与测试辅助设施
- Skill / workflow / 协作规则
- 模板或生成镜像
- 文档
- 配置、依赖与其他

输出表格必须包含“部分、文件数、新增、删除、净增”，并有合计行。各类别之和必须与完整 `numstat` 总计一致。随后列出增减最大的文件，并区分源码、测试、模板镜像和纯 rename。

## 分析要求

用简短结论回答：

- 增长主要集中在哪里，运行时代码与测试/文档/模板各占多少；
- 哪些行数只是路径迁移、双语镜像或机械同步；
- 是否存在与 PR 目标无法直接对应、疑似不必要的变化；若没有，明确说明判断依据；
- 若某个测试 fixture 明显大于生产改动，解释它覆盖的风险，而不是仅以行数评价。

将完整报告以 `### PR 代码增减` 段落写入 reviewer 摘要正文，并在 create-pr 的用户可见完成回复中原样保留同一张统计表与结论。不要把报告另建成第二条 PR 评论。
