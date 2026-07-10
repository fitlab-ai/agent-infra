import test from "node:test";
import assert from "node:assert/strict";
import { loadFreshEsm } from "../../helpers.ts";

type Win32Module = typeof import("../../../lib/sandbox/clipboard/win32.ts");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The output path is embedded in the PowerShell script as a single-quoted
// literal (e.g. $outputPath = 'C:\Temp\...\clipboard.png'). Extract it.
function extractOutputPath(script: string): string {
  const match = script.match(/\$outputPath = '([^']+)'/);
  assert.ok(match, `outputPath not found in script: ${script.slice(0, 120)}`);
  return match![1] ?? "";
}

function outputDir(outputPath: string): string {
  return outputPath.replace(/[\\/]clipboard\.png$/u, "");
}

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
  let removedDir = "";
  const adapter = createWin32ClipboardAdapter({
    mkdtempFn(prefix) {
      return `${prefix}test`;
    },
    execFn(cmd, args, options) {
      assert.equal(cmd, "powershell.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
      assert.equal(options?.timeout, 5_000);
      script = String(args[4]);
      outputPath = extractOutputPath(script);
      return "";
    },
    readFileFn(filePath) {
      assert.equal(filePath, outputPath);
      return PNG;
    },
    rmFn(dir) {
      removedDir = String(dir);
    }
  });

  assert.deepEqual(adapter.readImagePng(), PNG);
  assert.match(script, /Get-Clipboard -Format Image/);
  assert.match(script, /Get-Clipboard -Format FileDropList/);
  assert.match(script, /ImageFormat\]::Png/);
  assert.match(script, /\[System\.Drawing\.Image\]::FromFile/);
  assert.match(script, /Dispose\(\)/);
  assert.equal(removedDir, outputDir(outputPath));
});

test("win32 clipboard adapter returns null and cleans up when PowerShell fails", async () => {
  const { createWin32ClipboardAdapter } = await loadFreshEsm<Win32Module>("lib/sandbox/clipboard/win32.js");
  let outputPath = "";
  let removedDir = "";
  const adapter = createWin32ClipboardAdapter({
    mkdtempFn(prefix) {
      return `${prefix}test`;
    },
    execFn(_cmd, args) {
      outputPath = extractOutputPath(String(args[4]));
      throw new Error("no image");
    },
    rmFn(dir) {
      removedDir = String(dir);
    }
  });

  assert.equal(adapter.readImagePng(), null);
  assert.equal(removedDir, outputDir(outputPath));
});

test("win32 clipboard adapter rejects invalid PNG output", async () => {
  const { createWin32ClipboardAdapter } = await loadFreshEsm<Win32Module>("lib/sandbox/clipboard/win32.js");
  let outputPath = "";
  let removedDir = "";
  const adapter = createWin32ClipboardAdapter({
    mkdtempFn(prefix) {
      return `${prefix}test`;
    },
    execFn(_cmd, args) {
      outputPath = extractOutputPath(String(args[4]));
      return "";
    },
    readFileFn(filePath) {
      assert.equal(filePath, outputPath);
      return Buffer.from("not a png");
    },
    rmFn(dir) {
      removedDir = String(dir);
    }
  });

  assert.equal(adapter.readImagePng(), null);
  assert.equal(removedDir, outputDir(outputPath));
});
