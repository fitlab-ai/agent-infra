import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitSafeEnv, initIsolatedGitRepo, onPlatforms } from "../../helpers.ts";
import { snapshotReview } from "../../../lib/git/review-snapshot.ts";
import { sha256File } from "../../../lib/task/artifact-receipts.ts";
import { resolvePostReviewGlobs } from "../../../lib/task/review-fingerprint.ts";
import { canonicalSemanticDigest } from "../../../lib/task/artifact-operations.ts";
import {
  buildTaskFrontmatter,
  parseValidatorPayload,
  runValidator,
  withTempRoot,
  write
} from "./validate-artifact-helpers.ts";

const TASK_ID = "TASK-20260328-000001";

function git(repoRoot: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitSafeEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function snapshot(repoRoot: string, baseline: string, diffBase?: string) {
  return snapshotReview({ cwd: repoRoot, mode: "worktree", baseline, diffBase, globs: resolvePostReviewGlobs({}, {}) });
}

function setupRepo(tempRoot: string) {
  initIsolatedGitRepo(tempRoot);
  write(path.join(tempRoot, ".agents/.airc.json"), JSON.stringify({ delivery: { remote: "origin", baseRef: "main" } }) + "\n");
  git(tempRoot, ["config", "user.email", "codex@example.com"]);
  git(tempRoot, ["config", "user.name", "Codex"]);
  write(path.join(tempRoot, ".gitignore"), "task/\n.agents/workspace/\n");
  write(path.join(tempRoot, ".agents/skills/x.md"), "base\n");
  git(tempRoot, ["add", "-A"]);
  git(tempRoot, ["commit", "-qm", "base"]);
  const previous = git(tempRoot, ["rev-parse", "HEAD"]);
  write(path.join(tempRoot, ".agents/skills/x.md"), "base\nreviewed\n");
  git(tempRoot, ["add", "-A"]);
  git(tempRoot, ["commit", "-qm", "reviewed"]);
  return {
    taskDir: path.join(tempRoot, "task", TASK_ID),
    previous,
    baseline: git(tempRoot, ["rev-parse", "HEAD"])
  };
}

function taskContent(lastReviewedCommit?: string, withDeliveryTarget = true, branch?: string) {
  return [
    buildTaskFrontmatter({
      id: TASK_ID,
      current_step: "code-review",
      ...(withDeliveryTarget ? { delivery_remote: "origin", delivery_base_ref: "main" } : {}),
      ...(branch ? { branch } : {}),
      ...(lastReviewedCommit ? { last_reviewed_commit: lastReviewedCommit } : {})
    }),
    "",
    "# 任务：review fact",
    "",
    "## 活动日志",
    "",
    "- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1)** by codex — done"
  ].join("\n");
}

function artifactContent(
  baseline: string,
  reviewedSnapshot: { fingerprint: string; tree: string },
  verdict = "通过",
  diffBase = baseline
) {
  return [
    "# 代码审查报告",
    "",
    "## 审查摘要",
    "",
    `- **审查目标提交**：${diffBase}`,
    `- **审查已检视提交**：${baseline}`,
    `- **审查基线提交**：${baseline}`,
    `- **审查差异基线**：${diffBase}`,
    `- **审查差异指纹**：${reviewedSnapshot.fingerprint}`,
    `- **审查快照树**：${reviewedSnapshot.tree}`,
    `- **总体结论**：${verdict}`
  ].join("\n");
}

function appendLegacyInvalidationHistory(taskDir: string): void {
  const taskPath = path.join(taskDir, "task.md");
  write(taskPath, `${fs.readFileSync(taskPath, "utf8")}\n## 产物失效记录\n\nmalformed legacy history\n`);
}

test("review-fact accepts an approved clean committed range with an independent diff base", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-committed-range-", async (tempRoot) => {
    const { taskDir, previous, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline, previous), "通过", previous));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});

async function runCheck(taskDir: string, attachEvidence = true) {
  if (attachEvidence) addCompletionEvidence(taskDir);
  const result = await runValidator(["check", "review-fact", taskDir, "review-code.md", "--skill", "review-code"]);
  return { result, payload: parseValidatorPayload(result.stdout) };
}

function addCompletionEvidence(taskDir: string): void {
  const taskPath = path.join(taskDir, "task.md");
  let task = fs.readFileSync(taskPath, "utf8");
  const artifactPath = path.join(taskDir, "review-code.md");
  const inputPath = path.join(taskDir, "code.md");
  write(inputPath, "# Code fixture\n");
  const report = fs.readFileSync(artifactPath, "utf8");
  const fact = {
    event: "review-code.completed", output: "review-code.md", outputSha256: sha256File(artifactPath),
    semanticDigest: canonicalSemanticDigest(report), requestId: "review-code-test", result: JSON.stringify({ manualValidation: 0 }),
    lifecycleInputs: [{ name: "code.md", sha256: sha256File(inputPath) }]
  };
  task = task.replace(/^completion_facts:.*\n/mu, "");
  task = task.replace(/\n---\s*\n/u, `\ncompletion_facts: ${JSON.stringify(JSON.stringify([fact]))}\n---\n`);
  const verdict = report.includes("总体结论**：需要修改") ? "Changes Requested" : "Approved";
  task = task.replace(
    "- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1)** by codex — done",
    `- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1)** by codex — Verdict: ${verdict} → review-code.md`
  );
  task = task.replace(
    /^(- 2026-03-28 00:00:00\+00:00 — \*\*Review Code \(Round 1\)\*\* by codex — .*→ review-code\.md)$/mu,
    "- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1) [started]** by codex — started\n$1"
  );
  fs.writeFileSync(taskPath, task);
}

test("review-fact accepts an approved report whose HEAD, baseline, fingerprint, and task fact agree", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-ok-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});

