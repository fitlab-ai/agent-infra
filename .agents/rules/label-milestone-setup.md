# Label / Milestone 平台命令

在初始化 label、初始化 milestone，或发布流程需要调整 milestone 前先读取本文件。

## 认证与仓库信息

```bash
gh auth token
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

## Label 操作

列出现有 label：

```bash
gh label list --limit 200 --json name --jq '.[].name'
```

创建或更新 label：

```bash
gh label create "{name}" --color "{color}" --description "{description}" --force
```

## Milestone 操作

列出 milestone：

```bash
gh api "repos/$repo/milestones?state=all" --paginate
```

创建 milestone：

```bash
gh api "repos/$repo/milestones" -f title="{title}" -f description="{description}" -f state="{state}"
```

更新 milestone：

```bash
gh api "repos/$repo/milestones/{number}" -X PATCH -f state="{state}" -f description="{description}"
```

## 约束

- label 以名称作为幂等键
- milestone 以标题作为幂等键，必要时再结合编号更新状态
- 失败时按调用方规则决定停止或跳过
