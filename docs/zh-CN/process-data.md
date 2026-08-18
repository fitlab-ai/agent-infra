# 过程数据归档

`ai data` 命令族把开发过程证据保存为只追加、可校验的快照。它采集本地任务工作区以及 GitHub 当前可见的 Issue 和 Pull Request 数据，不修改任何来源。

## 命令

```bash
ai data capture [--source all|local|github] [--root <dir>] [--include-excerpts]
ai data verify <snapshot-id> [--root <dir>]
ai data audit <snapshot-id> [--root <dir>] [--format json|text]
ai data repair <snapshot-id> [--root <dir>] [--apply]
ai data export <snapshot-id> [--root <dir>] [--repairs none|applied] [--output <file|->]
```

默认根目录为 `.agents/workspace/process-data/`。自定义根目录必须位于仓库内，且不能与任务目录重叠。退出码 `0` 表示成功或幂等 no-op，`1` 表示输入非法或完整性校验失败，`2` 表示必需来源不完整或被阻塞。

该默认目录属于宿主运行时状态。沙箱不会以可写方式挂载它，因此在沙箱内尝试写入默认路径会失败关闭。

`capture` 默认使用 `--source all`。只采集 local 或 GitHub 时，快照会明确标记为 partial，不得作为完整基线对外宣称。

## 存储与完整性

```text
process-data/
  objects/sha256/<prefix>/<digest>
  snapshots/YYYY/MM/DD/<snapshot-id>/
  repairs/<snapshot-id>/<repair-id>/
  .staging/
```

内容写入 SHA-256 CAS。采集先写 staging，只有全部必需来源完成后才通过一次文件系统 rename 发布快照。已有对象和快照会先校验再复用，绝不覆盖。

GitHub REST 数组使用 `per_page=100&page=N` 显式逐页请求。每个请求页记录条目数和 `canonicalSha256`。Canonical JSON 会递归排序对象键、保持数组顺序并对 UTF-8 字节计算哈希；它表达 JSON 语义，不冒充 HTTP 原始响应字节。空终止页计入请求和页证据，但不计入数据页。

`verify` 重算 manifest、对象、页面和字节数证据。`audit` 只有在校验通过后才读取确定性的质量基线。

## 隐私边界

任务产物和 GitHub allowlist 字段属于过程证据。凭据、私钥、Bearer token 和疑似凭据值会被排除；manifest 只保留其哈希、大小、策略规则和排除原因。

结构化遥测只来自 task Activity Log 与可识别的 delegation/orchestration receipt。Entropy 报告仍是普通运行报告。未知日志格式只产生 unknown observation，不猜测为遥测。

会话和工具正文默认 unavailable。`--include-excerpts` 仅表示显式允许保存限长、脱敏摘录，永远不授权保存内部思维或密钥材料。

## 对账与修复

质量发现区分本地/远端缺失、重复 identity、绑定冲突、内容差异、schema 差异、远端可变记录、不可恢复历史和隐私排除。

`ai data repair` 默认为 dry-run。只有关系唯一、证据完整且非敏感、前置条件固定时，`--apply` 才能追加 overlay。它不会 patch 或删除本地任务、GitHub 评论或 snapshot 对象；重复执行相同修复为 no-op。

使用 `ai data export ... --repairs applied` 将已验证 overlay 与规范记录合成导出，基础快照保持不变。

## 周期执行、备份与恢复

可在 cron 或 CI 中使用只读仓库凭据周期执行 capture 和 verify。退出码 `2` 表示观察不完整，不能当作成功基线。

默认根目录被 Git 忽略，并作为本机权威副本。校验和只能发现损坏，不能提供灾备。请使用独立加密备份和访问控制，按年月组织备份包，并定期恢复到临时仓库后执行 `ai data verify` 演练。
