import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { renderTaskVerification } from "../../../lib/task/verification.ts";
import { verifyInProcess } from "../../../lib/task/verification-engine.ts";
import { gitSafeEnv } from "../../helpers.ts";
import { canonicalSemanticDigest } from "../../../lib/task/artifact-operations.ts";
import { sha256File } from "../../../lib/task/artifact-receipts.ts";

test("complete-task renders an exemption covering multiple post-review commits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "complete-task-post-review-exemption-"));
  const taskId = "TASK-20260927-000001";
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitSafeEnv() });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (content: string, message: string) => {
    fs.writeFileSync(path.join(root, "file.txt"), content);
    git(["add", "file.txt"]);
    git(["commit", "-qm", message]);
    return git(["rev-parse", "HEAD"]);
  };

  try {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    const reviewedHead = commit("base\n", "base");
    commit("first\n", "first");
    commit("second\n", "second");

    const taskDir = path.join(root, ".agents", "workspace", "active", taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "review-code.md"), "# Review\n");
    const reviewPath = path.join(taskDir, "review-code.md");
    const reviewFact = {
      event: "review-code.completed", output: "review-code.md", outputSha256: sha256File(reviewPath),
      semanticDigest: canonicalSemanticDigest(fs.readFileSync(reviewPath, "utf8")), requestId: "fixture-review-code", result: "{}"
    };
    fs.writeFileSync(path.join(taskDir, "task.md"), [
      "---", `id: ${taskId}`, "status: active", "current_step: code-review", `last_reviewed_commit: ${reviewedHead}`,
      `completion_facts: ${JSON.stringify(JSON.stringify([reviewFact]))}`, "---", "",
      "## Activity Log", "",
      "- 2026-01-01 00:00:00+00:00 — **Review Code (Round 1) [started]** by codex — started",
      "- 2026-01-01 00:00:01+00:00 — **Review Code (Round 1)** by codex — Verdict: Approved → review-code.md", "",
      "## Review Disagreement Ledger", "",
      "| id | stage | round | severity | status | evidence |", "|----|-------|-------|----------|--------|----------|",
      "| PRC-1 | post-review-commit | - | - | human-decided | maintainer allowed two subsequent commits |", ""
    ].join("\n"));
    const configDir = path.join(root, ".agents", "skills", "complete-task", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "verify.json"), JSON.stringify({ skill: "complete-task", checks: { "post-review-commit": {} } }));

    const payload = await verifyInProcess({ mode: "gate", skillName: "complete-task", taskDir, checks: [], repositoryRoot: root });
    assert.equal(payload.gate, "pass");
    assert.match(payload.checks[0]!.message, /2 post-review commit\(s\) covered by a human-decided exemption/);
    const rendered = renderTaskVerification({
      status: "pass", changed: false, event: "complete-task.completed", requestRef: taskId,
      taskId, taskDir, taskState: "active", skill: "complete-task", mode: "gate", artifact: null, error: null,
      invocations: [{ status: "pass", exitCode: 0, payload }]
    });
    assert.match(rendered, /Notice: post-review-commit - 2 post-review commit\(s\) covered by a human-decided exemption/);
    assert.match(rendered, /PRC-1: maintainer allowed two subsequent commits/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
