# 过程数据归档

`ai data` 把 GitHub 过程证据保存为只追加、可验证的快照。新的采集路径只收集 GitHub：本地任务文件、Activity Log 和 receipt 已经在本地规范化，不由该命令再次收集。

## 命令

```bash
ai data capture [--source github] [--root <dir>] [--full-reconcile]
ai data verify <snapshot-id> [--root <dir>]
ai data audit <snapshot-id> [--root <dir>] [--format json|text]
ai data repair <snapshot-id> [--root <dir>] [--apply]
ai data export <snapshot-id> [--root <dir>] [--as-of <ISO>] [--repairs none|applied] [--output <file|->]
```

`--source github` 是默认值。`--source local`、`--source all` 和 `--include-excerpts` 会失败关闭，不创建 data root、checkpoint 或 snapshot。历史 `raw-manifest/v1` 的 local、all、GitHub 快照仍可由 `verify`、`audit`、`repair` 和 `export` 读取。

## 观察边界与 lineage

第一次成功采集生成 `base` 快照，后续采集生成沿单父节点连接的 `delta` 快照，并在 `checkpoints/github/` 保存 checkpoint。只有 CAS 写入、快照发布和校验全部成功后，checkpoint 才会推进。

每轮先执行 GitHub response `Date` 预检，形成观察截止点 `F`。对官方契约明确支持严格 `since` 的 endpoint，增量请求使用 `W - 1 秒`，客户端接纳 `[W, F)` 内的对象；一秒边界重读保证 checkpoint 起点不因严格 after 语义被漏掉。早于 `W` 的对象只作为 overlap 证据，`>= F` 的对象延后到下一轮。没有正式 `since` 契约的 endpoint（包括 issue timeline）完整分页。

HTTP `Date`、页面证据和 checkpoint 只证明本轮观察请求及本地 lineage，不声称 GitHub 在 `F` 前已经暴露全部历史对象。使用 `--full-reconcile` 可对所有 endpoint 做不带 `since` 的完整枚举并纠正延迟可见对象；持续调度不属于本任务。

## 存储与校验

```text
process-data/
  objects/sha256/<prefix>/<digest>
  snapshots/YYYY/MM/DD/<snapshot-id>/
  checkpoints/github/<repository-key>.json
  repairs/<snapshot-id>/<repair-id>/
  .staging/
```

页面证据和资源对象分别写入 CAS。页面 hash 用于证明分页和请求 metadata；增量相等性只比较资源 hash，资源 identity 不包含页码。Issue、Pull Request、评论、Review、commit 和 timeline event 都经过 allowlist 投影。

`verify` 校验 manifest hash、lineage、观察窗口算术、查询证据、操作计数、规范记录和 CAS 对象，但不会把 HTTP `Date` 提升为完整性证明。`export --as-of` 只物化已验证且 observation watermark 不晚于目标时间的 v2 lineage。

## 隐私、恢复与修复

敏感 GitHub 文本按策略排除，repair 不会恢复原文。网络、权限、identity、时间缺失、观察边界和分页失败都会在推进 checkpoint 前停止。checkpoint 锁采用同机单写者和 owner 绑定；owner 不明或恢复候选有歧义时失败关闭。

`ai data repair` 仍然只追加，不删除来源记录或快照。`--apply` 只有在前置条件固定时才写入已验证 overlay。历史 v1 overlay 继续可用，且不会改写 v1 数据。
