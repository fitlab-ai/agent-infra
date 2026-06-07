import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { loadFreshEsm } from "../../helpers.ts";

type KeysModule = typeof import("../../../lib/sandbox/clipboard/keys.ts");
type PathsModule = typeof import("../../../lib/sandbox/clipboard/paths.ts");
type DarwinModule = typeof import("../../../lib/sandbox/clipboard/darwin.ts");
type IndexModule = typeof import("../../../lib/sandbox/clipboard/index.ts");
type BridgeModule = typeof import("../../../lib/sandbox/clipboard/bridge.ts");
type PtyExitEvent = { exitCode: number; signal?: number | string };
type PtyExitHandler = (event: PtyExitEvent) => void;

function invokeExitHandler(handler: PtyExitHandler | null, event: PtyExitEvent) {
  assert.ok(handler, "pty exit handler should be registered");
  handler(event);
}

test("CtrlVDetector recognizes plain, CSI-u, and modifyOtherKeys Ctrl+V sequences", async () => {
  const { CtrlVDetector } = await loadFreshEsm<KeysModule>("lib/sandbox/clipboard/keys.js");
  const detector = new CtrlVDetector();

  const tokens = [
    ...detector.feed("a\x16"),
    ...detector.feed("\x1b[118;5u"),
    ...detector.feed("\x1b[27;5;118~z")
  ];

  assert.deepEqual(tokens, [
    { kind: "text", raw: "a" },
    { kind: "ctrl-v", raw: "\x16", label: "ctrl-v 0x16" },
    { kind: "ctrl-v", raw: "\x1b[118;5u", label: "ctrl-v csi-u ESC[118;5u" },
    { kind: "ctrl-v", raw: "\x1b[27;5;118~", label: "ctrl-v modifyOtherKeys ESC[27;5;118~" },
    { kind: "text", raw: "z" }
  ]);
});

test("CtrlVDetector buffers partial escape sequences across chunks", async () => {
  const { CtrlVDetector } = await loadFreshEsm<KeysModule>("lib/sandbox/clipboard/keys.js");
  const detector = new CtrlVDetector();

  assert.deepEqual(detector.feed("\x1b[27;"), []);
  assert.deepEqual(detector.feed("5;118~"), [
    { kind: "ctrl-v", raw: "\x1b[27;5;118~", label: "ctrl-v modifyOtherKeys ESC[27;5;118~" }
  ]);
});

test("CtrlVDetector flushes incomplete escape sequences as text", async () => {
  const { CtrlVDetector } = await loadFreshEsm<KeysModule>("lib/sandbox/clipboard/keys.js");
  const detector = new CtrlVDetector();

  assert.deepEqual(detector.feed("\x1b[118"), []);
  assert.deepEqual(detector.flush(), [{ kind: "text", raw: "\x1b[118" }]);
});

test("buildBracketedPaste wraps text in paste markers", async () => {
  const { buildBracketedPaste } = await loadFreshEsm<KeysModule>("lib/sandbox/clipboard/keys.js");

  assert.equal(buildBracketedPaste("/clipboard/a.png"), "\x1b[200~/clipboard/a.png\x1b[201~");
});

