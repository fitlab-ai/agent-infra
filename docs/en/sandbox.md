# Sandbox

[← Back to README](../../README.md) · [中文](../zh-CN/sandbox.md)

## Build prerequisites and troubleshooting

Sandbox creation and rebuilding require Docker Buildx with a working BuildKit builder. agent-infra checks the selected engine and Docker context before inspecting or building an image:

```bash
docker buildx inspect --bootstrap
```

If this check fails, `ai sandbox create` and `ai sandbox rebuild` stop before `docker build` and print a repair hint. For Colima, install the missing plugin with `brew install docker-buildx`; a first-time Colima setup installs `colima`, `docker`, and `docker-buildx` together. For Docker Desktop or WSL2, upgrade or repair Docker Desktop. For native Docker Engine, install the Buildx CLI plugin supplied for your distribution. OrbStack users should upgrade or repair OrbStack if its builder is unavailable.

The built-in image also verifies that `cc-token-status`, `sandbox-dotfiles-link`, and `sandbox-tmux-entry` are non-empty and executable during the Docker build. A build cannot succeed with the empty scripts produced by a legacy builder. Custom Dockerfiles still require BuildKit, but they are not required to contain these built-in scripts.

## PID 1 and orphan process reaping

Every newly created sandbox enables Docker's managed init with `docker run --init`. The init process becomes PID 1, forwards signals, and reaps orphaned child processes so repeated builds, tests, and detached work do not accumulate zombies. This setting applies when a container is created or explicitly recreated; existing containers retain their previous PID 1 until you run:

```bash
ai sandbox start --recreate <task-ref-or-branch>
```

Recreation preserves the worktree, task binding, mounts, and `/share` data while replacing the container-local process state.

## Sandbox aliases and GitHub CLI

`ai sandbox create` now bootstraps the host-side aliases file at `~/.agent-infra/aliases/sandbox.sh` on first run. The generated file includes ready-to-edit yolo shortcuts for Claude, Codex, Antigravity CLI, and OpenCode, and every sandbox syncs that file into `/home/devuser/.bash_aliases`.

The default sandbox image also installs the agent-infra CLI npm package, exposing both `ai` and `agent-infra` on the container `PATH`. Inside a task-bound worktree, lifecycle skills and suitable task commands infer the unique active task whose `task.md` branch exactly matches the current symbolic branch; use `--task <ref>` / `-t <ref>` to select an explicit task. Positional task refs are rejected. Commands with another positional operand use forms such as `ai task cat analysis`, `ai task decisions --item 1`, and `ai decide --item PL-1 <decision>`. `ai task grep <pattern>` also resolves the unique current task; use `--task <ref>` to select another task. Host-side `ai run` uses `--skill <skill> --task <task-ref>` to select the target branch and sandbox; `create-task` uses `--skill create-task <description>`. Existing sandbox images and containers need a refreshed rebuild and recreation before they pick up this newly managed tool.

The sandbox image also preinstalls `gh`. When `gh auth token` succeeds on the host, `ai sandbox create` injects the token into the container as `GH_TOKEN`, so `gh` commands work inside the sandbox without extra setup.

Host `~/.ssh` is not bind-mounted into the sandbox. GitHub access is expected to use the `gh` / HTTPS token path above; `git@github.com:*` SSH workflows need a separate, explicit setup outside the default sandbox boundary.

## Agent Client capabilities

The canonical `agentClients` entries control which Agent Clients are installed
and mounted in a sandbox. `installInSandbox` is independent from `enabled`:
the former controls sandbox capabilities, while the latter controls project
assets and integrations.

```json
{
  "agentClients": [
    { "id": "claude-code", "enabled": true, "installInSandbox": false },
    { "id": "codex", "enabled": true, "installInSandbox": true },
    { "id": "antigravity-cli", "enabled": false, "installInSandbox": false },
    { "id": "opencode", "enabled": false, "installInSandbox": false }
  ]
}
```

Agent Client adapters declare their image package, version command, state
directory, credential/config mounts, setup hint, aliases, and bounded lifecycle
hooks. Non-client tools such as `agent-infra` and configured custom tools remain
independent of this selection. After changing `installInSandbox`, rebuild the
image and recreate affected containers. Runtime capability labels let start,
exec, and recovery reject containers whose selected mounts or hook policy no
longer match the current configuration.

