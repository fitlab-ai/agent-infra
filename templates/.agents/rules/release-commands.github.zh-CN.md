# Release 平台命令

在读取历史 release、查询已合并 PR，或创建 draft release 前先读取本文件。

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

## 创建 Draft Release

```bash
gh release create "v{version}" --draft --title "v{version}" --notes-file "{notes-file}"
```

失败时按调用方规则停止或提示人工介入。
