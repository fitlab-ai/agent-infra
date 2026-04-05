---
name: archive-tasks
description: "归档已完成任务到按日期组织的目录"
---

# 归档已完成任务

将 `.agents/workspace/completed/` 中的已完成任务移动到 `.agents/workspace/archive/YYYY/MM/DD/TASK-xxx/`，并重建三级归档索引：
- 根 manifest：`.agents/workspace/archive/manifest.md`
- 年 manifest：`.agents/workspace/archive/YYYY/manifest.md`
- 月 manifest：`.agents/workspace/archive/YYYY/MM/manifest.md`

## 执行流程

### 1. 验证环境

确认 `.agents/workspace/completed/` 存在，并根据用户输入选择以下四种调用方式之一：
- 无参数：归档全部已完成任务
- `--days N`：保留最近 `N` 天，仅归档更早的任务
- `--before YYYY-MM-DD`：仅归档指定日期之前的任务
- `TASK-ID...`：仅归档指定任务

### 2. 运行归档脚本

执行以下命令：

```bash
bash .agents/skills/archive-tasks/scripts/archive-tasks.sh [--days N | --before YYYY-MM-DD | TASK-ID...]
```

脚本负责：
- 解析 `task.md` frontmatter 中的 `completed_at`（缺失时回退到 `updated_at`）
- 按 `YYYY/MM/DD/TASK-xxx/` 目录直接移动任务，不压缩
- 跳过已归档、缺少元数据或不存在的任务
- 全量重建根 / 年 / 月三级 manifest
- 输出归档与跳过摘要

### 3. 告知用户

向用户汇报：
- 本次归档的任务数量
- 跳过的任务数量和原因
- 根 manifest 的路径
