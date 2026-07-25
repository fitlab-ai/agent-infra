# Release 平台命令

发布说明平台操作统一使用 typed internal intent。调用方只解释结构化 JSON，不解析平台命令、原始字段、身份邮箱规则或认证错误。

## 收集发布说明上下文

```bash
agent-infra-internal platform-release-notes context \
  --from-tag "v{prev-version}" \
  --to-tag "v{version}" \
  --branch "{branch}" \
  --history-limit 3
```

结果包含 `history`、`pullRequests`、`closingIssues` 和带规范化 `login` / `resolution` 的 commit `authors`。`status: no-op` 且错误码为 `PLATFORM_RELEASE_NOTES_UNSUPPORTED` 表示当前平台不支持远端发布说明能力。

## 发布 Release notes

用户确认后调用：

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v{version}" \
  --title "v{version}" \
  --notes-file "{notes-file}"
```

命令会更新已存在的 Release，缺失时创建；`--dry-run` 只返回 planned operation。退出码为 `0` 时成功，`1` 表示稳定失败，`2` 表示网络或平台阻塞。
