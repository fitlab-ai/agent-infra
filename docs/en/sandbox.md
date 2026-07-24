# Sandbox

[← Back to README](../../README.md) · [中文](../zh-CN/sandbox.md)

## Build prerequisites and troubleshooting

Sandbox creation and rebuilding require Docker Buildx with a working BuildKit builder. agent-infra checks the selected engine and Docker context before inspecting or building an image:

```bash
docker buildx inspect --bootstrap
```

If this check fails, `ai sandbox create` and `ai sandbox rebuild` stop before `docker build` and print a repair hint. For Colima, install the missing plugin with `brew install docker-buildx`; a first-time Colima setup installs `colima`, `docker`, and `docker-buildx` together. For Docker Desktop or WSL2, upgrade or repair Docker Desktop. For native Docker Engine, install the Buildx CLI plugin supplied for your distribution. OrbStack users should upgrade or repair OrbStack if its builder is unavailable.

The built-in image also verifies that `cc-token-status`, `sandbox-dotfiles-link`, and `sandbox-tmux-entry` are non-empty and executable during the Docker build. A build cannot succeed with the empty scripts produced by a legacy builder. Custom Dockerfiles still require BuildKit, but they are not required to contain these built-in scripts.

## Sandbox aliases and GitHub CLI

`ai sandbox create` now bootstraps the host-side aliases file at `~/.agent-infra/aliases/sandbox.sh` on first run. The generated file includes ready-to-edit yolo shortcuts for Claude, Codex, Gemini CLI, and OpenCode, and every sandbox syncs that file into `/home/devuser/.bash_aliases`.

The default sandbox image also installs the agent-infra CLI npm package, exposing both `ai` and `agent-infra` on the container `PATH`. Inside a task-bound worktree, lifecycle skills and suitable task commands infer the unique active task whose `task.md` branch exactly matches the current symbolic branch; use `--task <ref>` / `-t <ref>` to override it. Commands with another positional operand use unambiguous forms such as `ai task cat analysis`, `ai task decisions --item 1`, and `ai decide --item PL-1 <decision>`. `ai task grep <pattern>` remains a global search unless `--current` or `--task` is supplied. Host-side `ai run <skill> <task-ref>` still requires the task ref because it selects the target branch and sandbox. Existing sandbox images and containers need a refreshed rebuild and recreation before they pick up this newly managed tool.

The sandbox image also preinstalls `gh`. When `gh auth token` succeeds on the host, `ai sandbox create` injects the token into the container as `GH_TOKEN`, so `gh` commands work inside the sandbox without extra setup.

Host `~/.ssh` is not bind-mounted into the sandbox. GitHub access is expected to use the `gh` / HTTPS token path above; `git@github.com:*` SSH workflows need a separate, explicit setup outside the default sandbox boundary.

## Runtime proxy inheritance

`ai sandbox create <branch> --inherit-proxy` copies standard host proxy variables into the new container environment. `-P` is the short form of the same boolean switch. The default remains off: if you do not pass the switch, agent-infra does not read or inject host proxy variables.

The copied allowlist is fixed:

- `http_proxy` / `HTTP_PROXY`
- `https_proxy` / `HTTPS_PROXY`
- `all_proxy` / `ALL_PROXY`
- `no_proxy` / `NO_PROXY`

Only variables that exist and are not empty strings are copied. Values are passed through unchanged by key and value: agent-infra does not parse proxy URLs, infer missing uppercase or lowercase variants, merge conflicts, interpret `NO_PROXY`, or add WebSocket-specific variables. If both uppercase and lowercase variants are set, both are written and the client inside the container decides which one it uses; prefer keeping host values consistent.

Proxy values are written through the same private Docker `--env-file` path used for tool environment variables and `GH_TOKEN`, so credentials do not appear in the Docker argv or project configuration. The values are still container environment variables after creation, so every process in that container can read them. Avoid placing real proxy credentials in shell history or committed files; if credentials are required, set them in the host environment only for the create command.

Example without credentials:

```bash
HTTP_PROXY=http://proxy.internal:8080 \
HTTPS_PROXY=http://proxy.internal:8080 \
NO_PROXY=localhost,127.0.0.1 \
ai sandbox create feature/proxy --inherit-proxy
```

