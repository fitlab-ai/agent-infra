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

## 创建 Draft Release

```bash
gh release create "v{version}" --draft --title "v{version}" --notes-file "{notes-file}"
```

失败时按调用方规则停止或提示人工介入。
