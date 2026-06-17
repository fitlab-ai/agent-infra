# 平台支持

[← 返回 README](../../README.zh-CN.md) · [English](../en/platform-support.md)

agent-infra 支持 macOS、Linux 和 Windows。CLI 本身只需要 Node.js (>=22)；容器相关功能（`ai sandbox *`）额外需要 Docker。

## 沙箱引擎选择

`.agents/.airc.json` 中的 `sandbox.engine` 用来选择容器引擎。该字段为 `null` 或省略时，agent-infra 使用平台默认值：

- Linux：`native`
- macOS：`colima`
- Windows：`wsl2`

你可以在 `.agents/.airc.json` 中覆盖该引擎。合法值按平台区分：

- Linux：`native`、`docker-desktop`
- macOS：`colima`、`orbstack`、`docker-desktop`
- Windows：`wsl2`、`native`、`docker-desktop`

## macOS

- `ai init`、`ai sync` 等：执行 `npm install -g @fitlab-ai/agent-infra`（或 Homebrew 安装）后开箱即用。
- `ai sandbox *`：需要 Colima、OrbStack 或 Docker Desktop。macOS 默认引擎是 Colima —— 当选用 Colima 且宿主机没有 `colima` 命令时，agent-infra 会在首次运行时通过 Homebrew 自动安装并启动。如需使用 OrbStack 或 Docker Desktop，请在 `.agents/.airc.json` 中设置 `sandbox.engine`。

### 引擎资源配置

| 引擎 | `vm.cpu` | `vm.memory` | `vm.disk` | 应用方式 | 说明 |
|------|----------|-------------|-----------|----------|------|
| Colima | 生效 | 生效 | 生效 | 启动时 | 变更需重启 VM（`ai sandbox vm stop && ai sandbox vm start`）后生效。 |
| OrbStack | 生效 | 生效 | 警告 | 热应用 | 每次调用都会通过 `orb config set` 应用。OrbStack 通过 thin provisioning 管理磁盘。 |
| Docker Desktop | 警告 | 警告 | 警告 | 手动 | 资源必须在 Docker Desktop GUI（Settings -> Resources）中设置。 |

`vm.memory` 和 `--memory` 的单位是 GiB。

### SSH / 锁定的 keychain

在 macOS 上通过 SSH 使用时，login keychain 可能处于锁定状态，并以 `errSecInteractionNotAllowed` 拒绝非交互式读写。你可以在宿主机上解锁后重新运行 `ai sandbox refresh`：

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
ai sandbox refresh
```

对于长期 SSH 会话或 CI，可以通过 `AGENT_INFRA_CLAUDE_CREDENTIALS_FILE` 绕过 keychain。macOS 默认把 Claude Code 凭据存进 keychain，所以需要先在 keychain 已解锁的会话中 seed 一次 override 文件：

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
umask 077 && mkdir -p "$HOME/.agent-infra" && \
  security find-generic-password -s "Claude Code-credentials" -w \
  > "$HOME/.agent-infra/claude-credentials.json"
chmod 600 "$HOME/.agent-infra/claude-credentials.json"
```

之后在 SSH / CI 侧设置：

```bash
export AGENT_INFRA_CLAUDE_CREDENTIALS_FILE="$HOME/.agent-infra/claude-credentials.json"
ai sandbox refresh
```

此后 sandbox create、exec、refresh 读取和写入 Claude Code 凭据时都会使用该文件，而不是 keychain。

## Linux

- `ai init`、`ai sync` 等：执行 `npm install -g @fitlab-ai/agent-infra` 后开箱即用。
- `ai sandbox *`：需要宿主机已安装 Docker Engine。三步配置：

  ```bash
  # 1. 安装 Docker Engine —— 见 https://docs.docker.com/engine/install/
  # 2. 启动 daemon 并设置开机自启
  sudo systemctl enable --now docker
  # 3. 让当前用户免 sudo 跑 docker：加入 docker 组
  sudo usermod -aG docker $USER && newgrp docker
  ```

  验证：执行 `docker info` 应在不带 sudo 的情况下成功。

  当宿主机 `gpg-agent` 和签名 key 可用时，GPG signing 可正常工作；如果 key 同步失败，`ai sandbox create` 会回退到清理后的 Git config，让提交仍可在没有宿主签名状态的情况下继续。

### 引擎资源配置

Linux 直接使用宿主内核上的原生 Docker，没有受管 VM。`sandbox.vm.*` 与 `--cpu / --memory` 标志均不生效。如需限制容器资源，请用 `docker run --cpus / --memory` 设置单容器限制，或配置宿主 cgroups。

