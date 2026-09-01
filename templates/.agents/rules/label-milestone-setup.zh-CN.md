# Label 和 Milestone 初始化

在初始化 label、milestone，或在发布工作中修改 milestone 元数据前，先阅读本规则。

## 入口

SKILL 应调用共享脚本，不得自行拼装 provider 命令：

```text
bash .agents/skills/init-labels/scripts/init-labels.sh [--cleanup-stale-in]
bash .agents/skills/init-milestones/scripts/init-milestones.sh "$ARGUMENTS"
```

`init-labels.sh` 读取仓库的 `labels.in` 配置，创建或更新声明的 `in:` label，并保留无关 label。`--cleanup-stale-in` 具有破坏性，只有在得到明确确认后才能传入；它会删除不再声明的过期 `in:` label。

`init-milestones.sh` 负责 milestone 推断和 provider 写入路径。调用方应原样传递请求参数，不得重新实现 milestone 发现、排序、分支祖先判断或写入逻辑。

两个脚本都返回稳定状态。成功的 no-op 仍算成功；degraded 结果必须如实报告，不能声称远端元数据已变更。失败或取消的操作不得报告为已完成。
