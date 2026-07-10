import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadFreshEsm } from "../../helpers.ts";

type LinuxModule = typeof import("../../../lib/sandbox/clipboard/linux.ts");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("linux clipboard adapter probes the selected display backend", async () => {
  const { createLinuxClipboardAdapter } = await loadFreshEsm<LinuxModule>("lib/sandbox/clipboard/linux.js");
  const calls: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
  const execFn = (cmd: string, args: string[], options?: { timeout?: number }) => {
    calls.push({ cmd, args, timeout: options?.timeout });
    return "ok";
  };

  const wayland = createLinuxClipboardAdapter({
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    execFn
  });
  assert.deepEqual(wayland.available(), { ok: true });
  assert.deepEqual(calls.shift(), { cmd: "wl-paste", args: ["--version"], timeout: 2_000 });

  const x11 = createLinuxClipboardAdapter({ env: { WAYLAND_DISPLAY: " ", DISPLAY: ":0" }, execFn });
  assert.deepEqual(x11.available(), { ok: true });
  assert.deepEqual(calls.shift(), { cmd: "xclip", args: ["-version"], timeout: 2_000 });
  assert.equal(calls.length, 0);
});

test("linux clipboard adapter returns backend-specific installation guidance", async () => {
  const { createLinuxClipboardAdapter } = await loadFreshEsm<LinuxModule>("lib/sandbox/clipboard/linux.js");
  const execFn = () => {
    throw new Error("missing");
  };

  assert.deepEqual(
    createLinuxClipboardAdapter({ env: { WAYLAND_DISPLAY: "wayland-0" }, execFn }).available(),
    { ok: false, reason: "Wayland clipboard tool wl-paste is unavailable; install wl-clipboard to enable image paste" }
  );
  assert.deepEqual(
    createLinuxClipboardAdapter({ env: {}, execFn }).available(),
    { ok: false, reason: "X11 clipboard tool xclip is unavailable; install xclip to enable image paste" }
  );
});

test("linux clipboard adapter reads Wayland PNG output through a temporary file", async () => {
  const { createLinuxClipboardAdapter } = await loadFreshEsm<LinuxModule>("lib/sandbox/clipboard/linux.js");
  const execCalls: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
  let outputPath = "";
  const adapter = createLinuxClipboardAdapter({
    env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    execFn(cmd, args, options) {
      execCalls.push({ cmd, args, timeout: options?.timeout });
      return "text/plain\nimage/png\n";
    },
    execToFileFn(cmd, args, target, timeout) {
      execCalls.push({ cmd, args, timeout });
      outputPath = target;
      fs.writeFileSync(target, PNG);
    }
  });

  assert.deepEqual(adapter.readImagePng(), PNG);
  assert.deepEqual(execCalls, [
    { cmd: "wl-paste", args: ["--list-types"], timeout: 2_000 },
    { cmd: "wl-paste", args: ["-t", "image/png"], timeout: 5_000 }
  ]);
  assert.equal(fs.existsSync(path.dirname(outputPath)), false);
});

test("linux clipboard adapter reads X11 PNG output when Wayland is absent", async () => {
  const { createLinuxClipboardAdapter } = await loadFreshEsm<LinuxModule>("lib/sandbox/clipboard/linux.js");
  const execCalls: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
  const adapter = createLinuxClipboardAdapter({
    env: { DISPLAY: ":0" },
    execFn(cmd, args, options) {
      execCalls.push({ cmd, args, timeout: options?.timeout });
      return "TARGETS\nimage/png\n";
    },
    execToFileFn(cmd, args, target, timeout) {
      execCalls.push({ cmd, args, timeout });
      fs.writeFileSync(target, PNG);
    }
  });

  assert.deepEqual(adapter.readImagePng(), PNG);
  assert.deepEqual(execCalls, [
    { cmd: "xclip", args: ["-selection", "clipboard", "-t", "TARGETS", "-o"], timeout: 2_000 },
    { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], timeout: 5_000 }
  ]);
});

test("linux clipboard adapter skips capture when MIME types do not contain image/png", async () => {
  const { createLinuxClipboardAdapter } = await loadFreshEsm<LinuxModule>("lib/sandbox/clipboard/linux.js");
  let captures = 0;
  const adapter = createLinuxClipboardAdapter({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    execFn: () => "image/png-extra\ntext/plain\n",
    execToFileFn() {
      captures += 1;
    }
  });

  assert.equal(adapter.readImagePng(), null);
  assert.equal(captures, 0);
});

test("linux clipboard adapter rejects invalid PNG and cleans up capture failures", async () => {
  const { createLinuxClipboardAdapter } = await loadFreshEsm<LinuxModule>("lib/sandbox/clipboard/linux.js");
  let invalidPath = "";
  const invalid = createLinuxClipboardAdapter({
    env: {},
    execFn: () => "image/png\n",
    execToFileFn(_cmd, _args, target) {
      invalidPath = target;
      fs.writeFileSync(target, "not a png");
    }
  });
  assert.equal(invalid.readImagePng(), null);
  assert.equal(fs.existsSync(path.dirname(invalidPath)), false);

  let failedPath = "";
  const failed = createLinuxClipboardAdapter({
    env: {},
    execFn: () => "image/png\n",
    execToFileFn(_cmd, _args, target) {
      failedPath = target;
      throw new Error("capture failed");
    }
  });
  assert.equal(failed.readImagePng(), null);
  assert.equal(fs.existsSync(path.dirname(failedPath)), false);
});
