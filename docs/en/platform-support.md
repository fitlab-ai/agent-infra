# Platform Support

[← Back to README](../../README.md) · [中文](../zh-CN/platform-support.md)

agent-infra runs on macOS, Linux, and Windows. The CLI itself only needs Node.js (>=22); container-related features (`ai sandbox *`) additionally need Docker.

## Sandbox engine selection

`sandbox.engine` in `.agents/.airc.json` selects the container engine. When it is `null` or omitted, agent-infra uses the platform default:

- Linux: `native`
- macOS: `colima`
- Windows: `wsl2`

You can override the engine in `.agents/.airc.json`. Valid engines are platform-specific:

- Linux: `native`, `docker-desktop`
- macOS: `colima`, `orbstack`, `docker-desktop`
- Windows: `wsl2`, `native`, `docker-desktop`

## macOS

- `ai init`, `ai sync`, etc.: works out of the box after `npm install -g @fitlab-ai/agent-infra` (or Homebrew).
- `ai sandbox *`: requires Colima, OrbStack, or Docker Desktop. Colima is the default engine on macOS — when it is selected and the `colima` command is missing, agent-infra auto-installs and starts Colima via Homebrew on first run. To use OrbStack or Docker Desktop instead, set `sandbox.engine` in `.agents/.airc.json`.

### Engine resource configuration

| Engine | `vm.cpu` | `vm.memory` | `vm.disk` | Apply mode | Notes |
|--------|----------|-------------|-----------|------------|-------|
| Colima | applied | applied | applied | on-start | VM must be restarted (`ai sandbox vm stop && ai sandbox vm start`) for changes to take effect. |
| OrbStack | applied | applied | warned | hot | Applied via `orb config set` on every invocation. OrbStack manages disk via thin provisioning. |
| Docker Desktop | warned | warned | warned | manual | Resources must be set in Docker Desktop GUI (Settings -> Resources). |

`vm.memory` and `--memory` values are expressed in GiB.

### SSH / locked keychain

On macOS over SSH, the login keychain may be locked and reject non-interactive reads or writes with `errSecInteractionNotAllowed`. You can unlock it on the host and re-run `ai sandbox refresh`:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
ai sandbox refresh
```

For long-lived SSH sessions or CI, bypass the keychain with `AGENT_INFRA_CLAUDE_CREDENTIALS_FILE`. macOS stores Claude Code credentials in the keychain by default, so seed the override file once from a session where the keychain is unlocked:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
umask 077 && mkdir -p "$HOME/.agent-infra" && \
  security find-generic-password -s "Claude Code-credentials" -w \
  > "$HOME/.agent-infra/claude-credentials.json"
chmod 600 "$HOME/.agent-infra/claude-credentials.json"
```

Then on the SSH / CI side:

```bash
export AGENT_INFRA_CLAUDE_CREDENTIALS_FILE="$HOME/.agent-infra/claude-credentials.json"
ai sandbox refresh
```

After that, sandbox create, exec, and refresh use the file instead of the keychain for Claude Code credential reads and writes.

## Linux

- `ai init`, `ai sync`, etc.: works out of the box after `npm install -g @fitlab-ai/agent-infra`.
- `ai sandbox *`: requires Docker Engine on the host. Quick setup:

  ```bash
  # 1. Install Docker Engine — see https://docs.docker.com/engine/install/
  # 2. Start the daemon and enable on boot
  sudo systemctl enable --now docker
  # 3. Skip 'sudo' for docker: add yourself to the docker group
  sudo usermod -aG docker $USER && newgrp docker
  ```

  Validate with `docker info` — it should succeed without sudo.

  GPG signing works when the host `gpg-agent` and signing key are available; if key sync fails, `ai sandbox create` falls back to a sanitized Git config so commits still work without host signing state.

### Engine resource configuration

Linux uses native Docker on the host kernel, so there is no managed VM. `sandbox.vm.*` and the `--cpu / --memory` flags do not apply. To cap container resources, use `docker run --cpus / --memory` per container or configure host cgroups.

