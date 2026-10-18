# Sandbox security profile

## `nested-bubblewrap.json`

All task sandboxes load this seccomp profile and set `--security-opt apparmor=unconfined`.

The profile's default action is `SCMP_ACT_ERRNO`. It allows:

- `clone` with namespace flags;
- `unshare`;
- `mount`, `umount`, `umount2`, `move_mount`, `open_tree`, `mount_setattr`, `fsconfig`, `fsmount`, `fsopen`, `fspick`;
- `pivot_root`.

It keeps these syscalls behind `CAP_SYS_ADMIN`: `bpf`, `clone3`, `fanotify_init`, `lookup_dcookie`, `lsm_get_self_attr`, `lsm_list_modules`, `lsm_set_self_attr`, `perf_event_open`, `quotactl`, `quotactl_fd`, `setdomainname`, `sethostname`, `setns`, `syslog`.

Container capabilities, mounts, and namespace isolation are unchanged.

## Provenance

- Source: `github.com/moby/profiles`, tag `seccomp/v0.2.4`, commit `245180c51918481c0525424b3ee025d2b435d46c`, file `seccomp/default.json`.
- Source SHA-256: `785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334`.
- Profile SHA-256: `7a3aff20cc207cb7031e784413f17b0144fed203131e85b3de4709b2b9bfe98e`.
- License: Apache-2.0.
