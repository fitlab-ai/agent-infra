# 安全告警平台命令

在导入或关闭 Dependabot / Code Scanning 告警前先读取本文件。

## Dependabot 告警

读取告警：

```bash
gh api "repos/{owner}/{repo}/dependabot/alerts/{number}"
```

关闭告警：

```bash
gh api --method PATCH "repos/{owner}/{repo}/dependabot/alerts/{number}" \
  -f state="dismissed" \
  -f dismissed_reason="{reason}" \
  -f dismissed_comment="{comment}"
```

## Code Scanning 告警

读取告警：

```bash
gh api "repos/{owner}/{repo}/code-scanning/alerts/{number}"
```

关闭告警：

```bash
gh api --method PATCH "repos/{owner}/{repo}/code-scanning/alerts/{number}" \
  -f state="dismissed" \
  -f dismissed_reason="{reason}" \
  -f dismissed_comment="{comment}"
```

## 约束

- 先读取当前告警状态，再决定是否继续
- 关闭理由必须由调用方校验后再传入
- API 失败时按调用方规则停止或提示人工介入
