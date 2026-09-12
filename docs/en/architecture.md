# Architecture Overview

[← Back to README](../../README.md) · [中文](../zh-CN/architecture.md)

agent-infra is intentionally simple: a bootstrap CLI creates the seed configuration, then AI skills and workflows take over.

## End-to-End Flow

1. **Install** — `npm install -g @fitlab-ai/agent-infra` (or `brew install fitlab-ai/tap/agent-infra` on macOS, or use the shell script wrapper)
2. **Initialize** — `ai init` in the project root to generate `.agents/.airc.json` and install the seed command
3. **Render** — run `update-agent-infra` in any AI TUI to detect the bundled template version and generate managed files
4. **Develop** — use the user-facing skill sequence below. Internal workflow labels are not skill entry points.
5. **Update** — run `update-agent-infra` again whenever a new template version is available

```mermaid
flowchart TD
  CT["create-task"] --> A["analyze-task"] --> RA["review-analysis"]
  RA --> P["plan-task"] --> RP["review-plan"]
  RP --> C["code-task"] --> RC["review-code"]
```

Delivery after `review-code` is conditional: the workflow may enter `commit`, `create-pr`, `watch-pr`, or `complete-task` according to the reviewed tree, PR state, and checks.

## Layered Architecture

```text
┌───────────────────────────────────────────────────────┐
│                     AI TUI Layer                      │
│  Claude Code · Codex · Antigravity · OpenCode         │
└──────────────────────────┬────────────────────────────┘
                           │ slash commands
                           ▼
┌───────────────────────────────────────────────────────┐
│                     Shared Layer                      │
│         Skills  ·  Workflows  ·  Templates            │
└──────────────────────────┬────────────────────────────┘
                           │ renders into
                           ▼
┌───────────────────────────────────────────────────────┐
│                    Project Layer                      │
│               .agents/  ·  AGENTS.md                  │
└───────────────────────────────────────────────────────┘
```

## Runtime and Control-Plane Map

The runtime views are intentionally split. The first view answers only: which entry points and core long-lived components exist, where they live, and how many instances may exist. The second view explains only the short-lived processes derived by one accepted request.

### 1. Highest-level core topology

```mermaid
flowchart LR
  classDef process fill:#e8f1ff,stroke:#2563eb,color:#111827;
  classDef boundary fill:#fefce8,stroke:#a16207,color:#111827;
  classDef external fill:#f3f4f6,stroke:#6b7280,color:#111827;

  subgraph I["ENTRIES · entry family"]
    CLI["EXTERNAL ENTRY<br/>local user / CLI"]:::external
    IM["EXTERNAL ENTRY<br/>IM provider"]:::external
    D["PROCESS<br/>ai server daemon<br/>[0..1 / checkout]"]:::process
    IM --> D
  end

  subgraph H["HOST OS · host boundary"]
    HC["PROCESS<br/>host-control service<br/>[0..1 / host]"]:::process
  end

  subgraph F["SANDBOX FLEET · repeated per sandbox"]
    C["CONTAINER INSTANCES<br/>[0..N / host]"]:::boundary
    B["PROCESS × N<br/>sandbox broker<br/>[1 / sandbox]"]:::process
    C --> B
  end

  CLI -. host or sandbox request .-> HC
  D -. host or sandbox request .-> HC
  CLI -. task-bound request .-> C
  D -. task-bound request .-> C
```

This is the primary architecture picture:

- `local user / CLI` and `IM provider` are the two entry families.
- `ai server daemon` is an optional IM entry process: at most one per checkout. A local CLI does not require it.
- `host-control service` is one host-level service: `[0..1 / host]`.
- `CONTAINER INSTANCES` means one Docker container per sandbox, `[0..N / host]`. It is a sandbox boundary and count, not another project process.
- Every sandbox has one `sandbox broker`, `[1 / sandbox]`. The broker is the sandbox's long-lived control process.
- Dashed arrows show which control route an entry may select. They are not a fixed parent-child process chain. The transient dispatch implementation is intentionally hidden here.

The container engine and OS service manager own infrastructure around this picture, but they are not one process per sandbox and are not included in the core process count. User-created programs inside a sandbox are also outside this architecture view.

| Core item | Multiplicity | Meaning |
| --- | --- | --- |
| Local CLI entry | `0..N / invocation` | A user-facing entry; it may select a host or task-bound sandbox route. |
| IM provider entry | `0..N / provider` | An external message source. |
| `ai server daemon` | `0..1 / checkout` | The optional process that admits IM traffic for one checkout. |
| `host-control service` | `0..1 / host` | The host-side control service and direct-host authority. |
| Docker sandbox container | `0..N / host` | One isolated container instance per sandbox. |
| `sandbox broker` | `1 / sandbox` | One control broker inside each sandbox container. |

### 2. One-request derived processes

