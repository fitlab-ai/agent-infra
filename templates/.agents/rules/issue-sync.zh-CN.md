# Issue 同步

## Marker 注册表

以下隐藏标记是 Issue 同步的唯一权威注册表：

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

Skill 正文应引用 marker key，具体 marker 字符串只保留在本规则或平台适配器默认值中。

当前代码平台未内置 Issue 同步支持。

自定义平台会跳过 Issue 元数据、标签、里程碑、负责人和评论同步，除非你提供匹配的 `.{platform}.zh-CN.md` 规则模板和平台适配器。请继续正常写入本地任务产物。
