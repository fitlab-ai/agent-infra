# PR 检查平台命令（GitHub）

在监控 PR 的 required checks、解析失败 run、拉取失败日志或读取当前分支 PR 前先读取本文件。`watch-pr` 技能的平台专属命令集中在此，技能正文与 `reference/` 保持平台无关。

## 当前分支 PR / 仓库信息

```bash
gh pr view --json number -q .number          # 当前分支对应的 PR 号
gh pr view {pr#} --json headRefOid -q .headRefOid   # PR head SHA
gh repo view --json nameWithOwner -q .nameWithOwner # {owner}/{repo}
```

`gh` 未认证或命令失败时，按调用方技能的错误处理停止或降级。

## 监控 required checks

```bash
gh pr checks {pr#} --required --watch --fail-fast -i 30 \
  --json name,bucket,link,workflow
```

- `--required`：只纳入仓库分支保护标记为 required 的 checks。
- `--watch`：阻塞直到这些 checks 全部跑完；`--fail-fast`：出现首个失败即退出 watch。
- `-i 30`：轮询间隔 30 秒（退避）。**总时长上限默认 30 分钟（1800 秒）**：按执行环境选用对应的超时方式，超时即按「挂起」处理（退出码 8）。
  - POSIX shell：`timeout 1800 gh pr checks {pr#} --required --watch --fail-fast -i 30 …`
  - PowerShell（Windows）：用作业超时——
    ```powershell
    $job = Start-Job { gh pr checks {pr#} --required --watch --fail-fast -i 30 }
    if (Wait-Job $job -Timeout 1800) { Receive-Job $job } else { Stop-Job $job; <按「挂起」处理> }
    ```
  - 平台中立回退（无外部超时工具时）：记录开始时间，循环执行**不带** `--watch` 的 `gh pr checks {pr#} --required --json name,bucket,link,workflow`，每轮 sleep `-i` 秒并检查 `bucket` 是否仍有 `pending`；累计时长 ≥ 1800 秒仍未结束 → 退出循环按「挂起」处理。
- `--json` 的 `bucket` 字段把每个 check 归类为 `pass` / `fail` / `pending` / `skipping` / `cancel`。

退出码语义：

| 退出码 | 含义 | 结果分类 |
|--------|------|----------|
| 0 | 全部 required checks 通过 | 全绿 |
| 1 | 至少一个失败 / 出错 | 失败 |
| 8 | 仍有 pending（watch 超时或被 `timeout` 截断） | 挂起 |

旧版 `gh`（< 2.93）若不支持 `--required`：回退为 `gh pr checks {pr#} --watch --fail-fast`（即「所有 check 必须 success」），并在求助/报告中注明该降级、建议升级 `gh`。

## 解析失败 run id 并拉日志

`gh pr checks --json` 不直接返回 run id，但返回失败 check 的 `link`（指向 run/job 的 URL）。按确定性顺序解析：

1. 从失败 check 的 `link` 用正则提取：`https://github.com/{owner}/{repo}/actions/runs/(\d+)(?:/job/(\d+))?` → 第 1 组为 run id（可选第 2 组为 job id）。
2. `link` 非 run URL 或无法解析时，用 head SHA 查 check-runs：
   ```bash
   sha=$(gh pr view {pr#} --json headRefOid -q .headRefOid)
   gh api "repos/{owner}/{repo}/commits/$sha/check-runs" \
     --jq '.check_runs[] | select(.name=="{failed-check-name}") | .details_url'
   ```
   再从 `details_url` 同法提取 run id。
3. 两路都拿不到 run id → 视为「不可定位」，按技能的求助出口处理，不盲目自愈。

拿到 run id 后拉失败日志：

```bash
gh run view {run-id} --log-failed
```
