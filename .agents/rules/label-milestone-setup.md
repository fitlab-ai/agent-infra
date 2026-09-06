# Label 和 Milestone 初始化

在初始化 label、milestone，或在发布工作中修改 milestone 元数据前，先阅读本规则。

## Runtime intent 入口

SKILL 应调用内部 runtime intent，不得自行拼装平台命令：

```text
agent-infra-internal platform-metadata init-labels [--cleanup-stale-in]
agent-infra-internal platform-metadata init-milestones [--history]
```

`init-labels` runtime intent 读取仓库的 `labels.in` 配置，创建或更新声明的 `in:` label，并保留无关 label。`--cleanup-stale-in` 具有破坏性，只有在得到明确确认后才能传入；它会删除不再声明的过期 `in:` label。

`init-milestones` runtime intent 负责 milestone 规划和结果报告。调用方应原样传递请求参数，不得重新实现 milestone 发现、排序或写入逻辑。

两个 intent 都返回稳定状态。成功的 no-op 仍算成功；degraded 结果必须如实报告，不能声称远端元数据已变更。失败或取消的操作不得报告为已完成。
