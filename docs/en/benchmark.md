# Benchmark Contract and Threat Model

[← Back to documentation](./README.md) · [中文](../zh-CN/benchmark.md)

This document defines the public contract for evaluating software-engineering Agents with agent-infra. It specifies what an evaluation records, which data may cross each trust boundary, and which security claims the MVP can verify.

The English document is the normative human-readable specification. The [versioned JSON Schemas](../../lib/benchmark/schemas/v1.0.0/) are the machine-readable structural contract. The Chinese document is a synchronized translation.

## Purpose and scope

The contract supports:

- one Subject executing one Case;
- repeated executions of the same Subject and Case;
- A/B comparison of direct repair and an agent-infra workflow;
- deterministic hidden grading outside the Subject-visible environment;
- sanitized, reproducible public results.

The contract does not implement the Dataset Provider, challenge workspace, Runner, Grader, reporter, network enforcement, or private dataset. It does not define random mutation generation, multilingual cases, LLM judges, dashboards, or leaderboards.

## Normative sources and terminology

The initiative-level roadmap and decisions live in the organization [Benchmark RFC](https://github.com/orgs/fitlab-ai/discussions/1). Repository [Issue #742](https://github.com/fitlab-ai/agent-infra/issues/742) tracks this public contract.

Normative words such as **must**, **must not**, **should**, and **may** describe contract requirements.

| Term | Meaning |
|------|---------|
| Subject | The evaluated model, Agent Client, workflow mode, tools, permissions, network policy, and budget. |
| Case | A versioned evaluation input owned by a Dataset Provider. |
| Agent-visible | The only Case projection that may enter the Subject environment. |
| Grader-only | Trusted-side metadata and opaque references that must never enter the Subject environment or public output. |
| Run | One execution of one Subject against one Case and seed. |
| Grader result | A sanitized public projection of trusted hidden evaluation. |
| Trusted orchestrator | The component allowed to resolve private Provider and Grader references. |
| Reporter | The trusted component that constructs public output from an allowlist. |

## Roles and trust boundaries

```text
Private Dataset Provider
  │ Case manifest + opaque graderRef
  ▼
Trusted Orchestrator ── agentVisible only ──► Disposable Subject Workspace
  │                                           │
  │ final patch or snapshot                   │ no private mounts or credentials
  ▼                                           ▼
Hidden Grader ── raw trusted result ──► Sanitizing Reporter
                                       │ allowlisted projection
                                       ▼
                            Grader result + Run manifest
```

The Subject is untrusted with respect to private benchmark data and result integrity. The Provider, orchestrator, hidden Grader, and reporter are trusted for the data they own.

The public framework may transport opaque trusted-side references, but it must not require private answers, hidden test source, Gold patches, or answer-bearing traces to appear in public manifests or reports.

## Contract versioning

Contract v1.0.0 uses JSON Schema Draft-07:

- [Common definitions](../../lib/benchmark/schemas/v1.0.0/common.schema.json)
- [Subject](../../lib/benchmark/schemas/v1.0.0/subject.schema.json)
- [Case manifest](../../lib/benchmark/schemas/v1.0.0/case-manifest.schema.json)
- [Grader result](../../lib/benchmark/schemas/v1.0.0/grader-result.schema.json)
- [Run manifest](../../lib/benchmark/schemas/v1.0.0/run-manifest.schema.json)

Every top-level object carries `contractVersion: "1.0.0"`. A published version directory is immutable: incompatible changes require a new version directory and contract version. Core objects reject unknown top-level fields; explicitly namespaced additions belong under `extensions`.

The following identities are independent and must not be substituted for one another:

| Identity | Purpose |
|----------|---------|
| `frameworkVersion` | Version of agent-infra executing the Run. |
| `contractVersion` | Version of this public data contract. |
| `datasetVersion` + `datasetDigest` | Identity of the private or public dataset snapshot. |
| `caseVersion` | Version of one Case within the dataset. |
| `sourceRevision` + `sourceDigest` | Input code baseline used to build the challenge. |

`.airc.json.templateVersion` identifies an installed template package and is not a Benchmark identity.

## Subject

The [Subject Schema](../../lib/benchmark/schemas/v1.0.0/subject.schema.json) records the full evaluated condition.

| Field | Required | Semantics |
|-------|----------|-----------|
| `subjectId` | yes | Stable identity for this evaluated condition. |
| `model` | yes | Provider, model ID, and optional immutable version or snapshot. |
| `agentClient` | yes | Agent Client ID and version. |
| `executionMode` | yes | `direct-repair`, `agent-infra-workflow`, or `custom`. |
| `workflowRef` | conditional | Required for workflow and custom modes. |
| `tools` | yes | Tool IDs, versions, and declared capabilities. |
| `permissions` | yes | Filesystem, credential, and command permissions. |
| `networkPolicy` | yes | `none`, `allowlist`, or `unrestricted`, plus optional enforcement evidence. |
| `budget` | no | Time, token, or cost limits when defined by the experiment. |

`unrestricted` exists so the contract can faithfully record a non-conforming Run. A qualifying private-case MVP Run must not grant unrestricted network access.

Two A/B Subjects may intentionally differ in `executionMode` and `workflowRef`. Model, Agent Client, tool versions, permissions, network policy, and budget must otherwise remain equivalent unless the report explicitly declares a different experiment.

## Case manifest

The [Case Manifest Schema](../../lib/benchmark/schemas/v1.0.0/case-manifest.schema.json) is a trusted-side object. It separates:

- `agentVisible`: task text, permitted challenge artifacts, and non-sensitive construction parameters;
- `graderOnly`: an opaque `graderRef` and an input digest.

`agentVisible` is the only projection that may be copied into the disposable Subject workspace. `graderOnly` must not appear in Subject files, mounts, environment variables, prompts, tool state, exceptions, dry-run output, or public logs.

The manifest records independent dataset and Case identities, the source revision and digest, a seed, qualification status, and an optional generated challenge digest. It deliberately has no field for answer text, hidden test source, Gold patches, private repository URLs, or raw qualification traces.

## Grader result

The [Grader Result Schema](../../lib/benchmark/schemas/v1.0.0/grader-result.schema.json) is the sanitized public projection of hidden evaluation, not the raw Grader process result.

`status` has three mutually exclusive terminal values:

| Status | Meaning | Required category |
|--------|---------|-------------------|
| `passed` | Every required hidden test, regression test, and build check passed. | none |
| `failed` | The submitted result was evaluated and did not satisfy a required check. | `failureCategory` |
| `blocked` | Infrastructure could not produce an evaluation verdict. | `blockCategory` |

`blocked` must not be counted as a Subject failure. Reports must publish it separately.

Each `checks` entry contains only an ID, public status, stable category, sanitized summary, and optional duration. Hidden assertions, source, expected patches, private paths, and raw stdout/stderr remain trusted-side data.

The `sanitization` object records the allowlist version and must state `sanitized: true`.

## Run manifest and comparison rules

The [Run Manifest Schema](../../lib/benchmark/schemas/v1.0.0/run-manifest.schema.json) records one execution:

- framework, contract, dataset, Case, and Subject identities;
- seed and repetition position;
- `comparisonGroupId`;
- `conditionsDigest`;
- start and finish time;
- either `resultRef` or an embedded sanitized `graderResult`;
- optional duration, turns, token count, and cost.

`repetitionIndex` starts at 1 and must not exceed `repetitionCount`. The MVP uses `repetitionCount: 3` for each Subject and Case. Cross-field ordering is a Runner responsibility because Draft-07 cannot compare two numeric properties directly.

The reporter preserves every Run before calculating aggregates. Success rate uses evaluated Runs only:

```text
success rate = passed / (passed + failed)
```

`blocked` is reported separately. Missing efficiency metrics remain absent and are never inferred as zero.

For an A/B pair:

- `comparisonGroupId`, dataset identity, Case identity, seed, and repetition position must match;
- `conditionsDigest` must cover the controlled model, Agent Client, tools, permissions, network policy, and budget;
- only the declared Subject dimension may differ;
- a mismatch makes the Runs non-comparable but does not erase either Run.

## Data exposure policy

| Public or Subject-visible | Trusted-side only |
|---------------------------|-------------------|
| Contract and field semantics | Private Case definitions |
| Public example Cases | Hidden tests and assertions |
| Agent-visible task input | Gold patches and mutation metadata |
| Dataset/Case IDs, versions, and digests | Answer-bearing history and traces |
| Sanitized check summaries and categories | Raw Grader stdout/stderr |
| Declared runtime conditions | Private repository locations and credentials |

Structural separation and output allowlists are primary controls. Pattern-based secret redaction is defense in depth and must not be treated as proof that arbitrary private text cannot leak.

## MVP guarantees, prerequisites, and non-guarantees

### Automatically verifiable guarantees

- The Subject workspace inventory contains no Grader-only assets.
- The challenge repository has a fresh root history and no remote.
- Subject mounts and environment variables contain no dataset credential, GitHub token, or Grader path.
- The same Case version and seed produce the same challenge digest.
- The hidden Grader starts after Subject execution and its inputs were never mounted into the Subject.
- Public results are constructed from an explicit allowlist.
- Interrupted and repeated Runs perform cleanup and residual-data checks.

These guarantees become claims only when downstream implementations provide the corresponding evidence.

### Deployment or manual prerequisites

- The operator configures the declared network policy and verifies its enforcement evidence.
- Provider, orchestrator, Grader, and reporter storage remain on the trusted side.
- The model provider and Agent Client retention policies are acceptable for the dataset.
- The selected resource budget and A/B repetition policy are recorded before the experiment.

### Explicit non-guarantees

The MVP does not claim protection against:

- a malicious kernel or container-runtime escape;
- a compromised host or host-privileged operator;
- hardware side channels;
- external model-provider retention outside the Runner's control;
- universal secret detection through regular expressions;
- universal no-network enforcement before the selected platform implements and verifies egress controls.

## Sanitized examples

This Subject differs from its A/B peer only by execution mode and workflow reference:

```json
{
  "contractVersion": "1.0.0",
  "subjectId": "example-workflow",
  "model": { "provider": "example", "modelId": "model-x", "version": "snapshot-1" },
  "agentClient": { "clientId": "codex", "version": "example-version" },
  "executionMode": "agent-infra-workflow",
  "workflowRef": "feature-development",
  "tools": [{ "toolId": "git", "version": "example-version" }],
  "permissions": {
    "filesystem": "challenge-workspace-write",
    "credentials": "none",
    "commands": ["git", "npm"]
  },
  "networkPolicy": { "mode": "none", "enforcementEvidence": "example-evidence-id" },
  "budget": { "timeLimitMs": 1800000, "tokenLimit": 100000 }
}
```

For one Case, six Run manifests represent the MVP A/B sample:

| Subject | Repetitions | Shared comparison identity |
|---------|-------------|----------------------------|
| `example-direct` | 1, 2, 3 of 3 | Same group, Case, seeds, controlled-condition digest |
| `example-workflow` | 1, 2, 3 of 3 | Same group, Case, seeds, controlled-condition digest |

All identifiers and values above are synthetic and contain no private dataset material.

## Downstream responsibilities

| Issue | Responsibility |
|-------|----------------|
| #743 | Load and validate Case manifests without logging Grader-only values. |
| #744 | Generate disposable, answer-free challenge workspaces and reproducible digests. |
| #745 | Execute trusted hidden grading and emit sanitized Grader results. |
| #746 | Record Run manifests, verify comparison compatibility, and publish sanitized aggregates. |
| #747 | Test every isolation guarantee that an implementation claims. |
| #748 | Run the three-Case, three-repetition A/B MVP under equivalent conditions. |

Consumers must fail closed on unsupported contract versions, missing identity fields, invalid status/category combinations, or attempted Grader-only exposure.
