import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath, gitSafeEnv } from "../../helpers.ts";

const githubScript = filePath("templates/.agents/scripts/security-alerts.github.sh");
const genericScript = filePath("templates/.agents/scripts/security-alerts.sh");

function writeExecutable(filePathname: string, content: string): void {
  fs.writeFileSync(filePathname, content, "utf8");
  fs.chmodSync(filePathname, 0o755);
}

function runScript(script: string, args: string[], options: { failApi?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "security-alerts-script-"));
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "gh.log");

  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "gh"), `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1:$2" in
  auth:token) exit 0 ;;
  repo:view) exit 0 ;;
  api:*)
    ${options.failApi ? "exit 1" : "printf '%s\\n' '{\"number\":7,\"state\":\"open\",\"rule\":{\"id\":\"rule-7\"}}'"}
    exit 0
    ;;
esac
exit 1
`);

  const result = spawnSync("sh", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: gitSafeEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` })
  });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  fs.rmSync(root, { recursive: true, force: true });
  return { result, log };
}

test("security GitHub leaf returns structured data for read and dismiss operations", () => {
  const read = runScript(githubScript, ["read-dependabot", "--number", "7"]);
  assert.equal(read.result.status, 0, read.result.stderr);
  const readPayload = JSON.parse(read.result.stdout) as { status: string; operation: string; data: { number: number } };
  assert.equal(readPayload.status, "applied");
  assert.equal(readPayload.operation, "read-dependabot");
  assert.equal(readPayload.data.number, 7);

  const commentPath = path.join(os.tmpdir(), `security-alert-comment-${process.pid}.txt`);
  fs.writeFileSync(commentPath, "accepted after review\n", "utf8");
  try {
    const dismiss = runScript(githubScript, [
      "dismiss-dependabot", "--number", "7", "--reason", "not_used", "--comment-file", commentPath
    ]);
    assert.equal(dismiss.result.status, 0, dismiss.result.stderr);
    const dismissPayload = JSON.parse(dismiss.result.stdout) as { status: string; operation: string };
    assert.equal(dismissPayload.status, "applied");
    assert.equal(dismissPayload.operation, "dismiss-dependabot");
    assert.match(dismiss.log, /api repos\/.*dependabot\/alerts\/7\napi --method PATCH/);
    assert.match(dismiss.log, /--method PATCH/);
  } finally {
    fs.rmSync(commentPath, { force: true });
  }
});

test("security generic fallback degrades without calling a platform CLI", () => {
  const { result, log } = runScript(genericScript, ["read-codescan", "--number", "7"]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { status: string; operation: string; error: { code: string } };
  assert.equal(payload.status, "degraded");
  assert.equal(payload.operation, "read-codescan");
  assert.equal(payload.error.code, "PLATFORM_SECURITY_UNSUPPORTED");
  assert.equal(log, "");
});