test("clipboard path helpers write atomically and prune old png files", async () => {
  const paths = await loadFreshEsm<PathsModule>("lib/sandbox/clipboard/paths.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-clipboard-"));

  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const filename = paths.pngClipboardFilename(png);
    const target = paths.writeClipboardPngAtomic(tmpDir, filename, png);

    assert.equal(paths.containerClipboardPath(filename), `/clipboard/${filename}`);
    assert.deepEqual(fs.readFileSync(target), png);

    const now = Date.now();
    for (let i = 0; i < 22; i += 1) {
      const file = path.join(tmpDir, `${i}.png`);
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, new Date(now - i * 1000), new Date(now - i * 1000));
    }

    const removed = paths.pruneClipboardDir(tmpDir, { keep: 20, maxAgeMs: 24 * 60 * 60 * 1000, now });

    assert.equal(removed.length, 3);
    assert.equal(fs.readdirSync(tmpDir).filter((name) => name.endsWith(".png")).length, 20);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("darwin clipboard adapter reads PNG through a temporary file", async () => {
  const { createDarwinClipboardAdapter } = await loadFreshEsm<DarwinModule>("lib/sandbox/clipboard/darwin.js");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const execCalls: Array<{ cmd: string; args: string[]; timeout?: number }> = [];

  const adapter = createDarwinClipboardAdapter({
    execFn(cmd, args, options) {
      execCalls.push({ cmd, args, timeout: options?.timeout });
      const script = String(args[1]);
      const match = script.match(/POSIX file "([^"]+)"/);
      if (match?.[1]) {
        fs.writeFileSync(match[1], png);
      }
      return "";
    }
  });

  assert.deepEqual(adapter.available(), { ok: true });
  assert.deepEqual(adapter.readImagePng(), png);
  assert.equal(execCalls.every((call) => typeof call.timeout === "number"), true);
  // readImagePng must not call the slow `clipboard info` probe — it forces
  // NSPasteboard to materialize every declared representation (TIFF/BMP/...)
  // for the size enumeration, which can take seconds on large screenshots.
  assert.equal(
    execCalls.some((call) => call.args[1] === "clipboard info"),
    false
  );
});

test("darwin clipboard adapter rejects empty or invalid PNG output", async () => {
  const { createDarwinClipboardAdapter } = await loadFreshEsm<DarwinModule>("lib/sandbox/clipboard/darwin.js");

  const adapter = createDarwinClipboardAdapter({
    execFn(cmd, args) {
      const script = String(args[1]);
      const match = script.match(/POSIX file "([^"]+)"/);
      if (match?.[1]) {
        fs.writeFileSync(match[1], "not a png");
      }
      if (args[1] === "clipboard info" || cmd === "osascript") {
        return "";
      }
      return "";
    }
  });

  assert.equal(adapter.readImagePng(), null);
});

test("clipboard adapter factory returns the darwin adapter on macOS", async () => {
  const { createClipboardAdapter } = await loadFreshEsm<IndexModule>("lib/sandbox/clipboard/index.js");
  const adapter = createClipboardAdapter({ platformName: "darwin" });

  assert.notEqual(adapter, null);
  assert.equal(typeof adapter?.available, "function");
  assert.equal(typeof adapter?.readImagePng, "function");
});

test("clipboard adapter factory disables linux", async () => {
  const { createClipboardAdapter } = await loadFreshEsm<IndexModule>("lib/sandbox/clipboard/index.js");

  assert.equal(createClipboardAdapter({ platformName: "linux" }), null);
});

test("clipboard adapter factory disables win32", async () => {
  const { createClipboardAdapter } = await loadFreshEsm<IndexModule>("lib/sandbox/clipboard/index.js");

  assert.equal(createClipboardAdapter({ platformName: "win32" }), null);
});

test("clipboard adapter factory disables unknown platforms", async () => {
  const { createClipboardAdapter } = await loadFreshEsm<IndexModule>("lib/sandbox/clipboard/index.js");

  assert.equal(createClipboardAdapter({ platformName: "sunos" as NodeJS.Platform }), null);
});

test("clipboard bridge falls back with adapter-null warning on linux TTYs", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const stdout = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const calls: string[][] = [];
  const stderr: string[] = [];

  stdin.isTTY = true;
  stdout.isTTY = true;

  const exitCode = await runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "linux",
    stdin: stdin as never,
    stdout: stdout as never,
    runInteractive(_engine, cmd, args) {
      calls.push([cmd, ...args]);
      return 7;
    },
    writeStderr: (chunk) => stderr.push(chunk)
  });

  assert.equal(exitCode, 7);
  assert.deepEqual(calls, [["docker", "exec", "-it", "demo", "bash"]]);
  assert.match(stderr.join(""), /clipboard image paste bridge disabled: no clipboard adapter available on this platform/);
});