```mermaid
flowchart TD
  REQUEST["one accepted control request"]
  HOST["host-control service<br/>[0..1 / host]"]
  HW["temporary host-control worker<br/>[0..1 / request]"]
  BROKER["sandbox broker<br/>[1 / sandbox]"]
  EXEC["temporary sandbox executor<br/>[0..1 / accepted request]"]

  REQUEST -->|host request| HOST --> HW
  REQUEST -->|task-bound request| BROKER --> EXEC
```

The `sandbox executor` is not another sandbox and not another broker. It is a short-lived project-controlled worker created only after a broker accepts one authorized control request; it performs that request and then exits. With no accepted request, there is no executor. The host-control worker has the same relationship to one host-side request.

This lower view does not enumerate the programs a user starts inside the container. Those programs are variable, user-owned, and outside the project's fixed process topology.

### Entry and request boundaries

- A local CLI is a direct entry family. It can select host control or a task-bound sandbox without requiring the IM daemon.
- An IM message enters through the optional `ai server daemon`, which admits the request and selects the same host or sandbox control boundary.
- Host control and the sandbox broker are separate control boundaries. Host control owns host-side authorization and workers; the broker owns sandbox-side authorization and the executor for one accepted request.
- The task lifecycle logic that validates task files and transitions is in-process domain logic, not a process and not part of the highest-level process count.

## Core Component Matrix

| Component | Start / stop | Communication | Boundary and count | Durable facts | Failure boundary |
| --- | --- | --- | --- | --- | --- |
| Local CLI entry | Started by a user invocation; ends with that invocation | Local process arguments and standard streams | Host user entry; `0..N / invocation` | Command result and any task receipt | The command result does not prove that a remote or sandbox operation completed. |
| IM provider entry | External provider delivers messages; the provider owns its connection lifecycle | Provider API or long-lived adapter connection | External identity; not an OS process in this repository | Provider message and reply evidence | Provider, credential, and connection failures remain outside local task authority. |
| `ai server` daemon | `ai server start` starts at most one daemon per checkout; signals stop it | Provider adapter and admitted request dispatch | Host user process; `0..1 / checkout` | Checkout-scoped PID identity and daemon logs | Stale identity or adapter failure must not be confused with task success. |
| `host-control` service | OS user service manager starts/stops one service per host | Private host endpoint and request/response records | Host user boundary; `0..1 / host` | Endpoint, token, audit, and worker records | Missing authority fails closed; accepted work is not silently replayed after an uncertain result. Direct-host `create-task` is a separate in-process path. |
| Docker sandbox container | Container engine creates/stops one container per sandbox | Container runtime and mounted task projection | Sandbox boundary; `0..N / host` | Container identity, generation, and sandbox control records | Container availability alone does not prove host-control or task-lifecycle readiness. |
| Sandbox broker | Starts with its sandbox control state and stops with that sandbox | Sandbox control channel and request records | One broker inside each sandbox; `[1 / sandbox]` | Manifest, lease, owner, generation, and execution audit | Stale identity, lease, or admission failure is rejected before execution. |

## Detailed Runtime and Evidence Matrix

The following lower-level entries explain project-owned runtime behavior without changing the highest-level process count. They are intentionally separated by kind: short-lived child processes are not long-lived services, and in-process logic is not a process. User-created programs inside a sandbox remain outside the fixed inventory.

| Entry | Kind and multiplicity | Responsibility | Evidence or boundary |
| --- | --- | --- | --- |
| IM adapter / long connection | In-process adapter inside `ai server`; one active adapter per configured provider | Receives provider messages and hands admitted requests to local dispatch | Provider identity, connection state, and reply evidence |
| Message-scoped local `ai` child | Temporary child; `0..N / message` when the IM path invokes the local CLI | Executes one admitted local command; not a resident service | Child exit result and captured command outcome |
| Host-side AI TUI invocation | Temporary child; `0..1 / host-side run` | Runs the selected non-interactive client for a host-side `ai run` | Child exit code or signal; it is not a sandbox process |
| `ai run` request launcher | Temporary dispatch process; `0..1 / invocation` | Selects host execution or a task-bound sandbox route | Selected route, task reference, run receipt, and terminal result |
| Task Control Authority | In-process domain logic, not a process | Authorizes task creation, lifecycle transitions, finalization, and orchestration | Typed request, identity, lease, controller, and lifecycle records |
| Codex lifecycle controller / App Server | Controller logic with a short-lived `codex app-server --stdio` child when Codex evidence is collected | Verifies fresh child identity, thread metadata, model, effort, and terminal state | Hook records, App Server responses, and lifecycle evidence |
| Container engine / OS service manager | External infrastructure; host-level services, not one process per sandbox | Starts/stops host-control and creates/stops Docker containers | Service identity, container identity, generation, and readiness checks |
| Platform synchronization boundary | External integration boundary, not a process | Publishes task state and completion evidence to the configured platform | Synchronization receipt and platform response |

