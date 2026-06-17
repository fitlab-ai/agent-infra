# Sandbox

[← Back to README](../../README.md) · [中文](../zh-CN/sandbox.md)

## Sandbox aliases and GitHub CLI

`ai sandbox create` now bootstraps the host-side aliases file at `~/.agent-infra/aliases/sandbox.sh` on first run. The generated file includes ready-to-edit yolo shortcuts for Claude, Codex, Gemini CLI, and OpenCode, and every sandbox syncs that file into `/home/devuser/.bash_aliases`.

The sandbox image also preinstalls `gh`. When `gh auth token` succeeds on the host, `ai sandbox create` injects the token into the container as `GH_TOKEN`, so `gh` commands work inside the sandbox without extra setup.

`ai sandbox rebuild` keeps Docker's build cache by default, so it quickly retags the sandbox image without refreshing every package. Use `ai sandbox rebuild --refresh` when you want to upgrade the image: it passes `--no-cache --pull` to Docker, pulls the current Ubuntu base image, and reruns the apt, tmux build, and global npm install layers. Claude Code updates are disabled inside the container, and OpenCode startup update checks are disabled; `--refresh` is the routine upgrade path for sandbox-managed tools. Manual `opencode upgrade` remains outside this guard. The default `python3` provided by the Ubuntu 24.04 sandbox base is Python 3.12, so scripts that hard-code Python 3.10 paths may need adjustment.

`ai sandbox exec` also forwards a small terminal-detection whitelist (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`) into the container. This keeps interactive TUIs aligned with the host terminal for behaviors such as Claude Code's Shift+Enter newline support, without passing through the full host environment.

`ai sandbox start <branch | TASK-id | N | '#N'>` recovers a sandbox container that has stopped — for example after the host Docker daemon was restarted or replaced (a common case is installing OrbStack over an existing Docker), which leaves the container `Exited`. It only starts a container that already exists and is stopped; if none exists it points you to `ai sandbox create`, and a container that is already running is left untouched. `ai sandbox exec <branch>` performs the same recovery automatically: when the target container exists but is stopped, it starts the container first and then enters it. Because each worktree and per-AI state directory is persisted on the host, restarting a stopped container is safe and loses no data.

On macOS, interactive `ai sandbox exec <branch>` sessions can bridge image paste into the sandbox. When you press `Ctrl+V` and the host clipboard currently holds an image, agent-infra reads the image from the host clipboard, writes a PNG under `~/.agent-infra/clipboard/`, and injects the container path as bracketed paste so Claude Code, Codex, Gemini CLI, and OpenCode can attach it. The host clipboard is only read, never rewritten. The bridge is best-effort: existing sandboxes must be rebuilt to receive the `/clipboard` mount, and if the optional pty dependency or clipboard probe is unavailable the session falls back to the normal interactive path. Set `AI_SANDBOX_NO_CLIPBOARD_BRIDGE=1` to skip the bridge and enter the normal interactive path directly when diagnosing mouse, scrolling, or other input issues.

When you run the sandbox from a remote Mac over SSH, use `ai cp <ssh-alias>` on the Mac in front of you to push the local clipboard image to that remote Mac first. Copy an image with Cmd+C, run `ai cp mini`, then return to the existing SSH session and press `Ctrl+V`; the sandbox bridge reads the remote Mac's NSPasteboard and injects the image as usual. This command handles PNG images only and uses non-interactive ssh/scp with key-based authentication. For now both the sender and the remote must be macOS—the remote NSPasteboard is written via `osascript`—but the remote-write step is the natural extension point for other platforms later.

`ai sandbox exec` and `ai sandbox refresh` reconcile Claude Code credentials in both directions across the host credential store and every sandbox project copy under `~/.agent-infra/credentials/*`. When a long-running sandbox refreshes OAuth tokens first, the next entry or refresh command writes the freshest valid copy back to the host Keychain or `~/.claude/.credentials.json`; when the host is fresher, it updates the project copies. If every copy is stale, `ai sandbox refresh` probes `claude /status` and asks you to log in only when the probe cannot recover credentials.

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
`ai sandbox rm <branch>` or `ai sandbox rm --all`, you will be prompted (default
yes) to clean up the corresponding share dirs alongside the worktrees.
Use `ai sandbox prune --dry-run` to inspect orphaned per-branch state dirs left
behind by older versions or interrupted cleanup, then `ai sandbox prune` to
remove only dirs without an active sandbox container.
Existing sandboxes pick up these mounts after `ai sandbox rm <branch>` and
`ai sandbox create <branch>`.

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
> files, or `.gitconfig` there. Use the dedicated SSH and credential channels,
> and prefer `.gitconfig.local` with `[include]` for local Git preferences.

**Protected paths** are ignored by the hook even if they appear under
`~/.agent-infra/dotfiles/`:

| Path pattern | Reason |
|---|---|
| `.ssh/*` | Host SSH credentials are managed by the read-only SSH mount. |
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
