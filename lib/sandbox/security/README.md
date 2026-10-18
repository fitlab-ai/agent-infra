# Sandbox security profile

## `nested-bubblewrap.json`

这个 profile 供所有任务沙箱使用。沙箱内运行 bubblewrap 的客户端（例如 Codex）需要创建 user、mount、PID、network 等 namespace；Docker 默认 seccomp 在没有 `CAP_SYS_ADMIN` 时限制 `clone` 的 namespace flags，并拒绝 `unshare`。该 profile 在保留 Docker 默认 allowlist 的前提下放开这些调用。

### 来源

- 仓库：`github.com/moby/profiles`
- Tag：`seccomp/v0.2.4`
- Commit：`245180c51918481c0525424b3ee025d2b435d46c`
- 文件：`seccomp/default.json`
- 源文件 SHA-256：`785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334`
- 许可证：Apache-2.0

生成文件 `nested-bubblewrap.json` 的 SHA-256：`7a3aff20cc207cb7031e784413f17b0144fed203131e85b3de4709b2b9bfe98e`。

### 相对默认 profile 的 delta

- `clone`：删除无 `CAP_SYS_ADMIN` 时限制 namespace flags 的 `args` 掩码。该改动覆盖普通架构和 s390/s390x 的两个 `clone` 规则。
- `unshare`：从 `CAP_SYS_ADMIN` 门控规则移到无条件允许规则。
- `mount`、`umount`、`umount2`、`move_mount`、`open_tree`、`mount_setattr`、`fsconfig`、`fsmount`、`fsopen`、`fspick`：从 `CAP_SYS_ADMIN` 门控规则移到无条件允许规则。
- `pivot_root`：加入无条件允许规则。Docker 默认 profile 没有列出该 syscall。
- 其余规则保持不变，包括 `defaultAction: SCMP_ACT_ERRNO` 和以下仍受 `CAP_SYS_ADMIN` 门控的调用：`bpf`、`clone3`、`fanotify_init`、`lookup_dcookie`、`lsm_get_self_attr`、`lsm_list_modules`、`lsm_set_self_attr`、`perf_event_open`、`quotactl`、`quotactl_fd`、`setdomainname`、`sethostname`、`setns`、`syslog`。

内核 capability 检查仍然生效。profile 只改变 seccomp 过滤，不增加容器 capabilities，也不修改挂载或 namespace 配置。

### 生成方式

以固定的 `seccomp/default.json` 为输入，执行以下变换：

1. 把 `unshare`、`mount`、`umount`、`umount2`、`move_mount`、`open_tree`、`mount_setattr`、`fsconfig`、`fsmount`、`fsopen`、`fspick` 从 `includes.caps: ["CAP_SYS_ADMIN"]` 的规则中移除；如果规则为空则删除。
2. 删除两个非特权 `clone` 规则的 `args` 字段。
3. 在 `syscalls` 开头插入一条无条件规则：

```json
{
  "names": [
    "fsconfig",
    "fsmount",
    "fsopen",
    "fspick",
    "mount",
    "mount_setattr",
    "move_mount",
    "open_tree",
    "pivot_root",
    "umount",
    "umount2",
    "unshare"
  ],
  "action": "SCMP_ACT_ALLOW"
}
```

4. 使用两空格缩进输出 JSON。

### 更新条件

出现以下任一情况时重新生成并复核本文件：

- Docker Engine 的默认 seccomp profile 升级到新的 `moby/profiles` 版本。
- bubblewrap 客户端改用新的 namespace 系统调用（例如 `clone3`）。
- Linux E2E 或真实 Dots 验证出现新的 `EPERM`。

更新后必须重新运行 `tests/unit/core/sandbox-security.test.ts`、`tests/integration/cli/sandbox-core.test.ts` 和 Linux sandbox E2E，并更新本文件的 SHA-256。

### 适用范围

该 profile 注入所有任务沙箱，不依赖具体客户端。

同一注入点还会添加 `--security-opt apparmor=unconfined`。在启用 AppArmor 的 Linux 主机上，Docker 默认 AppArmor 策略会拒绝 bubblewrap 的 mount 操作；容器仍保留 seccomp、capabilities 和 namespace 隔离。

Ubuntu 24.04 等启用 `kernel.apparmor_restrict_unprivileged_userns=1` 的主机，可能还需要在宿主机放行 unprivileged user namespace；项目 Linux E2E 已把该 sysctl 设为 0。
