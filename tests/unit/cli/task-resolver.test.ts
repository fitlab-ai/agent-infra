import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveTaskBranch } from "../../../lib/sandbox/task-resolver.ts";
import {
  INTERNAL_CLI_PATH,
  envWithPrependedPath,
  writeNodeCommandShim
} from "../../helpers.ts";

const SCRIPT = path.resolve(
  process.cwd(),
  "templates/.agents/scripts/task-short-id.js"
);

function withInternalCliPath<T>(operation: () => T): T {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-resolver-bin-"));
  writeNodeCommandShim(path.join(binDir, "agent-infra-internal"), INTERNAL_CLI_PATH);
  const original = process.env.PATH;
  Object.assign(process.env, envWithPrependedPath(process.env, binDir));
  try {
    return operation();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

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

test("resolveTaskBranch resolves bare N through the registry", () => {
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
  assert.equal(alloc.stdout.trim(), "1");

  const resolved = withInternalCliPath(() => resolveTaskBranch("1", repoRoot));
  assert.equal(resolved, branch);
});

test("resolveTaskBranch rejects removed #N syntax instead of treating it as a branch", () => {
  const { repoRoot } = mkFixtureRepo();
  assert.throws(() => resolveTaskBranch("#1", repoRoot), /bare digits/);
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

test("resolveTaskBranch with shortIdLength=2 accepts bare aliases and rejects hash aliases", () => {
  const { repoRoot, activeDir } = mkFixtureRepo(2);
  const taskId = "TASK-20260301-000001";
  const branch = "feature-zero-padded";
  writeTask(activeDir, taskId, branch);

  const alloc = spawnSync("node", [SCRIPT, "alloc", taskId, "--active-dir", activeDir], {
    encoding: "utf8",
    cwd: repoRoot
  });
  assert.equal(alloc.status, 0, `alloc failed: ${alloc.stderr}`);
  assert.equal(alloc.stdout.trim(), "01");

  withInternalCliPath(() => {
    assert.equal(resolveTaskBranch("01", repoRoot), branch);
    assert.equal(resolveTaskBranch("1", repoRoot), branch);
  });
  assert.throws(() => resolveTaskBranch("#01", repoRoot), /bare digits/);
  assert.throws(() => resolveTaskBranch("#1", repoRoot), /bare digits/);
});
