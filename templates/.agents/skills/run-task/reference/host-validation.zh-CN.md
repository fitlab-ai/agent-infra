# 宿主契约验证

发布支持某个客户端前，必须用真实宿主事件证明生命周期证据链；bridge 单测只证明字段映射，不能证明事件来自宿主。

## 必须证明的字段

- 客户端版本、启用的多代理能力、启动入口与信任边界。
- 原始 start/stop 事件能稳定给出 event type、managed agent、parent/child identity、fresh spawn mode、actual model 和 actual reasoning effort。
- 显式 requested model/effort 能传给 executor/reviewer；宿主对任一字段回退时，事件能给出对应 actual 值与独立的非空 fallback reason。
- candidate checkout 与打包安装后的行为一致，且模型策略、receipt 与验证结果可从 `orchestration.json` 复核。

## 验证顺序

1. 在干净临时仓库记录客户端版本、feature 状态和启动命令。
2. 分别启动 fresh executor 与 fresh reviewer，保存去敏后的原始 stdin 和结构化 run；不得补写宿主未产生的字段。
3. 分别验证 model/effort 的 requested/actual 一致路径、单项与双项有理由 fallback 路径，并确认缺 actual 字段会失败关闭。
4. 对同一 commit 执行 candidate checkout 与 `npm pack` 安装验证，记录 tarball 哈希和结果。
5. 仅把去敏摘要与非敏感 fixture 纳入版本库；token、绝对用户路径、transcript 内容和凭证必须删除或替换。

任一字段无法从真实宿主稳定观察时，该客户端的 orchestration capability 保持 `unsupported`，并把缺口记录为人工验证项。