test("clipboard bridge falls back with TTY warning before adapter lookup", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const stdout = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const calls: string[][] = [];
  const stderr: string[] = [];

  stdin.isTTY = false;
  stdout.isTTY = true;

  const exitCode = await runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "linux",
    stdin: stdin as never,
    stdout: stdout as never,
    runInteractive(_engine, cmd, args) {
      calls.push([cmd, ...args]);
      return 7;
    },
    writeStderr: (chunk) => stderr.push(chunk)
  });

  assert.equal(exitCode, 7);
  assert.deepEqual(calls, [["docker", "exec", "-it", "demo", "bash"]]);
  assert.match(stderr.join(""), /clipboard image paste bridge disabled: host stdin\/stdout is not a TTY/);
});

test("clipboard bridge falls back when optional node-pty is unavailable", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const stdout = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const calls: string[][] = [];

  stdin.isTTY = true;
  stdout.isTTY = true;

  const exitCode = await runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => null,
    runInteractive(_engine, cmd, args) {
      calls.push([cmd, ...args]);
      return 9;
    },
    writeStderr: () => {}
  });

  assert.equal(exitCode, 9);
  assert.deepEqual(calls, [["docker", "exec", "-it", "demo", "bash"]]);
});

test("clipboard bridge falls back when node-pty spawn fails", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & { isTTY: boolean };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  const calls: string[][] = [];
  const stderr: string[] = [];

  stdin.isTTY = true;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;

  const exitCode = await runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => ({
      spawn() {
        throw new Error("cwd missing");
      }
    }),
    runInteractive(_engine, cmd, args) {
      calls.push([cmd, ...args]);
      return 11;
    },
    writeStderr: (chunk) => stderr.push(chunk)
  });

  assert.equal(exitCode, 11);
  assert.deepEqual(calls, [["docker", "exec", "-it", "demo", "bash"]]);
  assert.match(stderr.join(""), /node-pty spawn failed: cwd missing/);
});

test("clipboard bridge injects bracketed paste for image Ctrl+V", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-bridge-home-"));
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = (value) => { rawModes.push(value); };
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  try {
    const promise = runInteractiveWithClipboardBridge({
      engine: "native",
      dockerArgs: ["exec", "-it", "demo", "bash"],
      container: "demo",
      home: tmpDir,
      platformName: "darwin",
      stdin: stdin as never,
      stdout: stdout as never,
      adapter: {
        available: () => ({ ok: true }),
        readImagePng: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      },
      runOk: () => true,
      loadPty: async () => ({
        spawn() {
          return {
            onData() {},
            onExit(callback) { exitHandler = callback; },
            write(data) { writes.push(data); },
            resize() {},
            kill() {}
          };
        }
      })
    });

    await new Promise((resolve) => setImmediate(resolve));
    stdin.emit("data", Buffer.from("\x1b[27;5;118~", "binary"));
    invokeExitHandler(exitHandler, { exitCode: 0 });

    assert.equal(await promise, 0);
    assert.equal(writes.length, 1);
    assert.match(writes[0] ?? "", /^\x1b\[200~\/clipboard\/[a-f0-9]{16}\.png\x1b\[201~$/);
    assert.deepEqual(rawModes, [true, false]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("clipboard bridge silently forwards Ctrl+V when the clipboard holds no image", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const writes: string[] = [];
  const stderr: string[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    writeStderr: (chunk) => stderr.push(chunk),
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write(data) { writes.push(data); },
          resize() {},
          kill() {}
        };
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("data", Buffer.from("\x1b[27;5;118~", "binary"));
  invokeExitHandler(exitHandler, { exitCode: 0 });

  assert.equal(await promise, 0);
  assert.deepEqual(writes, ["\x1b[27;5;118~"]);
  assert.equal(stderr.length, 0);
});

test("clipboard bridge flushes a standalone ESC after the partial-sequence delay", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const writes: string[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write(data) { writes.push(data); },
          resize() {},
          kill() {}
        };
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("data", Buffer.from("\x1b", "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  invokeExitHandler(exitHandler, { exitCode: 0 });

  assert.equal(await promise, 0);
  assert.deepEqual(writes, ["\x1b"]);
});

test("clipboard bridge preserves UTF-8 input bytes for normal text", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const writes: string[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write(data) { writes.push(data); },
          resize() {},
          kill() {}
        };
      }
    })
  });

  const input = Buffer.from("中文😊", "utf8");
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("data", input);
  invokeExitHandler(exitHandler, { exitCode: 0 });

  assert.equal(await promise, 0);
  assert.deepEqual(Buffer.from(writes.join(""), "utf8"), input);
});

