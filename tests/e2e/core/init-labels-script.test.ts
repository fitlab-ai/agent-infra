import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, gitSafeEnv } from "../../helpers.ts";

const scriptPath = filePath("templates/.agents/skills/init-labels/scripts/init-labels.github.sh");

function writeExecutable(filePathname: string, content: string): void {
  fs.writeFileSync(filePathname, content, "utf8");
  fs.chmodSync(filePathname, 0o755);
}

function runLabelScript(
  existingLabels: string[],
  args: string[] = [],
  options: { preflightFailure?: "auth" | "repo" } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "init-labels-script-"));
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "gh.log");

  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agents", ".airc.json"),
    JSON.stringify({ labels: { in: { core: ["lib/"], docs: ["docs/"] } } })
  );
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "gh"), `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1:$2" in
  auth:token)
    [ "${options.preflightFailure ?? ""}" = "auth" ] && exit 1
    exit 0
    ;;
  repo:view)
    [ "${options.preflightFailure ?? ""}" = "repo" ] && exit 1
    exit 0
    ;;
  label:list)
    printf '%s\n' "${existingLabels.join("\n")}"
    exit 0
    ;;
  label:create|label:delete) exit 0 ;;
esac
exit 1
`);

  const result = spawnSync("sh", [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: gitSafeEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` })
  });

  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  fs.rmSync(root, { recursive: true, force: true });
  return { result, log };
}

test("GitHub label initialization creates labels from labels.in and preserves non-in labels", () => {
  const { result, log } = runLabelScript(["in: stale", "type: task"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /label create in: core/);
  assert.match(log, /label create in: docs/);
  assert.doesNotMatch(log, /label delete/);
  assert.match(log, /label create type: bug/);
});

test("GitHub label initialization cleans only stale in labels when explicitly requested", () => {
  const { result, log } = runLabelScript(["in: core", "in: stale", "type: task"], ["--cleanup-stale-in"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /label delete in: stale/);
  assert.doesNotMatch(log, /label delete in: core/);
  assert.doesNotMatch(log, /label delete type: task/);
});

test("GitHub label initialization reports preflight failures with diagnostic output", () => {
  for (const [preflightFailure, message] of [
    ["auth", "GitHub CLI is not authenticated"],
    ["repo", "Unable to access the current repository with gh"]
  ] as const) {
    const { result, log } = runLabelScript([], [], { preflightFailure });

    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(message));
    assert.doesNotMatch(log, /label list|label create/);
  }
});
