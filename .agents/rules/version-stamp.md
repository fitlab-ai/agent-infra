# 通用规则 - agent-infra 版本戳

## 写入时机

每次创建或更新 `task.md` frontmatter 时，同步写入 `agent_infra_version`。

该字段表示最后一次写入该任务元数据的 `agent-infra` CLI 版本，与 `updated_at` 同步刷新。

## 取值命令

```bash
agent_infra_version=$(ai version --raw 2>/dev/null || echo "unknown")
```

- 命令成功时，值必须直接使用输出结果，例如 `vX.Y.Z` 或 `vX.Y.Z-alpha.0`
- 不要在写入端自行拼接 `v` 前缀
- 命令失败时写入 `unknown`

## frontmatter 字段

```yaml
agent_infra_version: {agent_infra_version}
```

## 兼容性

- 历史任务可能缺少该字段；读取或恢复任务时不得因此阻塞
- 字段存在时，值必须是 `vX.Y.Z`、`vX.Y.Z-prerelease`、带 SemVer build 元数据的版本，或 `unknown`
- 同步 Issue / PR 评论时无需额外处理；frontmatter 镜像会自然包含该字段