test("review-fact remains valid after a later Watch PR activity and requires report completion evidence", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-later-watch-pr-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    const task = taskContent(baseline).replace(
      "- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1)** by codex — done",
      [
        "- 2026-03-28 00:00:00+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved → review-code.md",
        "- 2026-03-28 00:01:00+00:00 — **Watch PR** by codex — No changes"
      ].join("\n")
    );
    write(path.join(taskDir, "task.md"), task);
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");

    const activity = await runValidator(["check", "activity-log", taskDir, "--skill", "review-code"]);
    const activityPayload = parseValidatorPayload(activity.stdout);
    assert.equal(activity.status, 0, activity.stderr || activity.stdout);
    assert.equal(activityPayload.status, "pass");

    const missingEvidence = await runCheckWithoutAttaching(taskDir);
    assert.equal(missingEvidence.result.status, 1, missingEvidence.result.stdout);
  });
});

async function runCheckWithoutAttaching(taskDir: string) {
  const taskPath = path.join(taskDir, "task.md");
  const original = fs.readFileSync(taskPath, "utf8");
  write(taskPath, original.replace(/^completion_facts:.*\n/mu, ""));
  const result = await runValidator(["check", "review-fact", taskDir, "review-code.md", "--skill", "review-code"]);
  write(taskPath, original);
  return { result, payload: parseValidatorPayload(result.stdout) };
}

test("review-fact rejects an approved report when last_reviewed_commit is stale", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-stale-", async (tempRoot) => {
    const { taskDir, previous, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(previous));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /last_reviewed_commit/);
  });
});

test("review-fact ignores malformed legacy invalidation history", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-legacy-history-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));
    appendLegacyInvalidationHistory(taskDir);

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(payload.status, "pass");
  });
});

test("review-fact rejects an approved report when last_reviewed_commit is missing", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-missing-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent());
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /last_reviewed_commit/);
  });
});

test("review-fact rejects a valid report when the task delivery target is missing", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-unbound-target-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline, false));
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /delivery target/i);
  });
});

test("review-fact rejects a report missing immutable target or reviewed head evidence", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-missing-mdr-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    write(path.join(taskDir, "review-code.md"), [
      "# Code Review",
      "",
      "## Review Summary",
      "",
      `- **Reviewed Diff Base**: ${baseline}`,
      `- **Reviewed Diff Fingerprint**: ${snapshot(tempRoot, baseline).fingerprint}`,
      `- **Reviewed Snapshot Tree**: ${snapshot(tempRoot, baseline).tree}`,
      "- **Overall Verdict**: Approved"
    ].join("\n") + "\n");

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /target head|reviewed head|diff base/i);
  });
});

test("review-fact rejects a report whose baseline does not match HEAD", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-head-", async (tempRoot) => {
    const { taskDir, previous } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(previous));
    write(path.join(taskDir, "review-code.md"), artifactContent(previous, snapshot(tempRoot, previous)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /HEAD|baseline/i);
  });
});

test("review-fact rejects a report whose fingerprint does not match the reviewed worktree", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-fingerprint-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    const reviewed = snapshot(tempRoot, baseline);
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, { ...reviewed, fingerprint: `sha256:${"0".repeat(64)}` }));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /fingerprint/i);
  });
});

test("review-fact rejects a report whose snapshot tree does not match the reviewed worktree", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-tree-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent(baseline));
    const reviewed = snapshot(tempRoot, baseline);
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, { ...reviewed, tree: "0".repeat(40) }));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /snapshot tree/i);
  });
});

test("review-fact does not require a task review commit for a non-approved report", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-changes-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(taskDir, "task.md"), taskContent());
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline), "需要修改"));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});

test("review-fact rejects an uncommitted snapshot until its changes are committed", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-uncommitted-", async (tempRoot) => {
    const { taskDir, baseline } = setupRepo(tempRoot);
    write(path.join(tempRoot, ".agents/skills/x.md"), "base\nreviewed\nuncommitted\n");
    write(path.join(taskDir, "task.md"), taskContent());
    write(path.join(taskDir, "review-code.md"), artifactContent(baseline, snapshot(tempRoot, baseline)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.status, "fail");
    assert.match(payload.message, /uncommitted changes/i);
  });
});

test("review-fact validates the task branch worktree instead of the task workspace directory", onPlatforms("linux", "darwin", "win32"), async () => {
  await withTempRoot("agent-infra-review-fact-task-worktree-", async (tempRoot) => {
    const { baseline } = setupRepo(tempRoot);
    const branch = "feature/review-fact";
    const registeredWorktree = path.join(tempRoot, "task-worktree");
    const sandboxWorktree = path.join(tempRoot, "sandbox-worktree");
    git(tempRoot, ["worktree", "add", "-q", "-b", branch, registeredWorktree, baseline]);
    write(path.join(registeredWorktree, ".agents/skills/x.md"), "base\nreviewed\ntask worktree change\n");
    git(tempRoot, ["-C", registeredWorktree, "add", ".agents/skills/x.md"]);
    git(tempRoot, ["-C", registeredWorktree, "commit", "-qm", "commit task worktree change"]);
    const reviewedHead = git(tempRoot, ["-C", registeredWorktree, "rev-parse", "HEAD"]);
    fs.renameSync(registeredWorktree, sandboxWorktree);
    const taskDir = path.join(sandboxWorktree, ".agents", "workspace", TASK_ID);

    write(path.join(taskDir, "task.md"), taskContent(reviewedHead, true, branch));
    write(path.join(taskDir, "review-code.md"), artifactContent(reviewedHead, snapshot(sandboxWorktree, reviewedHead)));

    const { result, payload } = await runCheck(taskDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "pass");
  });
});
