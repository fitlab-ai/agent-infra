import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { envWithPrependedPath, onPlatforms } from "../../helpers.ts";

// auto-resume.sh is a POSIX sh StopFailure hook; the behavioural gates only run
// on platforms with /bin/sh. Windows is skipped at the whole-test level.
const POSIX = onPlatforms("linux", "darwin");
const SCRIPT = path.resolve(".agents/hooks/auto-resume.sh");

function writeStub(filePathname: string, body: string): void {
  fs.writeFileSync(filePathname, body);
  fs.chmodSync(filePathname, 0o755);
}

interface Harness {
  home: string;
  bin: string;
  tmuxCalls: string;
  cleanup: () => void;
}

// Build an isolated HOME plus a bin dir holding tmux/curl stubs. tmux records
// every invocation so tests can assert injection happened (or did not). curl's
// exit code simulates network reachability for the probe gate. When
// failTmuxSubcommand is set, the tmux stub exits non-zero for that subcommand
// (e.g. "paste-buffer") so the WARN-on-failure path can be exercised; the
// default empty value never matches a real subcommand, preserving prior behaviour.
function setup(curlExit: number, failTmuxSubcommand = ""): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-resume-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const tmuxCalls = path.join(root, "tmux-calls.txt");
  writeStub(
    path.join(bin, "tmux"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${tmuxCalls}"\n[ "$1" = "${failTmuxSubcommand}" ] && exit 1\nexit 0\n`
  );
  writeStub(path.join(bin, "curl"), `#!/bin/sh\nexit ${curlExit}\n`);
  return { home, bin, tmuxCalls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// process.env may already carry TMUX_PANE (the dev session can run inside tmux);
// strip it so each test controls the tmux gate explicitly.
function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX_PANE;
  delete env.TMUX;
  return env;
}

function run(h: Harness, env: NodeJS.ProcessEnv, payload: object) {
  return spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: envWithPrependedPath(env, h.bin)
  });
}

function readLog(home: string): string {
  const logPath = path.join(home, ".claude", "auto-resume.log");
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

function tmuxWasCalled(h: Harness): boolean {
  return fs.existsSync(h.tmuxCalls) && fs.readFileSync(h.tmuxCalls, "utf8").trim() !== "";
}

test("gate 1: outside tmux it logs a skip and never injects", POSIX, () => {
  const h = setup(0);
  try {
    const result = run(h, baseEnv(h.home), { session_id: "s1", error: "unknown" });
    assert.equal(result.status, 0, "hook always exits 0 (StopFailure ignores exit code)");
    assert.match(readLog(h.home), /not in tmux, skip/, "should record the non-tmux skip reason");
    assert.equal(tmuxWasCalled(h), false, "must not touch tmux outside a pane");
  } finally {
    h.cleanup();
  }
});

test("gate 2: a non-recoverable error is blocked with a logged reason and no injection", POSIX, () => {
  const h = setup(0);
  try {
    const env = { ...baseEnv(h.home), TMUX_PANE: "%9" };
    const result = run(h, env, { session_id: "s1", error: "authentication_failed" });
    assert.equal(result.status, 0);
    assert.match(readLog(h.home), /blocked: non-recoverable error=authentication_failed/, "should log the interception reason");
    assert.equal(tmuxWasCalled(h), false, "must not inject for non-whitelisted errors");
  } finally {
    h.cleanup();
  }
});

test("gate 3: backs off after 10 fires within the window and does not inject", POSIX, () => {
  const h = setup(0);
  try {
    const stateDir = path.join(h.home, ".claude", "auto-resume.state");
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    // Seed 10 recent (in-window) fires so this 11th attempt must back off.
    fs.writeFileSync(path.join(stateDir, "s1.count"), Array.from({ length: 10 }, () => String(now)).join("\n") + "\n");
    const env = { ...baseEnv(h.home), TMUX_PANE: "%9" };
    const result = run(h, env, { session_id: "s1", error: "unknown" });
    assert.equal(result.status, 0);
    assert.match(readLog(h.home), /backoff: 10 fires in 30m, skip/, "should log the backoff");
    assert.equal(tmuxWasCalled(h), false, "must not inject once backed off");
  } finally {
    h.cleanup();
  }
});

test("a traversal session_id cannot write the state file outside the state dir", POSIX, () => {
  const h = setup(0);
  try {
    const env = { ...baseEnv(h.home), TMUX_PANE: "%9" };
    const result = run(h, env, { session_id: "../outside", error: "unknown" });
    assert.equal(result.status, 0);
    // The pre-sanitization bug wrote ~/.claude/outside.count, escaping the state dir.
    assert.equal(
      fs.existsSync(path.join(h.home, ".claude", "outside.count")),
      false,
      "must not create a count file outside the state directory"
    );
    const stateDir = path.join(h.home, ".claude", "auto-resume.state");
    const stateFiles = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    assert.ok(
      stateFiles.some((name) => name.endsWith(".count")),
      "the sanitized count file should live inside the state directory"
    );
  } finally {
    h.cleanup();
  }
});

test("happy path: whitelisted error with reachable network injects the resume text", POSIX, () => {
  const h = setup(0); // curl exit 0 => reachable, probe passes immediately
  try {
    const env = { ...baseEnv(h.home), TMUX_PANE: "%9" };
    const result = run(h, env, { session_id: "s1", error: "unknown" });
    assert.equal(result.status, 0);
    const log = readLog(h.home);
    assert.match(log, /tmux inject start \(error=unknown\)/, "should log the start of injection");
    assert.match(log, /tmux inject done \(error=unknown\)/, "should log a completed injection");
    assert.equal(tmuxWasCalled(h), true, "should drive tmux");
    const calls = fs.readFileSync(h.tmuxCalls, "utf8");
    assert.match(calls, /send-keys -t %9 Escape/, "should send Escape to the target pane first");
    assert.match(
      calls,
      /set-buffer -b auto-resume -- .*Unexpected interruption\. Please continue the unfinished operation\./,
      "should stage the resume text in the named paste buffer"
    );
    assert.match(calls, /paste-buffer -t %9 -b auto-resume -p -d/, "should paste via bracketed paste from the named buffer");
    assert.match(calls, /send-keys -t %9 Enter/, "should submit with a separate Enter after the paste");
  } finally {
    h.cleanup();
  }
});

test("a failing tmux step is logged as WARN and never blocks", POSIX, () => {
  const h = setup(0, "paste-buffer"); // reachable network, but the paste step fails
  try {
    const env = { ...baseEnv(h.home), TMUX_PANE: "%9" };
    const result = run(h, env, { session_id: "s1", error: "unknown" });
    assert.equal(result.status, 0, "a failing tmux step must not break the non-blocking exit 0");
    assert.match(
      readLog(h.home),
      /WARN: tmux paste-buffer failed \(error=unknown\)/,
      "should log the failing tmux step as a WARN line"
    );
  } finally {
    h.cleanup();
  }
});
