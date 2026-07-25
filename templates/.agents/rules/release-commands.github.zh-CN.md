# Release 平台命令

发布说明平台操作统一使用 typed internal intent。调用方只解释结构化 JSON，不解析平台命令、原始字段、身份邮箱规则或认证错误。

## 收集发布说明上下文

```bash
agent-infra-internal platform-release-notes context \
  --from-tag "v{prev-version}" --to-tag "v{version}" \
  --branch "{branch}" --history-limit 3
```

结果包含历史发布、PR、关联 Issue 和规范化贡献者身份。不支持的平台返回稳定的 `PLATFORM_RELEASE_NOTES_UNSUPPORTED` no-op。

## 发布 Release notes

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v{version}" --title "v{version}" --notes-file "{notes-file}"
```

命令更新既有 Release，缺失时创建；`--dry-run` 只规划操作。退出码 `0/1/2` 分别表示成功、失败和阻塞。
