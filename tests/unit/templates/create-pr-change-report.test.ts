import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { filePath, gitSafeEnv, initIsolatedGitRepo } from "../../helpers.ts";

const runtimeScript = filePath(".agents/skills/create-pr/scripts/change-report.mjs");
const templateScript = filePath("templates/.agents/skills/create-pr/scripts/change-report.mjs");

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: gitSafeEnv()
  }).trim();
}

test("create-pr change report reconciles line counts and blob byte sizes", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "create-pr-change-report-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  initIsolatedGitRepo(repo);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);

  const compactBefore = `${"long-content-".repeat(20)}\n`;
  const compactAfter = "short\n";
  const renamedContent = "unchanged\n";
  const removedContent = "removed\n";
  const binaryContent = Buffer.from([0, 1, 2, 3, 4]);

  fs.writeFileSync(path.join(repo, "compact.txt"), compactBefore);
  fs.writeFileSync(path.join(repo, "rename-before.txt"), renamedContent);
  fs.writeFileSync(path.join(repo, "removed.txt"), removedContent);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repo, "compact.txt"), compactAfter);
  fs.renameSync(path.join(repo, "rename-before.txt"), path.join(repo, "rename-after.txt"));
  fs.rmSync(path.join(repo, "removed.txt"));
  fs.writeFileSync(path.join(repo, "binary.dat"), binaryContent);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "head"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const report = JSON.parse(execFileSync(process.execPath, [
    runtimeScript,
    "--base", base,
    "--head", head,
    "--cwd", repo
  ], {
    encoding: "utf8",
    env: gitSafeEnv()
  }));

  const compact = report.files.find((file: { newPath: string | null }) => file.newPath === "compact.txt");
  const renamed = report.files.find((file: { newPath: string | null }) => file.newPath === "rename-after.txt");
  const binary = report.files.find((file: { newPath: string | null }) => file.newPath === "binary.dat");

  assert.deepEqual(compact, {
    status: "M",
    oldPath: "compact.txt",
    newPath: "compact.txt",
    additions: 1,
    deletions: 1,
    oldBytes: Buffer.byteLength(compactBefore),
    newBytes: Buffer.byteLength(compactAfter),
    netBytes: Buffer.byteLength(compactAfter) - Buffer.byteLength(compactBefore)
  });
  assert.equal(renamed.status, "R100");
  assert.equal(renamed.oldBytes, Buffer.byteLength(renamedContent));
  assert.equal(renamed.newBytes, Buffer.byteLength(renamedContent));
  assert.equal(renamed.netBytes, 0);
  assert.equal(binary.additions, null);
  assert.equal(binary.deletions, null);
  assert.equal(binary.oldBytes, 0);
  assert.equal(binary.newBytes, binaryContent.byteLength);

  const expectedOldBytes = Buffer.byteLength(compactBefore) + Buffer.byteLength(renamedContent) + Buffer.byteLength(removedContent);
  const expectedNewBytes = Buffer.byteLength(compactAfter) + Buffer.byteLength(renamedContent) + binaryContent.byteLength;
  assert.deepEqual(report.totals, {
    files: 4,
    textFiles: 3,
    binaryFiles: 1,
    additions: 1,
    deletions: 2,
    oldBytes: expectedOldBytes,
    newBytes: expectedNewBytes,
    netBytes: expectedNewBytes - expectedOldBytes
  });
});

test("create-pr installs the same change report calculator as the local skill", () => {
  assert.deepEqual(fs.readFileSync(templateScript), fs.readFileSync(runtimeScript));
});
