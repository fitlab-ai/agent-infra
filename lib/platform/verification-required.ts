import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { inspectRequiredChecks } from "./pr-checks.ts";

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
  if (prFlow === "disabled" || metadata.pr_status === "skipped" || !validPrNumber(metadata.pr_number)) {
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

  const prHead = inspection.pullRequest?.headSha;
  if (!prHead || localHead !== reviewedHead || localHead !== prHead) {
    return shared.failResult(CHECK_TYPE, "Local HEAD, last reviewed commit, and PR head must match", "check_failed");
  }

  const state = inspection.checks?.state;
  if (state === "passed" || state === "no-required") {
    return shared.passResult(CHECK_TYPE, `Required checks are ${state} for PR head ${prHead}`);
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
  if (prFlow === "disabled" || task.metadata.pr_status === "skipped" || !validPrNumber(task.metadata.pr_number)) {
    return evaluateRequiredChecks({ metadata: task.metadata, localHead: null, inspection: null, prFlow }, shared);
  }
  const localHead = readHead(shared.repoRoot);
  if (!localHead) return evaluateRequiredChecks({ metadata: task.metadata, localHead, inspection: null, prFlow }, shared);
  const inspection = inspectRequiredChecks(task.metadata.id, { cwd: shared.repoRoot });
  return evaluateRequiredChecks({ metadata: task.metadata, localHead, inspection, prFlow }, shared);
}