### Rootless Docker（可选）

**如果你已按上面的 Quick setup 装好 rootful Docker，跳过本节即可。** Quick setup 装的就是默认的 rootful Docker，`ai sandbox` 开箱可用，不需要任何额外配置。

Rootless Docker 是一种另起一套的 Docker 安装方式：daemon 以你的普通用户身份运行，而不是 root。它通常用在共享主机、多租户服务器，或安全策略禁止 root 守护进程的场景。如果你**主动选择**安装了 rootless Docker（或打算这么做），按下面的步骤配置；否则继续用 rootful 就好。

安装并验证 rootless Docker：

```bash
sudo apt install -y uidmap slirp4netns dbus-user-session
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
docker info
```

验证通过后，请把 `DOCKER_HOST` export 写入 shell 启动文件。

agent-infra 检测到 rootless Docker 后，会用 `HOST_UID=0` 和 `HOST_GID=0` 构建 sandbox 镜像。这样容器内 sandbox 用户可以读取 `~/.ssh` 等 bind mount，无需放宽宿主文件权限。在宿主侧，daemon 和容器进程仍以当前用户身份运行，不会获得宿主 root 权限。

Rootless 模式的已知差异：

- 网络默认使用 slirp4netns，可能比 rootful bridge 网络慢。
- 容器内进程以 UID 0 运行；rootful Docker 下 agent-infra 仍会镜像宿主 UID。
- CI rootless matrix 初期允许失败，用于观察 GitHub runner 稳定性。

排障：

- 如果 `docker info` 失败，请检查 `systemctl --user status docker`，并确认 `DOCKER_HOST` 指向 `$XDG_RUNTIME_DIR/docker.sock`。
- 如果 sandbox 内仍无法读取 SSH 文件，请确认 shell 没有覆盖 `DOCKER_HOST` 或 Docker build args。

### Linux 已知限制

下列场景在本期未做主动验证：

- 用 **Podman** 替代 Docker：Fedora 40+ 及其他 `dnf` 系 RHEL 发行版（RHEL、CentOS Stream、Rocky、Alma）上通过 `podman-docker` shim 已可使用（`sudo dnf install podman podman-docker`；可选 `sudo touch /etc/containers/nodocker` 抑制 podman 在每条命令前打印的提示）。
- **SELinux enforcing** 宿主机（Fedora / RHEL）：`ai sandbox create` 会自动给 bind mount 加 Docker 共享 `:z` 标签，无需手动准备。如需排障可设 `AGENT_INFRA_SELINUX_DISABLE=1` 关闭。
- `ai sandbox vm` 在 Linux 上是空操作。Linux 直接使用 native Docker，没有 VM 需要管理；请直接使用 `ai sandbox create`、`ai sandbox exec`、`ai sandbox start`、`ai sandbox refresh`、`ai sandbox ls`、`ai sandbox rebuild`、`ai sandbox rm`、`ai sandbox prune`。

## Windows

- `ai init`、`ai sync` 等：执行 `npm install -g @fitlab-ai/agent-infra` 后理论上可用（需 Node.js >= 22）。本期未做主动验证。
- `ai sandbox *`：Windows 通过 WSL2 + Docker Desktop 支持。

运行 `ai sandbox create` 前，请先准备 Windows 11、WSL2、默认 Linux distribution、Docker Desktop，并在 Docker Desktop 中为该 distribution 启用 WSL integration。

你可以从 PowerShell 或 Git Bash 运行 CLI，但项目路径必须能被 WSL 访问，例如 `C:\Users\you\project`，或其他会挂载到 `/mnt/<drive>` 的磁盘路径。UNC 路径不支持作为沙箱挂载路径。如果 Windows 入口无法通过 WSL2 访问 Docker，可以进入对应 WSL distribution 后运行同一命令作为回退方案。

`ai sandbox vm` 只管理 macOS 的 Colima VM。在 Windows 上，请使用 Docker Desktop 和 WSL2 自带工具管理后端。

### 引擎资源配置

WSL2 是 Windows 上的默认 sandbox 引擎。使用 WSL2 时，`sandbox.vm.cpu`、`sandbox.vm.memory` 以及 `--cpu / --memory` 标志不会自动生效——请在 Docker Desktop（Settings → Resources）中配置 CPU 和内存限制。`sandbox.vm.disk` 不适用于 WSL2。`vm.memory` 和 `--memory` 的单位是 GiB。
