import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { hasPlatformCapability } from "./adapters.ts";
import { inspectRequiredChecks } from "./pr-checks.ts";
import { resolvePlatformContext } from "./context.ts";
import { resolveReviewedHeadRelation } from "./merged-pr-equivalence.ts";
import { readPrDeliveryFact } from "../task/pr-delivery-fact.ts";

const CHECK_TYPE = "required-checks";
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function validPrNumber(value: any): any {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function readPrFlow(repoRoot: any): any {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".agents", ".airc.json"), "utf8"));
    return config.prFlow;
  } catch {
    return undefined;
  }
}

function readHead(repoRoot: any): any {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function evaluateRequiredChecks(context: any, shared: any): any {
  const { metadata, localHead, inspection, prFlow } = context;
  const factRead = readPrDeliveryFact(metadata);
  if (factRead.status === "invalid") {
    return shared.failResult(CHECK_TYPE, factRead.error.message, "check_failed");
  }
  const fact = factRead.status === "valid" ? factRead.fact : null;
  const prNumber = fact?.state === "bound" ? fact.identity.number : null;
  if (prFlow === "disabled" || fact?.state === "skipped" || !validPrNumber(prNumber)) {
    return shared.passResult(CHECK_TYPE, "Skipped: required checks are not applicable to this task");
  }

  const reviewedHead = String(metadata.last_reviewed_commit || "");
  if (!localHead || !SHA_PATTERN.test(localHead)) {
    return shared.blockedResult(CHECK_TYPE, "Unable to resolve the local HEAD", "dependency_error");
  }
  if (!SHA_PATTERN.test(reviewedHead)) {
    return shared.failResult(CHECK_TYPE, "Task has no valid last_reviewed_commit", "check_failed");
  }
  if (!inspection || inspection.status === "blocked") {
    return shared.blockedResult(CHECK_TYPE, inspection?.error?.message || "Required checks are unavailable", "network_error");
  }
  if (inspection.status === "failed") {
    return shared.failResult(CHECK_TYPE, inspection.error?.message || "Required checks are unavailable", "check_failed");
  }

  const prHead = inspection.pullRequest?.head?.sha || inspection.pullRequest?.headSha;
  const relation = context.relation || (
    context.gitRoot && inspection.pullRequest?.head
      ? resolveReviewedHeadRelation({
          gitRoot: context.gitRoot,
          comparisonHead: localHead,
          lastReviewedCommit: reviewedHead,
          pullRequest: inspection.pullRequest
        })
      : localHead === reviewedHead && localHead === prHead
        ? { status: "strict" }
        : { status: "failed" }
  );
  if (relation.status !== "strict" && relation.status !== "merged-equivalent") {
    const message = relation.message || "Local HEAD, last reviewed commit, and PR head must match";
    return relation.status === "blocked"
      ? shared.blockedResult(CHECK_TYPE, message, "dependency_error")
      : shared.failResult(CHECK_TYPE, message, "check_failed");
  }

  const state = inspection.checks?.state;
  if (state === "passed" || state === "no-required") {
    const suffix = relation.status === "merged-equivalent" ? " via verified squash merge equivalence" : "";
    return shared.passResult(CHECK_TYPE, `Required checks are ${state} for PR head ${prHead}${suffix}`);
  }
  if (state === "pending") {
    return shared.blockedResult(CHECK_TYPE, inspection.error?.message || "Required checks are pending", "check_pending");
  }
  return shared.failResult(CHECK_TYPE, inspection.error?.message || `Required checks are ${state || "unavailable"}`, "check_failed");
}

export function check({ taskDir }: any, shared: any): any {
  const task = shared.loadTask(taskDir);
  if (!task.ok) return shared.failResult(CHECK_TYPE, task.message);
  const prFlow = readPrFlow(shared.repoRoot);
  const factRead = readPrDeliveryFact(task.metadata);
  if (factRead.status === "invalid") return shared.failResult(CHECK_TYPE, factRead.error.message, "check_failed");
  const bound = factRead.status === "valid" && factRead.fact.state === "bound";
  if (prFlow === "disabled" || (factRead.status === "valid" && factRead.fact.state === "skipped") || !bound) {
    return evaluateRequiredChecks({ metadata: task.metadata, localHead: null, inspection: null, prFlow }, shared);
  }
  const platform = resolvePlatformContext({ cwd: shared.repoRoot });
  if (!hasPlatformCapability(platform.platform.type, "required-checks")) {
    return shared.blockedResult(
      CHECK_TYPE,
      `Platform '${platform.platform.type || "none"}' does not provide required-checks inspection`,
      "dependency_error"
    );
  }
  const localHead = readHead(shared.repoRoot);
  if (!localHead) return evaluateRequiredChecks({ metadata: task.metadata, localHead, inspection: null, prFlow }, shared);
  const inspection = inspectRequiredChecks(task.metadata.id, { cwd: shared.repoRoot });
  return evaluateRequiredChecks({
    metadata: task.metadata,
    localHead,
    inspection,
    prFlow,
    gitRoot: shared.repoRoot
  }, shared);
}