For Claude Code, setting `installInSandbox` to `false` is the supported uninstall path. Rebuild and recreate the affected sandbox to converge the tool, credential mount, and hooks away. Host `~/.claude` data, Keychain credentials, plugins, history, and `~/.agent-infra/credentials/<project>/claude-code` remain intact; turning the setting back on reuses that host-owned state.

The Antigravity adapter uses the [official installer](https://antigravity.google/docs/cli/install),
runs the `agy` binary, and pre-seeds its settings, keybindings, and MCP configuration
under the [official configuration directory](https://antigravity.google/docs/cli/settings).
Run `agy` inside a newly created container once to complete authentication.

The OpenCode adapter installs `opencode-ai` through the shared Node/npm image
layer and keeps each branch in one persistent volume at
`/home/devuser/.local/share/opencode`. Inside that volume, OpenCode uses
`XDG_CONFIG_HOME=.local/share/opencode/.xdg/config` and
`XDG_STATE_HOME=.local/share/opencode/.xdg/state`; its normal data root remains
`/home/devuser/.local/share`. The adapter reads and writes only the canonical XDG
configuration. The host config contributes only missing string `model` and
`small_model` values. The host `XDG_DATA_HOME/opencode/auth.json` file is the
only live credential mount, and it is optional for version/help smoke checks.

Disabling or uninstalling OpenCode removes only adapter-managed project assets
and selection state. It does not delete the host XDG directories, branch runtime
volume, user-authored commands, or other non-managed runtime data. Re-enable the
adapter to reuse that preserved state.

Disabling a client never deletes its host credentials, configuration, or
history. `sandbox show` lists only currently selected tools, even when disabled
client state remains on the host. Host state is considered for deletion only by
explicit cleanup commands such as `sandbox rm` or `sandbox prune`.

Adapter hooks run serially with a 30-second default deadline and a five-minute
maximum. Creation-phase timeouts are fatal, entry refresh timeouts are warnings,
and recovery inspection timeouts make the container unhealthy. This timeout is
an internal safety boundary, not a user configuration option.

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

Use `ai sandbox create <branch> --inherit-build-proxy` or `ai sandbox rebuild --inherit-build-proxy` (`-B`) to pass non-empty uppercase `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` values to managed Dockerfile network build steps for that invocation. Values stay in the Docker child-process environment and are exposed to those steps through temporary BuildKit secret mounts; Docker argv and image metadata contain only secret names. This switch is independent of runtime `-P`, is rejected for custom Dockerfiles, and requires Docker Engine >=20.10.0 plus every visible BuildKit node >=0.9.0.

The switch does not configure the Docker daemon or builder. Image pulls and `FROM` resolution still require proxy configuration in native Docker, Docker Desktop, OrbStack, Colima, or the WSL2 Docker integration. When `-B` is omitted, image inspection and build behavior remain unchanged.

`ai sandbox rebuild` keeps Docker's build cache by default, so it quickly retags the sandbox image without refreshing every package. Use `ai sandbox rebuild --refresh` when you want to upgrade the image: it passes `--no-cache --pull` to Docker, pulls the current Ubuntu base image, and reruns the apt, tmux build, and global npm install layers. Claude Code updates are disabled inside the container, and OpenCode startup update checks are disabled; `--refresh` is the routine upgrade path for sandbox-managed tools. Manual `opencode upgrade` remains outside this guard. The default `python3` provided by the Ubuntu 24.04 sandbox base is Python 3.12, so scripts that hard-code Python 3.10 paths may need adjustment.

`ai sandbox exec` also forwards a small terminal-detection whitelist (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`) into the container. This keeps interactive TUIs aligned with the host terminal for behaviors such as Claude Code's Shift+Enter newline support, without passing through the full host environment.

`ai sandbox start`, `ai sandbox exec`, and sandbox-backed `ai run` now share one readiness check before they run user work. After a stopped container starts, agent-infra restores tmpfs ownership, rehydrates every seed that is still mounted in the container, recreates the built-in Codex prompts link, and verifies mount topology, shell aliases, Codex availability, state-directory writability, and the entries copied during that recovery. A running container receives a non-destructive structural check: existing writable seed targets are preserved even when their content, timestamp, or inode differs from the host staging copy. Recovery does not replay custom `postSetupCmds`, and custom `versionCmd` results remain advisory.

## Task-scoped workspace identity

Every sandbox has an explicit workspace identity. A branch-only sandbox uses non-overlapping read-only directory mounts for `active`, `completed`, `blocked`, and `archive`. A task-bound sandbox replaces the `active` directory mount with a read-only `.agents/workspace/active/.short-ids.json` file, keeps `completed`, `blocked`, and `archive` read-only, and overlays only `.agents/workspace/active/<TASK-id>` as writable. The active ancestor itself is supplied by the writable `/workspace` worktree; the host workspace root is never mounted, and tasks in every other state remain invisible.

When a task-bound container still exists after its task moves to `completed`, `ai sandbox exec <branch>` may re-enter that same container after verifying the container label, the unique completed task, the branch, the task view, and the historical task mount. This re-entry uses the full task ID internally and does not restore or allocate an active short ID. If completed readiness fails, or if `ai sandbox exec --recreate <branch>` is requested, the command fails closed and leaves the original container untouched. Enter the existing container manually, or explicitly run `ai sandbox rm <TASK-id>` followed by `ai sandbox create <branch>` to start a new branch-only sandbox. `ai sandbox rm` is the full interactive sandbox cleanup path, not a container-only delete: it may remove the worktree, local branch, tool/shell state, and branch share.

Both identities may create a new task through the dedicated typed `task-create` control request. The sandbox AI writes one versioned candidate JSON file; the host validates it, derives host-owned metadata, atomically persists the task, allocates its short id, and attempts platform synchronization. This exception grants creation only: it does not expose the host workspace, permit lifecycle or orchestration in branch-only mode, mount the new task, or change the current sandbox identity.

Creation retries have two identities. Reusing an outer request id is rejected even after a broker restart. After a timeout, the caller uses a new outer id but reuses the original immutable candidate file and business idempotency key; semantically identical JSON returns the original task as `no-op`, while changed field values fail closed. Platform failures retain the local task and short id and return a structured warning.

Task lifecycle, finalization, and orchestration use one typed Task Control Authority with separate transport entries. Direct-host commands call the local authority adapter and do not create a broker, control channel, manifest, or sandbox authority root. A sandbox client only creates a control request; the broker-spawned executor becomes the authority caller only after the gate, current manifest, request, owner, lease, and controller checks pass. Branch-only containers, mismatched IDs, unknown command families, and stale shared-workspace containers fail closed. `ai sandbox ls` exposes `WORKSPACE` and `TASK` columns, while `ai sandbox show` reports the same label-derived identity.

The parent-plus-child bind topology from v0.9.7 is legacy and intentionally incompatible with the current per-state topology. On upgrade, or when old code encounters a newer per-state container during rollback, the check fails closed; run `ai sandbox start --recreate <task-ref-or-branch>` once. Container-local processes, tmux sessions, the writable layer, ordinary `/tmp`, and RAM state may be lost, while the worktree, local branch, and host-managed task/tool data are preserved.

The control broker publishes a read-only health view inside the container and remains alive while one authorized request runs in a separately tracked process group. Requests carry a per-sandbox generation and a two-second absolute admission deadline. The broker reports `healthy`, `busy`, or `parked`, rejects expired or stale-generation work before acceptance, and terminates a recovered orphan process tree before serving new work. A caller may retry a pre-acceptance `BUSY` or deadline rejection with a new request ID, but must not automatically retry after acceptance when the final result is unknown.

Control timing is centralized in an injectable policy: the production defaults are a 250 ms control tick, 5 s slow checks and container heartbeat, 1 s initial parked backoff growing to 5 s, and a 7 s quiesce deadline. Tests may supply shorter values without changing the safety state machine. The canonical control manifest has one current, versionless schema containing the exact container identity, controlled labels, and root-relative `runtimeDir`; request, response, status, lease, execution, broker-owner, and controller records retain their own independent protocol versions. Materialization creates the control directories and an in-memory draft only. After container identity and labels are inspected, finalization atomically publishes the complete manifest, and only then may the broker start. A missing, versioned, incomplete, or unknown manifest fails closed with a container-only recreation/rebuild instruction; it is not parsed or migrated as a compatibility format. Task-bound containers mount `runtimeDir` read-write at `/run/agent-infra/runtime`, with client state under `runtime/clients/<client>/<store>`, while direct-host execution uses the repository-local `.agents/workspace/.runtime/codex-*` fallback. Failed or uncertain replacement operations retain the control root and evidence.

Explicit `ai sandbox rm` and `--purge` use the exact recorded container ID. They quiesce the broker and executions, wait through the soft-stop phase, remove the exact container, verify authoritative exact-ID absence, recheck the manifest and owner generation, and only then use remaining-deadline force cleanup. A not-found result for the exact ID is not confused with a newly recreated container using the same name. Unknown inspection, removal failure, owner replacement, or an exhausted deadline leaves the control root and evidence in place for a later controlled retry.

Host-dependent checks run through the internal `agent-infra-internal task-validate <branch | task-ref> [--scope snapshot|inplace] [--timeout <ms>] [--format text|json] -- <command>` entry point, mechanically invoked by the `run-manual-validation` skill. The default `snapshot` scope runs the command in a temporary detached worktree at the task branch commit and always removes it. `inplace` acquires a host-owned lease, waits for the broker to park, stops the sandbox container, runs against the original worktree, and then restores the branch, container, lease, and broker health. Readiness treats task view, runtime, and control as separate signals; the runtime signal performs a non-destructive write/read/delete probe. A fresh readiness check may restart once for a settling runtime mount, but readiness never rotates a generation or cleans old runtime evidence. The `run-manual-validation` skill records sanitized `validation-run` evidence; `complete-manual-validation` remains the separate maintainer confirmation step.

If in-place recovery fails, the command stops before entering the container or scheduling tmux. It does not replace the container automatically. For active and branch-only sandboxes, pass `--recreate` to authorize a container-only fallback: `ai sandbox start --recreate <target>`, `ai sandbox exec --recreate <target> [cmd...]`, or `ai run --skill <skill> --task <task-ref> --recreate`. For `sandbox exec`, only a flag before the target is interpreted by the host; `--recreate` after the target is passed to the container command. Completed task-bound re-entry is the exception: readiness failure and `ai sandbox exec --recreate <branch>` are rejected without invoking replacement. The error gives a manual `docker exec` path and, if the user explicitly wants a new branch-only sandbox, the separate `ai sandbox rm <TASK-id>` and `ai sandbox create <branch>` commands. `ai sandbox rm` is the full interactive sandbox cleanup path, not a container-only delete; it may remove the worktree, local branch, tool/shell state, and branch share. Replacement preserves the worktree, local branch, host-managed tool seeds, shell configuration, and `/share` data, but discards the old container ID, writable layer, ordinary `/tmp`, processes, tmux sessions, and other RAM state. It never performs a full `ai sandbox rm`.

Tmpfs runtime data is deliberately ephemeral. Codex databases, logs, sessions, and other non-seeded files under `/home/devuser/.codex` cannot be recovered after tmpfs loss. Declared seed entries such as `config.toml` and `model-catalogs` are reconstructable from their read-only staging mounts; bind-mounted worktrees, credentials, shell configuration, and share directories remain host-persistent.

`ai sandbox ls` keeps a compact view: it lists only the Containers table for the current project (the `#` row number, the `SHORT` task short id, names, status, workspace identity, full task ID, and branch). It no longer prints the worktree list or each tool's state paths. To inspect those details for one sandbox, use `ai sandbox show <branch | TASK-id | N>`: it prints the label-derived workspace identity, that branch's worktree path, and the per-tool state paths (Claude Code, Codex, Antigravity CLI, OpenCode). The argument follows the same contract as `ai sandbox exec` and `ai sandbox start`, so `ai sandbox show 11` resolves the active task short id via `.agents/workspace/active/.short-ids.json`.

Breaking migration for the next major version: task short ids now use bare digits only. Replace `#NN` with `NN`; quoted `#NN` input is rejected.

On macOS, interactive `ai sandbox exec <branch>` sessions can bridge image paste into the sandbox. When you press `Ctrl+V` and the host clipboard currently holds an image, agent-infra reads the image from the host clipboard, writes a PNG under `~/.agent-infra/clipboard/`, and injects the container path as bracketed paste so Claude Code, Codex, Antigravity CLI, and OpenCode can attach it. The host clipboard is only read, never rewritten. The bridge is best-effort: existing sandboxes must be rebuilt to receive the `/clipboard` mount, and if the optional pty dependency or clipboard probe is unavailable the session falls back to the normal interactive path. Set `AI_SANDBOX_NO_CLIPBOARD_BRIDGE=1` to skip the bridge and enter the normal interactive path directly when diagnosing mouse, scrolling, or other input issues.

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
corresponding share dirs alongside the worktrees. `ai sandbox rm --unbound`
batch-removes every sandbox **not bound to an active task** (i.e. the `-` rows
in `ai sandbox ls`); add `--dry-run` to preview or `--yes` to skip the ordinary
confirmation (required in non-interactive shells). `ai sandbox rm --purge`
tears down **all** project sandboxes (containers, worktrees, image, VM).
**Breaking change:** `--all` has been removed; old calls fail with a migration
error and must use `--unbound`.

All removal paths inspect every target worktree before destructive cleanup.
Staged, unstaged, conflicted, or non-ignored untracked changes make batch,
purge, prune, `--yes`, and other non-interactive removal fail closed. A single
interactive `ai sandbox rm <branch>` may discard changes only after displaying
the exact dirty snapshot and receiving a separate confirmation that defaults
to no. If the snapshot changes before deletion, authorization expires.
Use `ai sandbox prune --dry-run` to inspect orphaned per-branch state dirs left
behind by older versions or interrupted cleanup, then `ai sandbox prune` to
remove only dirs without an active sandbox container.
Existing sandboxes pick up managed mount changes, including removed mounts, with
`ai sandbox start --recreate <task-ref-or-branch>`. The readiness check detects the stale mount plan before authorizing container-only replacement, and the worktree is preserved.

On first `ai sandbox create`, agent-infra writes a bilingual `README.md` into
`~/.agent-infra/share/<project>/common/` and each `branches/<branch>/`
directory to help you discover these channels. The READMEs are idempotent and
can be safely deleted; the scaffold only writes them when missing.

## Broker–sandbox control protocol

The host broker and the sandbox client communicate through a bind-mounted control
root containing JSON files. This is a file protocol, not HTTP, TCP, or a Unix
socket. The broker is the only process allowed to execute host-side task
operations; the executor child receives a one-shot IPC gate and does not get
control-root authority from the sandbox.

### Transport topology

The relevant records are laid out as follows (the exact root is recorded in the
manifest and is not necessarily the same host path as the container path):

```text
control-root/
├── manifest.json
├── broker.json
├── channel/
│   ├── requests/<request-id>.json
│   └── responses/
│       ├── <request-id>.accepted.json
│       ├── <request-id>.payload.json   (optional output payload)
│       └── <request-id>.json
├── processing/<request-id>/
│   ├── request.json
│   ├── execution.json
│   ├── reservation.json
│   └── result.json
├── consumed/<request-id>
├── public/status.json
└── audit.ndjson
```

The client first checks the generation and broker heartbeat in `status.json`.
It then writes a request to a private temporary file and renames it to
`requests/<request-id>.json`. A request contains the protocol version, request
identity, sandbox token, generation, absolute admission deadline, control
family, and family-specific arguments. The broker claims it by renaming it into
`processing/<request-id>/request.json`, creates the consumed marker, validates
the manifest binding and deadline, and records the child identity in
`execution.json`.

Acceptance is an independent durable marker in
`responses/<request-id>.accepted.json`. It means that the request was admitted;
it is not the command result. The terminal response is published once at
`responses/<request-id>.json` and is never replaced. Clients may read that
terminal response more than once, including after a client or broker restart;
reusing a request ID is still a replay and must not execute the operation again.

### Result evidence and completion order

After the executor child closes, the broker parent redacts the manifest token
from stdout and stderr, then calculates their UTF-8 byte counts and SHA-256
digests. It writes and strictly reads back a
small `processing/<request-id>/result.json` before marking the in-memory
execution settled:

```json
{
  "version": 1,
  "id": "<request-id>",
  "generation": "<generation>",
  "exitCode": 0,
  "stdoutBytes": 128,
  "stderrBytes": 0,
  "stdoutSha256": "<64 lowercase hex characters>",
  "stderrSha256": "<64 lowercase hex characters>",
  "captureState": "metadata-only"
}
```

This record is transport evidence, not a task receipt and not a replacement for
the terminal response. It deliberately contains no token, executor nonce, gate
owner, PID, environment, host path, or raw output. `metadata-only` means that a
restart can prove the child exit and its output metadata, but cannot recreate
the complete output from this record alone.

The commit order is:

```text
child close
  → result.json atomic publish + read-back
  → optional redacted payload atomic publish + read-back
  → terminal response publish + read-back
  → remove processing evidence
```

If the broker restarts after a valid result record but before terminal cleanup,
generic process-control families can converge to a terminal response with
output unavailable. Task finalization is stricter: a successful exit code is
not proof of task completion; the canonical host finalization receipt remains
the business authority. If result evidence is absent or malformed, the broker
keeps the request uncertain/unknown and does not create a new ID or replay a
mutation.

The authority and lifetime of each record are intentionally different:

| Record | Writer | Lifetime | Authority |
| --- | --- | --- | --- |
| `request.json` | client, then broker by claim rename | until claim cleanup | input only |
| `execution.json` | broker | while the child is prepared/running | process identity/recovery hint |
| `reservation.json` | broker | from admission until terminal cleanup | generation quota reservation |
| `result.json` | broker parent | until terminal commit | process-outcome evidence |
| payload record | broker | generation lifetime, only when terminal references it | redacted output body |
| terminal response | broker | generation retention | transport commit point |
| finalization receipt | host finalization | task lifecycle | business completion authority |

The client never treats `accepted`, `result.json`, or a payload candidate as
success. It returns only a validated terminal response. This separation is what
prevents a broker restart from turning an incomplete observation into a second
host mutation.

Recovery seams are deterministic: a child that has not produced a valid result
remains unknown; a valid generic result can produce an output-unavailable
terminal; a finalization result still requires its host receipt; and an already
published terminal is read-only and preserved.

### Capacity and retention (HD-3/A)

The three profile limits are independent:

- `maxLogicalRecords = 1024`: the maximum number of retained logical control
  records in one generation.
- `maxResponseBytes = 64 MiB`: the total persistent response budget, including
  response/result/payload data and reservations; it is not the size of one
  ordinary stdout string.
- `maxTerminalRecordBytes = 1 MiB`: the upper bound for the compact terminal
  envelope. It is separate from optional output payload storage.

Result evidence is compact and covered by each request's base reservation; it
is not a fourth public capacity metric. Terminal records are retained for the
generation. Processing/result evidence is temporary and may be removed only
after terminal publication and verification. During recovery, temporary files
are never treated as authoritative records.

Before writing the accepted marker, the broker reserves the fixed base budget
for the request's accepted marker, compact terminal, and result evidence. The
reservation is one logical record and cannot be bypassed by a later payload.
The broker rejects admission when the generation would exceed either 1024
logical records or 64 MiB of retained terminal, payload, and reservation
storage. A result larger than the 1 MiB compact envelope may be stored as a
separate redacted payload, provided the remaining generation budget permits it;
the terminal then contains only its byte counts and SHA-256 references. If the
payload cannot be retained, the terminal is still committed with
`outputState: "unavailable"`.

Logical records are counted once: a terminal record or an in-flight reservation
for the same request occupies one slot. On successful terminal commit, the
temporary request, execution, result, and reservation records are removed;
only a terminal and its referenced payload remain. An unreferenced payload is
removed during the same cleanup. This makes the quota restart-safe and keeps a
payload from becoming an independent result authority.

For maintenance, inspect only the metadata needed to diagnose a request. Do not
copy request tokens, execution nonces, PIDs, environment values, host paths, or
raw terminal output into Issues, audit attachments, or general logs. A client
that times out after acceptance should use the same request ID with the control
recovery operation; it must not submit a new request for an irreversible
finalization.

The current protocol uses request version 3 and response version 2. Older
response layouts are not adapted or dual-written; an invalid or mixed
generation must fail closed and the sandbox should be recreated from its
current manifest. Payload records are addressed only by the same request ID
and generation as their terminal reference; they are not inferred from
`result.json` and cannot authorize a task mutation.

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
| `.config/opencode/*`, `.local/share/opencode/*` | OpenCode host data stays outside dotfiles; only `auth.json` uses its dedicated live mount. |
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