### Rootless Docker (optional)

**Skip this section if you followed the Quick setup above.** The Quick setup installs the default rootful Docker, which works out of the box with `ai sandbox` — no extra configuration is required.

Rootless Docker is a separate Docker installation where the daemon runs as your normal user instead of `root`. It is typically chosen on shared hosts, multi-tenant servers, or when a security policy forbids a root-owned daemon. If you have intentionally installed rootless Docker (or plan to), follow the steps below; otherwise stay with rootful.

To install and verify rootless Docker:

```bash
sudo apt install -y uidmap slirp4netns dbus-user-session
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
docker info
```

Add the `DOCKER_HOST` export to your shell startup file after validation.

When rootless Docker is detected, agent-infra builds the sandbox image with `HOST_UID=0` and `HOST_GID=0`. Inside the container the sandbox user can read bind mounts such as `~/.ssh` without relaxing host file permissions. On the host, the daemon and container processes still run under the current user, so this does not grant host root privileges.

Known rootless differences:

- Networking uses slirp4netns by default and can be slower than rootful bridge networking.
- Processes run as UID 0 inside the container, unlike rootful Docker where agent-infra mirrors the host UID.
- The CI rootless matrix is initially allowed to fail while runner stability is observed.

Troubleshooting:

- If `docker info` fails, check `systemctl --user status docker` and confirm `DOCKER_HOST` points at `$XDG_RUNTIME_DIR/docker.sock`.
- If SSH files are still unreadable inside the sandbox, confirm the shell has not overridden `DOCKER_HOST` or Docker build arguments.

### Known limitations on Linux

These configurations are not actively tested in this release:

- **Podman** instead of Docker: Works on Fedora 40+ and other `dnf`-based RHEL family distros (RHEL, CentOS Stream, Rocky, Alma) via the `podman-docker` shim (`sudo dnf install podman podman-docker`; optionally `sudo touch /etc/containers/nodocker` to silence its per-command notice).
- **SELinux-enforcing** hosts (Fedora / RHEL): `ai sandbox create` automatically labels bind mounts with Docker's shared `:z` flag — no setup required. Set `AGENT_INFRA_SELINUX_DISABLE=1` to opt out for debugging.
- `ai sandbox vm` is a no-op on Linux. Linux uses native Docker directly with no VM to manage; use `ai sandbox create`, `ai sandbox exec`, `ai sandbox start`, `ai sandbox refresh`, `ai sandbox ls`, `ai sandbox show`, `ai sandbox rebuild`, `ai sandbox rm`, and `ai sandbox prune` directly.

## Windows

- `ai init`, `ai sync`, etc.: should work after `npm install -g @fitlab-ai/agent-infra` (Node.js >= 22). Not actively tested in this release.
- `ai sandbox *`: supported on Windows via WSL2 + Docker Desktop.

Before running `ai sandbox create`, install Windows 11 with WSL2, configure a default Linux distribution, install Docker Desktop, and enable Docker Desktop's WSL integration for that distribution.

You can run the CLI from PowerShell or Git Bash, but the project path must be visible from WSL, such as `C:\Users\you\project` or another drive mounted under `/mnt/<drive>`. UNC paths are not supported for sandbox mounts. If the Windows entrypoint cannot reach Docker through WSL2, run the same command from inside the WSL distribution as a fallback.

`ai sandbox vm` manages only the macOS Colima VM. On Windows, manage Docker Desktop and WSL2 with their native tools.

### Engine resource configuration

WSL2 is the default sandbox engine on Windows. `sandbox.vm.cpu`, `sandbox.vm.memory`, and `--cpu / --memory` flags are not applied automatically when using WSL2 — configure CPU and memory limits in Docker Desktop (Settings → Resources) instead. `sandbox.vm.disk` is not applicable to WSL2. `vm.memory` and `--memory` values are expressed in GiB.
