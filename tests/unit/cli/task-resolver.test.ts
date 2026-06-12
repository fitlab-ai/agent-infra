import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveTaskBranch } from "../../../lib/sandbox/task-resolver.ts";

const SCRIPT = path.resolve(
  process.cwd(),
  "templates/.agents/scripts/task-short-id.js"
);

function mkFixtureRepo(shortIdLength: number = 1): { repoRoot: string; activeDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tr-"));
  const agentsDir = path.join(repoRoot, ".agents");
  const scriptsDir = path.join(agentsDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scriptsDir, "task-short-id.js"));
  fs.writeFileSync(
    path.join(agentsDir, ".airc.json"),
    JSON.stringify({ task: { shortIdLength } })
  );
  const activeDir = path.join(agentsDir, "workspace", "active");
  fs.mkdirSync(activeDir, { recursive: true });
  return { repoRoot, activeDir };
}

function writeTask(activeDir: string, taskId: string, branch: string): void {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "task.md"),
    `---\nid: ${taskId}\nbranch: ${branch}\n---\n# body\n`
  );
}

test("resolveTaskBranch passes #N through registry and resolves branch (C3 regression)", () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  const taskId = "TASK-20250201-000001";
  const branch = "feature-test-branch";
  writeTask(activeDir, taskId, branch);

  // Allocate short id via the script. Set cwd to repoRoot so the script reads
  // the fixture's .airc.json (shortIdLength: 1) rather than walking up to the
  // host project, whose .airc.json may not pin task.shortIdLength.
  const alloc = spawnSync("node", [SCRIPT, "alloc", taskId, "--active-dir", activeDir], {
    encoding: "utf8",
    cwd: repoRoot
  });
  assert.equal(alloc.status, 0, `alloc failed: ${alloc.stderr}`);
  assert.equal(alloc.stdout.trim(), "#1");

  // Resolver should now translate #1 → branch.
  const resolved = resolveTaskBranch("#1", repoRoot);
  assert.equal(resolved, branch);
});

test("resolveTaskBranch throws for #N not in registry (C4 strict mode)", () => {
  const { repoRoot } = mkFixtureRepo();
  // No active tasks: nothing for cold-start to allocate; #1 truly absent.
  assert.throws(() => resolveTaskBranch("#1", repoRoot), /not found/);
});

test("resolveTaskBranch on full TASK id is unchanged (no regression)", () => {
  const { repoRoot, activeDir } = mkFixtureRepo();
  const taskId = "TASK-20250201-000003";
  const branch = "another-branch";
  writeTask(activeDir, taskId, branch);

  assert.equal(resolveTaskBranch(taskId, repoRoot), branch);
});

test("resolveTaskBranch on non-task arg is identity", () => {
  const { repoRoot } = mkFixtureRepo();
  assert.equal(resolveTaskBranch("just-a-branch-name", repoRoot), "just-a-branch-name");
});

test("resolveTaskBranch with shortIdLength=2 hits on '#01' and rejects width-mismatched '#1'", () => {
  const { repoRoot, activeDir } = mkFixtureRepo(2);
  const taskId = "TASK-20260301-000001";
  const branch = "feature-zero-padded";
  writeTask(activeDir, taskId, branch);

  const alloc = spawnSync("node", [SCRIPT, "alloc", taskId, "--active-dir", activeDir], {
    encoding: "utf8",
    cwd: repoRoot
  });
  assert.equal(alloc.status, 0, `alloc failed: ${alloc.stderr}`);
  assert.equal(alloc.stdout.trim(), "#01");

  // '#01' hits.
  assert.equal(resolveTaskBranch("#01", repoRoot), branch);
  // '#1' is a width error under shortIdLength=2.
  assert.throws(() => resolveTaskBranch("#1", repoRoot), /expected #NN|not found in active task registry/);
});