The proxy environment is captured at container creation time. `ai sandbox start` and `ai sandbox exec` do not refresh it. If the proxy entrypoint address changes, or if you need to fully remove proxy variables from a sandbox, remove and recreate the container. If the entrypoint address stays stable, switching between PROXY and DIRECT mode should happen in the proxy layer behind that address; simply stopping the proxy while leaving container proxy variables set will usually break clients.

This feature covers only container runtime environment variables. Docker daemon proxy settings, image pulls, BuildKit, and image build proxy forwarding are separate build-time concerns and are not handled by `--inherit-proxy`.

## Build-time proxy inheritance

Use `ai sandbox create <branch> --inherit-build-proxy` or `ai sandbox rebuild --inherit-build-proxy` (`-B`) to pass non-empty uppercase `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` values to managed Dockerfile build steps for that invocation. Values stay in the Docker child-process environment; Docker argv contains only predefined proxy argument names. This switch is independent of runtime `-P`, is rejected for custom Dockerfiles, and requires Docker Engine >=20.10.0 plus every visible BuildKit node >=0.9.0.

The switch does not configure the Docker daemon or builder. Image pulls and `FROM` resolution still require proxy configuration in native Docker, Docker Desktop, OrbStack, Colima, or the WSL2 Docker integration. When `-B` is omitted, image inspection and build behavior remain unchanged.

`ai sandbox rebuild` keeps Docker's build cache by default, so it quickly retags the sandbox image without refreshing every package. Use `ai sandbox rebuild --refresh` when you want to upgrade the image: it passes `--no-cache --pull` to Docker, pulls the current Ubuntu base image, and reruns the apt, tmux build, and global npm install layers. Claude Code updates are disabled inside the container, and OpenCode startup update checks are disabled; `--refresh` is the routine upgrade path for sandbox-managed tools. Manual `opencode upgrade` remains outside this guard. The default `python3` provided by the Ubuntu 24.04 sandbox base is Python 3.12, so scripts that hard-code Python 3.10 paths may need adjustment.

