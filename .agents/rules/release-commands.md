# Release 平台命令

在读取历史 release、查询已合并 PR，或发布 Release notes 前先读取本文件。

## Release 查询

```bash
gh release list --limit {limit} --json tagName,isDraft,isPrerelease
gh release view "{tag}" --json body,url
```

## 已合并 PR 查询

```bash
gh pr list --state merged --base "{branch}" --json number,title,mergedAt,labels
```

必要时读取关联 Issue：

```bash
gh issue view {issue-number} --json number,title,labels,url
```

## Contributor 映射辅助规则

release notes 需要 contributors 时，已合并 PR 查询应包含 author：

```bash
gh pr list --state merged --base "{branch}" --json number,title,mergedAt,labels,author
```

关联 Issue 用于 reporter 归因时，查询应包含 author：

```bash
gh issue view {issue-number} --json number,title,labels,url,author
```

GitHub no-reply 邮箱映射规则：如果 `Name <email>` 中的 email 匹配 `(\d+\+)?(\S+?)@users\.noreply\.github\.com`，使用第二个捕获组的小写形式作为 login。该规则同时覆盖 `{id}+{login}@users.noreply.github.com` 和 `{login}@users.noreply.github.com`。

## 发布 Release notes

`v{version}` 的 GitHub Release 由 release 工作流自动创建并发布，为 Homebrew bottle 提供稳定的上传落点。本命令把精修后的 notes 写到这个已存在的 Release 上；若 Release 尚不存在则兜底创建。

```bash
if gh release view "v{version}" >/dev/null 2>&1; then
  gh release edit "v{version}" --notes-file "{notes-file}"
else
  gh release create "v{version}" --title "v{version}" --notes-file "{notes-file}"
fi
```

失败时按调用方规则停止或提示人工介入。
