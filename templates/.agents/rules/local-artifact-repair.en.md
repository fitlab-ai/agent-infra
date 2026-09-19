# Shared Rule - Current Local Artifact Revalidation

This rule applies to lifecycle artifact validation. Finalizers read the canonical artifact directly and do not create recovery candidates, generations, baselines, journals, or recovery identities.

## Current validation

1. Run the applicable finalizer before a completed event and use its returned `artifactSha256` and `semanticDigest`.
2. On failure, read diagnostics, make one minimal repair to the canonical artifact, and rerun with the same task, family/stage, and artifact.
3. Every rerun validates structure, qualification, upstream relations, ledger state, and current digests. Stop without publishing completed when there is no progress or repair is unsafe.

## Editing boundary

Agents may edit only the artifact declared by the current skill.

## Completed events

Completed events still validate current digests, rounds, inputs, and external facts.

## Shared entry point

```text
agent-infra-internal task-artifact {task-id} finalize-local --family code --artifact {code-artifact}
```

## Stop conditions

Stop when repair is unsafe or makes no progress.
