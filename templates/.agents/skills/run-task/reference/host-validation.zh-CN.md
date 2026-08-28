# 宿主契约验证

发布支持某个客户端前，必须用真实宿主事件证明生命周期证据链；bridge 单测只证明字段映射，不能证明事件来自宿主。

## 必须证明的字段

- 客户端版本、启用的多代理能力、启动入口与信任边界。
- 原始 start/stop 事件，或 custom role 缺少它们时的 parent PostTool spawn/completed-wait fallback，能稳定关联 managed agent、parent/child identity、fresh spawn mode、actual model 和 actual reasoning effort。
  > 结构上不提供 fork/spawn-mode 事件字段的 direct-host 客户端（当前为 claude-code），身份关联允许仅由 parent/child identity 的唯一性与一次性状态机提供，不要求额外的 fresh spawn mode 证明；该客户端仍需如实记录这一缺口与替代保证的构成，不得补造 spawn mode 证据。此例外不适用于其他客户端。具体而言，claude-code 的身份保证仅由 `parentId`/`childId` 非空且互不相等、同一 run 内 `childId` 唯一、receipt 一次性状态机三者提供，不含 codex 式的 `spawn_mode` fork 证明，强度弱于 codex。
- 显式 requested model/effort 能传给 executor/reviewer；宿主对任一字段回退时，事件能给出对应 actual 值与独立的非空 fallback reason。
  > claude-code 例外：requested reasoning effort 暂不支持按角色下发给 executor/reviewer——`.claude/agents/{executor,reviewer}.md` 是仓库级共享单例，动态写入存在跨任务竞态，解决该竞态超出本任务范围。该客户端只要求如实记录宿主原生 Start/Stop 事件中能观察到的 actual model/actual reasoning effort（`delegationEvidence.actualReasoningEffort` 声明为 `spawn-ack`）；观察不到时记录为缺失，不视为需要独立 fallback reason 的回退场景，也不构成 fail-closed 阻断。此例外不适用于其他客户端。
- candidate checkout 与打包安装后的行为一致，且模型策略、receipt 与验证结果可从 `orchestration.json` 复核。
- direct-host 与 sandbox controller 使用的 hook/profile 必须来自受信来源；build/contract/profile 内容在跨根比较中允许漂移并输出可操作 warning，但 controller/task/process/lease 与 receipt 内 hook/evidence binding 仍须在 prepare/start/stop/consume 全链路一致。

## 验证顺序

1. 在干净临时仓库记录客户端版本、feature 状态和启动命令。
2. 分别启动 fresh executor 与 fresh reviewer，保存去敏后的原始 stdin 和结构化 run；同时验证原生 start/stop 与 parent PostTool fallback。timed-out wait 必须无动作；不得补写宿主未产生的字段。
3. 分别验证 model/effort 的 requested/actual 一致路径、单项与双项有理由 fallback 路径，并确认缺 actual 字段会失败关闭；对 package/build/contract 或 hook/profile 内容漂移确认只产生可操作 warning，并提示用户重建 sandbox。
4. 对同一 commit 执行 candidate checkout 与 `npm pack` 安装验证，记录 tarball 哈希和结果。
5. 仅把去敏摘要与非敏感 fixture 纳入版本库；token、绝对用户路径、transcript 内容和凭证必须删除或替换。
6. sandbox backend 另做至少 10 次 executor 与 10 次 reviewer 冷启动，记录 prepared、spawn dispatch、SubagentStart、activation completed 的单调时钟及 p50/p95/max；仅当 max 加 20% 余量不超过 deadline，并通过 symlink/config/plugin/lease/context/build 失败注入和终态清理审计时启用。

任一字段无法从真实宿主稳定观察时，该客户端的 orchestration capability 保持 `unsupported`，并把缺口记录为人工验证项。Codex 可声明为 `experimental`，但每次 `prepare` 仍必须通过静态 preflight，且原生 start/stop 或 parent spawn/completed-wait fallback 必须形成可验证的 consumed host evidence。fallback 只允许 empty turns/协议 `inProgress` 等待；malformed、身份/传输错误或异常 terminal 都稳定暂停。上述关于 claude-code 的例外已在第 2 条单独说明，不改变本条对其余字段/客户端的 fail-closed 要求。
