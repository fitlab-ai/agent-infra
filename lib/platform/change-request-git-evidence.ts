import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { resolvePlatformProviderContext } from './context.ts';
import {
  providerError,
  providerOperationContext,
  unsupportedProviderOperation
} from './provider-bridge.ts';
import { isResourceIdentity } from './resource-identity.ts';
import { resolveReviewedHeadRelation } from "./merged-pr-equivalence.ts";
import type { ReviewedHeadRelation } from "./merged-pr-equivalence.ts";
import type { PullRequestSnapshot } from "./pull-requests.ts";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REVIEWED_HEAD_REF = "refs/agent-infra/reviewed-head";
const TARGET_HEAD_REF = "refs/agent-infra/target-head";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function validRef(ref: string): boolean {
  return spawnSync("git", ["check-ref-format", ref], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"]
  }).status === 0;
}

function blocked(code: string, message: string): ReviewedHeadRelation {
  return { status: "blocked", code, message };
}

function failed(code: string, message: string): ReviewedHeadRelation {
  return { status: "failed", code, message };
}

function validMergeIdentity(lastReviewedCommit: string, pullRequest: PullRequestSnapshot):
  ReviewedHeadRelation | null {
  if (
    pullRequest.state !== "closed" ||
    !pullRequest.mergedAt ||
    !pullRequest.mergeCommitSha ||
    !SHA_PATTERN.test(lastReviewedCommit) ||
    lastReviewedCommit !== pullRequest.head.sha
  ) {
    return failed(
      "PR_MERGE_IDENTITY_INVALID",
      "PR merge identity does not match the reviewed head"
    );
  }
  return null;
}

async function resolveMaterializedReviewedHeadRelation(input: {
  cwd: string;
  platformType: string | null;
  lastReviewedCommit: string;
  pullRequest: PullRequestSnapshot;
}): Promise<ReviewedHeadRelation> {
  const identityFailure = validMergeIdentity(input.lastReviewedCommit, input.pullRequest);
  if (identityFailure) return identityFailure;

  const loaded = await resolvePlatformProviderContext({
    cwd: input.cwd,
    platformType: input.platformType || undefined
  });
  if (!loaded.ok) {
    return blocked(
      loaded.context.error?.code || 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE',
      loaded.context.error?.message || 'Unable to resolve the configured platform provider'
    );
  }
  const target = isResourceIdentity(input.pullRequest.identity)
    ? input.pullRequest.identity
    : { kind: 'number' as const, value: input.pullRequest.number };
  const operation = loaded.value.provider.changeRequests?.resolveGitEvidence
    ? await loaded.value.provider.changeRequests.resolveGitEvidence({
      context: providerOperationContext(loaded.value),
      target,
      expected: {
        baseSha: input.pullRequest.base.sha,
        headSha: input.pullRequest.head.sha,
        targetBranch: input.pullRequest.base.ref
      }
    })
    : unsupportedProviderOperation(loaded.value.provider, 'changeRequests.resolveGitEvidence');
  const source = operation.ok
    ? operation
    : { ok: false as const, error: providerError(operation.error, 'PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE') };
  if (!source.ok || !source.value) {
    return blocked(
      ('error' in source && source.error?.code) || "PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE",
      ('error' in source && source.error?.message) || "Unable to resolve authoritative PR Git evidence"
    );
  }
  if (
    !source.value.remoteUrl.trim() ||
    source.value.remoteUrl.trimStart().startsWith("-") ||
    !validRef(source.value.reviewedHeadRef) ||
    !validRef(source.value.targetHeadRef)
  ) {
    return blocked(
      "PR_MERGE_EVIDENCE_SOURCE_UNAVAILABLE",
      "Platform returned an invalid PR Git evidence source"
    );
  }

  let evidenceRoot: string | null = null;
  let phase: "prepare" | "fetch" | "resolve" = "prepare";
  let result: ReviewedHeadRelation = blocked(
    "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE",
    "Unable to prepare isolated PR Git evidence"
  );
  try {
    evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-pr-evidence-"));
    execFileSync("git", ["init", "--bare", "-q", evidenceRoot], {
      cwd: input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    phase = "fetch";
    git(evidenceRoot, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      source.value.remoteUrl,
      `+${source.value.reviewedHeadRef}:${REVIEWED_HEAD_REF}`,
      `+${source.value.targetHeadRef}:${TARGET_HEAD_REF}`
    ]);

    phase = "resolve";
    const fetchedReviewedHead = git(evidenceRoot, ["rev-parse", `${REVIEWED_HEAD_REF}^{commit}`]);
    const comparisonHead = git(evidenceRoot, ["rev-parse", `${TARGET_HEAD_REF}^{commit}`]);
    if (fetchedReviewedHead !== input.pullRequest.head.sha) {
      result = failed(
        "PR_MERGE_FETCHED_HEAD_MISMATCH",
        "Fetched PR head does not match the authoritative platform snapshot"
      );
    } else {
      result = resolveReviewedHeadRelation({
        gitRoot: evidenceRoot,
        comparisonHead,
        lastReviewedCommit: input.lastReviewedCommit,
        pullRequest: input.pullRequest
      });
    }
  } catch {
    result = phase === "fetch"
      ? blocked(
          "PR_MERGE_EVIDENCE_FETCH_FAILED",
          "Unable to fetch PR Git evidence; verify Git credentials and platform refs"
        )
      : phase === "resolve"
        ? blocked(
            "PR_MERGE_OBJECT_MISSING",
            "Fetched PR Git evidence is incomplete"
          )
        : blocked(
            "PR_MERGE_GIT_EVIDENCE_UNAVAILABLE",
            "Unable to prepare isolated PR Git evidence"
          );
  } finally {
    if (evidenceRoot) {
      try {
        fs.rmSync(evidenceRoot, { recursive: true, force: true });
      } catch {
        result = blocked(
          "PR_MERGE_EVIDENCE_CLEANUP_FAILED",
          "Unable to clean up isolated PR Git evidence"
        );
      }
    }
  }
  return result;
}

export { resolveMaterializedReviewedHeadRelation };
