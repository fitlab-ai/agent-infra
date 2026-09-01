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

function runScript(
  script: string,
  args: string[],
  options: {
    failApi?: boolean;
    preflightFailure?: "auth" | "repo";
    state?: string;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "security-alerts-script-"));
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "gh.log");
  const response = JSON.stringify({
    number: 7,
    state: options.state ?? "open",
    rule: { id: "rule-7" },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      location: { path: "src/app.ts", start_line: 42 },
      message: { text: "unsafe input" }
    }
  });
  const failApi = options.failApi ? "1" : "0";
  const preflightFailure = options.preflightFailure ?? "";

  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "gh"), `#!/bin/sh
printf '%s\n' "$*" >> "${logPath}"
case "$1:$2" in
  auth:token)
    [ "${preflightFailure}" = "auth" ] && exit 1
    exit 0
    ;;
  repo:view)
    [ "${preflightFailure}" = "repo" ] && exit 1
    printf '%s\\n' 'fitlab-ai/agent-infra'
    exit 0
    ;;
  api:--method)
    [ "${failApi}" = "1" ] && exit 1
    input_file=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --input) input_file="\${2:-}"; shift ;;
      esac
      shift
    done
    if [ -n "$input_file" ]; then
      printf 'payload:' >> "${logPath}"
      cat "$input_file" >> "${logPath}"
      printf '\\n' >> "${logPath}"
    fi
    printf '%s\\n' '{"number":7,"state":"dismissed"}'
    exit 0
    ;;
  api:*)
    [ "${failApi}" = "1" ] && exit 1
    printf '%s\\n' '${response}'
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

test("security GitHub leaf covers both alert providers and dismissal payloads", () => {
  const read = runScript(githubScript, ["read-dependabot", "--number", "7"]);
  assert.equal(read.result.status, 0, read.result.stderr);
  const readPayload = JSON.parse(read.result.stdout) as {
    status: string;
    operation: string;
    data: { number: number; state: string; rule: { id: string } };
  };
  assert.equal(readPayload.status, "applied");
  assert.equal(readPayload.operation, "read-dependabot");
  assert.equal(readPayload.data.number, 7);
  assert.equal(readPayload.data.state, "open");
  assert.equal(readPayload.data.rule.id, "rule-7");
  assert.match(read.log, /api repos\/fitlab-ai\/agent-infra\/dependabot\/alerts\/7/);

  const codeScanRead = runScript(githubScript, ["read-codescan", "--number", "7"]);
  assert.equal(codeScanRead.result.status, 0, codeScanRead.result.stderr);
  const codeScanPayload = JSON.parse(codeScanRead.result.stdout) as {
    status: string;
    operation: string;
    data: { tool: { name: string }; most_recent_instance: { location: { path: string; start_line: number } } };
  };
  assert.equal(codeScanPayload.status, "applied");
  assert.equal(codeScanPayload.operation, "read-codescan");
  assert.equal(codeScanPayload.data.tool.name, "CodeQL");
  assert.deepEqual(codeScanPayload.data.most_recent_instance.location, { path: "src/app.ts", start_line: 42 });
  assert.match(codeScanRead.log, /api repos\/fitlab-ai\/agent-infra\/code-scanning\/alerts\/7/);

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
    assert.match(dismiss.log, /api repos\/fitlab-ai\/agent-infra\/dependabot\/alerts\/7\napi --method PATCH/);
    assert.match(dismiss.log, /payload:.*"dismissed_reason":"not_used"/);
    assert.match(dismiss.log, /"dismissed_comment":"accepted after review\\n"/);

    const codeScanDismiss = runScript(githubScript, [
      "dismiss-codescan", "--number", "7", "--reason", "false positive", "--comment-file", commentPath
    ]);
    assert.equal(codeScanDismiss.result.status, 0, codeScanDismiss.result.stderr);
    const codeScanDismissPayload = JSON.parse(codeScanDismiss.result.stdout) as { status: string; operation: string };
    assert.equal(codeScanDismissPayload.status, "applied");
    assert.equal(codeScanDismissPayload.operation, "dismiss-codescan");
    assert.match(codeScanDismiss.log, /api repos\/fitlab-ai\/agent-infra\/code-scanning\/alerts\/7\napi --method PATCH/);
    assert.match(codeScanDismiss.log, /payload:.*"dismissed_reason":"false positive"/);
  } finally {
    fs.rmSync(commentPath, { force: true });
  }
});

test("security GitHub leaf no-ops closed alerts and rejects unknown states without PATCH", () => {
  const commentPath = path.join(os.tmpdir(), `security-alert-comment-state-${process.pid}.txt`);
  fs.writeFileSync(commentPath, "already handled safely\n", "utf8");
  try {
    const noOp = runScript(githubScript, [
      "dismiss-dependabot", "--number", "7", "--reason", "not_used", "--comment-file", commentPath
    ], { state: "dismissed" });
    assert.equal(noOp.result.status, 0, noOp.result.stderr);
    const noOpPayload = JSON.parse(noOp.result.stdout) as { status: string };
    assert.equal(noOpPayload.status, "no-op");
    assert.doesNotMatch(noOp.log, /--method PATCH/);

    const invalid = runScript(githubScript, [
      "dismiss-codescan", "--number", "7", "--reason", "false positive", "--comment-file", commentPath
    ], { state: "pending" });
    assert.equal(invalid.result.status, 1);
    const invalidPayload = JSON.parse(invalid.result.stdout) as { status: string; error: { code: string } };
    assert.equal(invalidPayload.status, "failed");
    assert.equal(invalidPayload.error.code, "SECURITY_RESPONSE_INVALID");
    assert.doesNotMatch(invalid.log, /--method PATCH/);
  } finally {
    fs.rmSync(commentPath, { force: true });
  }
});

test("security GitHub leaf reports preflight and API failures without false success", () => {
  const preflight = runScript(githubScript, ["read-dependabot", "--number", "7"], { preflightFailure: "repo" });
  assert.equal(preflight.result.status, 1);
  const preflightPayload = JSON.parse(preflight.result.stdout) as { status: string; error: { code: string } };
  assert.equal(preflightPayload.status, "failed");
  assert.equal(preflightPayload.error.code, "PLATFORM_REPOSITORY_UNAVAILABLE");
  assert.doesNotMatch(preflight.log, /api /);

  const commentPath = path.join(os.tmpdir(), `security-alert-comment-failure-${process.pid}.txt`);
  fs.writeFileSync(commentPath, "the alert is handled by the current configuration\n", "utf8");
  try {
    const apiFailure = runScript(githubScript, [
      "dismiss-codescan", "--number", "7", "--reason", "false positive", "--comment-file", commentPath
    ], { failApi: true });
    assert.equal(apiFailure.result.status, 2);
    const apiFailurePayload = JSON.parse(apiFailure.result.stdout) as { status: string; error: { code: string } };
    assert.equal(apiFailurePayload.status, "failed");
    assert.equal(apiFailurePayload.error.code, "SECURITY_API_FAILED");
    assert.doesNotMatch(apiFailure.log, /--method PATCH/);
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