`ai sandbox exec` also forwards a small terminal-detection whitelist (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`) into the container. This keeps interactive TUIs aligned with the host terminal for behaviors such as Claude Code's Shift+Enter newline support, without passing through the full host environment.

`ai sandbox start`, `ai sandbox exec`, and sandbox-backed `ai run` now share one readiness check before they run user work. After a stopped container starts, agent-infra restores tmpfs ownership, rehydrates every seed that is still mounted in the container, recreates the built-in Codex prompts link, and verifies mount topology, shell aliases, Codex availability, state-directory writability, and the entries copied during that recovery. A running container receives a non-destructive structural check: existing writable seed targets are preserved even when their content, timestamp, or inode differs from the host staging copy. Recovery does not replay custom `postSetupCmds`, and custom `versionCmd` results remain advisory.

If in-place recovery fails, the command stops before entering the container or scheduling tmux. It does not replace the container automatically. Pass `--recreate` to authorize a container-only fallback: `ai sandbox start --recreate <target>`, `ai sandbox exec --recreate <target> [cmd...]`, or `ai run <skill> <task-ref> --recreate`. For `sandbox exec`, only a flag before the target is interpreted by the host; `--recreate` after the target is passed to the container command. Replacement preserves the worktree, local branch, host-managed tool seeds, shell configuration, and `/share` data, but discards the old container ID, writable layer, ordinary `/tmp`, processes, tmux sessions, and other RAM state. It never performs a full `ai sandbox rm`.

Tmpfs runtime data is deliberately ephemeral. Codex databases, logs, sessions, and other non-seeded files under `/home/devuser/.codex` cannot be recovered after tmpfs loss. Declared seed entries such as `config.toml` and `model-catalogs` are reconstructable from their read-only staging mounts; bind-mounted worktrees, credentials, shell configuration, and share directories remain host-persistent.

`ai sandbox ls` keeps a compact view: it lists only the Containers table for the current project (the `#` row number, the `SHORT` task short id, plus names, status, and branch). It no longer prints the worktree list or each tool's state paths. To inspect those details for one sandbox, use `ai sandbox show <branch | TASK-id | N>`: it prints that branch's worktree path and the per-tool state paths (Claude Code, Codex, Gemini CLI, OpenCode). The argument follows the same contract as `ai sandbox exec` and `ai sandbox start`, so `ai sandbox show 11` resolves the active task short id via `.agents/workspace/active/.short-ids.json`.

Breaking migration for the next major version: task short ids now use bare digits only. Replace `#NN` with `NN`; quoted `#NN` input is rejected.

On macOS, interactive `ai sandbox exec <branch>` sessions can bridge image paste into the sandbox. When you press `Ctrl+V` and the host clipboard currently holds an image, agent-infra reads the image from the host clipboard, writes a PNG under `~/.agent-infra/clipboard/`, and injects the container path as bracketed paste so Claude Code, Codex, Gemini CLI, and OpenCode can attach it. The host clipboard is only read, never rewritten. The bridge is best-effort: existing sandboxes must be rebuilt to receive the `/clipboard` mount, and if the optional pty dependency or clipboard probe is unavailable the session falls back to the normal interactive path. Set `AI_SANDBOX_NO_CLIPBOARD_BRIDGE=1` to skip the bridge and enter the normal interactive path directly when diagnosing mouse, scrolling, or other input issues.

When you run the sandbox over SSH, use `ai cp <ssh-alias>` on the Mac in front of you to push the local PNG clipboard image to a remote Mac or headless Linux host. Copy an image with Cmd+C, run `ai cp mini`, then return to the existing SSH session and press `Ctrl+V`. Darwin keeps the NSPasteboard path; Linux requires a compatible agent-infra receiver and stores the image under `~/.agent-infra/clipboard/` for the sandbox's read-only `/clipboard` mount. The command uses non-interactive ssh/scp with key-based authentication.

`ai sandbox exec` and `ai sandbox refresh` reconcile Claude Code credentials in both directions across the host credential store and every sandbox project copy under `~/.agent-infra/credentials/*`. When a long-running sandbox refreshes OAuth tokens first, the next entry or refresh command writes the freshest valid copy back to the host Keychain or `~/.claude/.credentials.json`; when the host is fresher, it updates the project copies. If every copy is stale, `ai sandbox refresh` probes `claude /status` and asks you to log in only when the probe cannot recover credentials.

When Claude Code is enabled, `ai sandbox create` also merges model and API provider settings from the host `~/.claude/settings.json` into the sandbox Claude Code settings. Existing sandbox values take precedence, so local sandbox overrides are preserved. Credentials still use the dedicated credentials channel above; provider environment settings are copied only as Claude Code settings values.

## Host-sandbox file exchange

`ai sandbox create` mounts two writable directories for dropping files between
the host and the sandbox without polluting the git worktree:

- `/share/common` <- `~/.agent-infra/share/<project>/common/` - visible to every
  sandbox of the same project, regardless of branch.
- `/share/branch` <- `~/.agent-infra/share/<project>/branches/<branch>/` -
  exclusive to the current branch sandbox.
- `/clipboard` <- `~/.agent-infra/clipboard/` - read-only image paste bridge
  storage on macOS.

These paths are intentionally hardcoded; there is no `.airc.json` knob. Both
host directories are created automatically on first `create`. When you
`ai sandbox rm <branch>`, you will be prompted (default yes) to clean up the
corresponding share dirs alongside the worktrees. `ai sandbox rm --all` batch
removes every sandbox **not bound to an active task** (i.e. the `-` rows in
`ai sandbox ls`); add `--dry-run` to preview or `--yes` to skip the confirmation
(required in non-interactive shells). `ai sandbox rm --purge` tears down **all**
project sandboxes (containers, worktrees, image, VM). **Breaking change:** prior
to this, `--all` meant the full teardown that `--purge` now performs.
Use `ai sandbox prune --dry-run` to inspect orphaned per-branch state dirs left
behind by older versions or interrupted cleanup, then `ai sandbox prune` to
remove only dirs without an active sandbox container.
Existing sandboxes pick up mount changes, including removed mounts, after
`ai sandbox rm <branch>` and `ai sandbox create <branch>`.

On first `ai sandbox create`, agent-infra writes a bilingual `README.md` into
`~/.agent-infra/share/<project>/common/` and each `branches/<branch>/`
directory to help you discover these channels. The READMEs are idempotent and
can be safely deleted; the scaffold only writes them when missing.

## User-level dotfiles channel

`ai sandbox create` also mounts an optional read-only channel for host user preferences:

- `/dotfiles` <- `~/.agent-infra/dotfiles/` - read-only, host-owned source.

The host tree mirrors the expected paths under the container `$HOME`, in the
same style as GNU stow or chezmoi:

```text
~/.agent-infra/dotfiles/
├── .tmux.conf
└── .config/
    ├── lazygit/config.yml
    └── yazi/yazi.toml
```

On each sandbox entry, `sandbox-dotfiles-link` links every file to
`$HOME/<relative-path>` with `ln -sfn`, overriding image defaults. If the host
directory does not exist, the mount and link step are skipped.

To add future preferences such as `starship.toml` or `.gitconfig.local`, put
files in `~/.agent-infra/dotfiles/`; no Dockerfile or `ai sandbox create`
changes are needed.

### Symlinks as pointers to host files

You can place symlinks inside `~/.agent-infra/dotfiles/` to point at real files
on your host:

```bash
ln -s ~/.tmux.conf ~/.agent-infra/dotfiles/.tmux.conf
ln -s ~/.config/lazygit ~/.agent-infra/dotfiles/.config/lazygit
```

Before each `ai sandbox create` and `ai sandbox enter`, agent-infra
dereferences the dotfiles tree into
`~/.agent-infra/.cache/dotfiles-resolved/<project>/` and mounts that snapshot
into the container. Editing the host source file, then re-entering the sandbox,
is enough to pick up the latest content.

Dangling symlinks are skipped with a stderr warning. Symlink cycles and deeply
nested directories beyond 32 levels are also skipped with a warning. Symlinks
pointing outside `$HOME` are accepted as long as the host user can read the
target.

> **Do not put secrets in `~/.agent-infra/dotfiles/`.** The mount is read-only
> inside the container, but the full preference tree is linked into every
> project sandbox. Do not place `.ssh/`, `.aws/credentials`, `.netrc`,
> `.gnupg/`, `.npmrc` files containing `_authToken`, AI tool OAuth/access token
> files, or `.gitconfig` there. Use the dedicated credential channels; GitHub
> access uses the `gh` / HTTPS token path. Prefer `.gitconfig.local` with
> `[include]` for local Git preferences.

**Protected paths** are ignored by the hook even if they appear under
`~/.agent-infra/dotfiles/`:

| Path pattern | Reason |
|---|---|
| `.ssh/*` | Host SSH material is protected and is not imported through the default sandbox. |
| `.gnupg/*` | GPG private material is managed by `gpg-agent`. |
| `.claude/*`, `.codex/*`, `.gemini/*` | AI tool credentials use dedicated bind mounts. |
| `.config/opencode/*`, `.local/share/opencode/*` | OpenCode credentials and data use dedicated bind mounts. |
| `.host-shell-config/*` | agent-infra managed shell and Git configuration. |
| `.gitconfig`, `.gitignore_global`, `.stCommitMsg`, `.bash_aliases` | agent-infra symlinks these to `.host-shell-config/`, including `safe.directory` and GPG sync state. |
| `README.md` | agent-infra scaffolds a discoverability README at the dotfiles root on first create; the link hook ignores it so `$HOME/README.md` is not shadowed. |

Other existing real directories, such as `~/.config/` or `~/.cache/`, are not
replaced by top-level dotfiles. If a file conflicts with one of those
directories, the hook prints a warning and skips it:

```text
sandbox-dotfiles-link: skipping /home/devuser/.config (existing directory; use nested path like .config/<file> instead)
```

Use nested paths such as `~/.agent-infra/dotfiles/.config/lazygit/config.yml`
instead of treating `.config` as a top-level file.
