import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadFreshEsm } from "../../helpers.ts";

type Win32Module = typeof import("../../../lib/sandbox/clipboard/win32.ts");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("win32 clipboard adapter probes powershell.exe and Get-Clipboard", async () => {
  const { createWin32ClipboardAdapter } = await loadFreshEsm<Win32Module>("lib/sandbox/clipboard/win32.js");
  const calls: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
  const available = createWin32ClipboardAdapter({
    execFn(cmd, args, options) {
      calls.push({ cmd, args, timeout: options?.timeout });
      return "";
    }
  });

  assert.deepEqual(available.available(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cmd, "powershell.exe");
  assert.deepEqual(calls[0]?.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
  assert.match(calls[0]?.args[4] ?? "", /Get-Command Get-Clipboard/);
  assert.equal(calls[0]?.timeout, 2_000);

  const missing = createWin32ClipboardAdapter({
    execFn() {
      throw new Error("missing");
    }
  });
  assert.deepEqual(missing.available(), {
    ok: false,
    reason: "Windows PowerShell Get-Clipboard is unavailable; install or enable powershell.exe to use image paste"
  });
});

test("win32 clipboard adapter saves PNG to a parameterized temporary path", async () => {
  const { createWin32ClipboardAdapter } = await loadFreshEsm<Win32Module>("lib/sandbox/clipboard/win32.js");
  let outputPath = "";
  let script = "";
  const adapter = createWin32ClipboardAdapter({
    execFn(cmd, args, options) {
      assert.equal(cmd, "powershell.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
      assert.equal(options?.timeout, 5_000);
      script = String(args[4]);
      outputPath = String(args[5]);
      fs.writeFileSync(outputPath, PNG);
      return "";
    }
  });

  assert.deepEqual(adapter.readImagePng(), PNG);
  assert.match(script, /Get-Clipboard -Format Image/);
  assert.match(script, /ImageFormat\]::Png/);
  assert.match(script, /Dispose\(\)/);
  assert.equal(script.includes(outputPath), false);
  assert.equal(fs.existsSync(path.dirname(outputPath)), false);
});

test("win32 clipboard adapter returns null and cleans up when PowerShell fails", async () => {
  const { createWin32ClipboardAdapter } = await loadFreshEsm<Win32Module>("lib/sandbox/clipboard/win32.js");
  let outputPath = "";
  const adapter = createWin32ClipboardAdapter({
    execFn(_cmd, args) {
      outputPath = String(args[5]);
      throw new Error("no image");
    }
  });

  assert.equal(adapter.readImagePng(), null);
  assert.equal(fs.existsSync(path.dirname(outputPath)), false);
});

test("win32 clipboard adapter rejects invalid PNG output", async () => {
  const { createWin32ClipboardAdapter } = await loadFreshEsm<Win32Module>("lib/sandbox/clipboard/win32.js");
  let outputPath = "";
  const adapter = createWin32ClipboardAdapter({
    execFn(_cmd, args) {
      outputPath = String(args[5]);
      fs.writeFileSync(outputPath, "not a png");
      return "";
    }
  });

  assert.equal(adapter.readImagePng(), null);
  assert.equal(fs.existsSync(path.dirname(outputPath)), false);
});