test("clipboard bridge preserves UTF-8 input split across chunks", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const writes: string[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write(data) { writes.push(data); },
          resize() {},
          kill() {}
        };
      }
    })
  });

  const input = Buffer.from("文", "utf8");
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("data", input.subarray(0, 1));
  stdin.emit("data", input.subarray(1));
  invokeExitHandler(exitHandler, { exitCode: 0 });

  assert.equal(await promise, 0);
  assert.deepEqual(Buffer.from(writes.join(""), "utf8"), input);
});

test("clipboard bridge returns signal exit codes before numeric exitCode", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write() {},
          resize() {},
          kill() {}
        };
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  invokeExitHandler(exitHandler, { exitCode: 0, signal: "SIGTERM" });

  assert.equal(await promise, 143);
});

test("clipboard bridge ends and restores terminal when stdin closes before pty onExit", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const rawModes: boolean[] = [];
  const killSignals: Array<string | undefined> = [];

  stdin.isTTY = true;
  stdin.setRawMode = (value) => { rawModes.push(value); };
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit() {},
          write() {},
          resize() {},
          kill(signal) { killSignals.push(signal); }
        };
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("close");

  assert.equal(await promise, 129);
  assert.deepEqual(killSignals, ["SIGHUP"]);
  assert.deepEqual(rawModes, [true, false]);
});

test("clipboard bridge forwards original Ctrl+V sequence when image handling fails", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const writes: string[] = [];
  const stderr: string[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      // Unexpected error path (not "no image" — that would just return null
      // and silently forward Ctrl+V). Verifies the catch branch still warns
      // the user once when the read itself blows up.
      readImagePng: () => { throw new Error("read failed"); }
    },
    runOk: () => true,
    writeStderr: (chunk) => stderr.push(chunk),
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write(data) { writes.push(data); },
          resize() {},
          kill() {}
        };
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("data", Buffer.from("\x1b[27;5;118~", "binary"));
  invokeExitHandler(exitHandler, { exitCode: 0 });

  assert.equal(await promise, 0);
  assert.deepEqual(writes, ["\x1b[27;5;118~"]);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0] ?? "", /read failed/);
});

test("clipboard bridge pauses stdin on exit so the host process can exit", async () => {
  const { runInteractiveWithClipboardBridge } = await loadFreshEsm<BridgeModule>("lib/sandbox/clipboard/bridge.js");
  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    resume(): void;
    pause(): void;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write(chunk: string): void;
  };
  const lifecycle: string[] = [];
  let exitHandler: PtyExitHandler | null = null;

  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.resume = () => { lifecycle.push("resume"); };
  stdin.pause = () => { lifecycle.push("pause"); };
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.write = () => {};

  const promise = runInteractiveWithClipboardBridge({
    engine: "native",
    dockerArgs: ["exec", "-it", "demo", "bash"],
    container: "demo",
    home: "/tmp/home",
    platformName: "darwin",
    stdin: stdin as never,
    stdout: stdout as never,
    adapter: {
      available: () => ({ ok: true }),
      readImagePng: () => null
    },
    runOk: () => true,
    writeStderr: () => {},
    loadPty: async () => ({
      spawn() {
        return {
          onData() {},
          onExit(callback) { exitHandler = callback; },
          write() {},
          resize() {},
          kill() {}
        };
      }
    })
  });

  await new Promise((resolve) => setImmediate(resolve));
  invokeExitHandler(exitHandler, { exitCode: 0 });

  assert.equal(await promise, 0);
  // stdin must be paused on teardown, after it was resumed, so the resumed TTY
  // handle stops keeping the event loop alive (otherwise the CLI hangs on exit).
  assert.deepEqual(lifecycle, ["resume", "pause"]);
});
