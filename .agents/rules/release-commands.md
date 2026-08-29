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

### 身份安全边界

- 只有 `resolution` 为 `platform-user` 或 `platform-noreply` 且 `login` 非空的身份可以渲染为 `@login`。
- `resolution: unresolved` 的身份不得进入发布说明的贡献者列表；不得从 Name、邮箱、域名、品牌或同名平台账号推断 login，也不得替换成推测的个人或组织账号。
- 不得把未解析身份的邮箱或身份确认 TODO 写入可发布的 Release notes。需要调查时仅在发布流程外记录，不得产生平台 mention。

## Stage Release notes

```bash
agent-infra-internal platform-release-notes stage \
  --notes-file "{notes-file}"
```

命令只接受工作树外普通文件，原子规范化并返回精确 bytes 的 SHA-256。

## 发布 Release notes

用户确认后调用：

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v{version}" \
  --title "v{version}" \
  --notes-file "{notes-file}" \
  --expected-sha256 "{preview-sha256}"
```

命令在平台访问前复算摘要，不匹配时零写入；匹配时更新已有 Release，缺失时创建。`--dry-run` 只返回 planned operation。退出码为 `0` 时成功，`1` 表示稳定失败，`2` 表示网络或平台阻塞。