These entries explain the implementation and evidence paths below the core topology. They do not turn the temporary launcher, local child, TUI invocation, or in-process authority into additional core services. The diagram also deliberately does not enumerate tmux, run scripts, sandbox TUIs, or other user-created programs inside a sandbox.

## Control and Lifecycle Views

These views describe requests and state, not additional processes. They are deliberately below the core topology.

```mermaid
flowchart TD
  ENTRY["local CLI or IM entry"] --> ROUTE{"selected boundary"}
  ROUTE -->|create-task without task ref| CREATE["host-side task-create path"]
  ROUTE -->|direct-host task control| HC["host-control service"]
  ROUTE -->|task-bound sandbox| SB["sandbox container + broker"]
  CREATE --> DOMAIN["task-create domain logic"]
  HC --> HW["one host request worker, when needed"]
  SB --> EX["one sandbox executor, when an accepted request needs it"]
  DOMAIN --> STATE["task lifecycle state and receipt"]
  HW --> STATE
  EX --> STATE
```

`task.md`, lifecycle journals, artifacts, receipts, and platform records are facts owned by their respective lifecycle operations. They are not processes and are not counted in the highest-level topology.

| Operation | Selected boundary | Authoritative result | Recovery rule |
| --- | --- | --- | --- |
| Create | Direct-host task-create domain when no broker transport is selected; broker-client request when sandbox transport is selected | `task.md`, task directory, short ID, and create receipt | Reconcile partial writes before retrying. Direct-host create does not require an existing host-control service; broker-client create requires the sandbox control boundary. |
| Task event or artifact | Host-control or sandbox broker path | Event/artifact provenance and task state | Preserve the receipt; do not guess after an accepted unknown result. |
| Restore | Lifecycle request boundary | Task directory, journal, registry, and final state | Reconcile journal and final directory before retrying. |
| Block or cancel | Authorized lifecycle boundary | Status, reason, journal, and released resources | Stop at the first unknown side effect. |
| Complete | Lifecycle and artifact gates | Completed state, receipts, review, and platform evidence | Missing evidence keeps completion closed. |

### Control path details

- The IM adapter admits a message to the optional daemon, which may create a temporary local `ai` child. A local CLI invocation can enter `ai run` directly and bypass the daemon.
- The `ai run` launcher executes a no-task-reference request through the host-side TUI child. A task reference selects the matching sandbox route; the sandbox's internal user-created programs are outside this overview.
- `create-task` is a distinct conditional path. `resolveSandboxControlTransport()` selects the broker-client only when sandbox markers are present; otherwise the command calls the task-create domain directly in the host process. This direct-host create path is not the same thing as a long-lived host-control service and is not host-control-only.

### Completion and recovery facts

- A host command returning an exit code proves only that the selected host-side child ended; a sandbox dispatch receipt proves only the broker/executor boundary's recorded result.
- A `run` terminal result and a task lifecycle terminal state are separate facts. Task completion still requires its lifecycle and artifact gates.
- Codex lifecycle evidence has its own controller, App Server, hook, and terminal-state checks. A missing or conflicting child identity is not treated as success.
- Rejected, failed, and accepted-but-unknown results have different recovery rules. Accepted-but-unknown work keeps its receipt and request identity for reconciliation instead of being silently retried.
- Platform synchronization is an external boundary: its receipt is evidence about publication, not a replacement for local task state.

## Platform Boundary

| Execution context | Core capability | Important limitation |
| --- | --- | --- |
| macOS | `host-control` can be managed by a user-scoped launchd service; configured container engines may provide sandboxes | Container capability does not replace the host service or task-bound lifecycle. |
| Linux | `host-control` can be managed by a user-scoped systemd service; configured container engines may provide sandboxes | The engine, broker, host-control, and task lifecycle remain separate boundaries. |
| Native Windows | Some CLI/process and Docker Desktop container paths may exist | No equivalent native host-control service closes the complete host task-bound lifecycle. |
| WSL2 Linux | Linux-side service and container behavior depends on the distribution and runtime configuration | WSL2 Linux behavior is not native Windows host-control support. |
| Docker / WSL2 backend | A configured Docker or WSL2 backend may provide container execution for the sandbox fleet | Backend availability does not add a second broker per sandbox or establish host-control authority. |

## Scope and Source Pointers

This document describes the repository's fixed control-plane components, project-owned runtime details, and their boundaries. Short-lived implementation details are shown only where they explain a control or evidence path; they are not core long-lived processes. It intentionally does not enumerate user-created programs inside a sandbox.

Detailed provider, sandbox, and platform contracts remain in [Feishu Bridge](./feishu-bridge.md), [Sandbox](./sandbox.md), and [Platform Support](./platform-support.md). This overview keeps the entry families, host-control count, sandbox count, broker count, and request-derived control processes understandable in one place.

It does not add a Windows host-control implementation, a new adapter, a compatibility shim, a migration, or a runtime state-machine change.
