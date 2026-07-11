import test from "node:test";
import assert from "node:assert/strict";

import { cmdCp, runCommand, type SpawnResult } from "../../../lib/cp.ts";
import type { ClipboardAdapter } from "../../../lib/sandbox/clipboard/index.ts";

type SpawnCall = { cmd: string; args: string[]; input?: string };

function imageAdapter(png: Buffer | null): ClipboardAdapter {
  return {
    available() {
      return { ok: true };
    },
    readImagePng() {
      return png;
    }
  };
}

function outputDeps(): {
  stdout: string[];
  stderr: string[];
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (chunk: string) => {
      stdout.push(chunk);
    },
    writeStderr: (chunk: string) => {
      stderr.push(chunk);
    }
  };
}

function successResult(): SpawnResult {
  return { status: 0, stdout: "", stderr: "" };
}

test("runCommand sends input to stdin and captures stdout and stderr", () => {
  // Intentionally spawns the Node runtime to verify the real stdin/stderr boundary, not the project CLI.
  const result = runCommand(process.execPath, [
    "-e",
    "process.stdin.pipe(process.stdout); process.stderr.write('ERR_PROBE')"
  ], "PIPE_PROBE");

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "PIPE_PROBE");
  assert.equal(result.stderr, "ERR_PROBE");
});

test("help flags return usage before parsing or spawning", async () => {
  for (const helpArg of ["--help", "-h", "help"]) {
    const output = outputDeps();
    let spawnCount = 0;
    const code = await cmdCp([helpArg], {
      ...output,
      spawnFn: () => {
        spawnCount += 1;
        return successResult();
      }
    });

    assert.equal(code, 0);
    assert.match(output.stdout.join(""), /^Usage: ai cp <ssh-alias>/);
    assert.equal(output.stderr.join(""), "");
    assert.equal(spawnCount, 0);
  }
});

test("missing alias returns usage", async () => {
  const output = outputDeps();
  const code = await cmdCp([], output);

  assert.equal(code, 1);
  assert.match(output.stderr.join(""), /^Usage: ai cp <ssh-alias>/);
});

test("dash-leading alias is rejected before spawning", async () => {
  const output = outputDeps();
  let spawnCount = 0;
  const code = await cmdCp(["--", "-rf"], {
    ...output,
    spawnFn: () => {
      spawnCount += 1;
      return successResult();
    }
  });

  assert.equal(code, 1);
  assert.match(output.stderr.join(""), /must not start with '-'/);
  assert.equal(spawnCount, 0);
});

test("non-darwin sender is rejected before spawning", async () => {
  const output = outputDeps();
  let spawnCount = 0;
  const code = await cmdCp(["mini"], {
    ...output,
    platform: "linux",
    spawnFn: () => {
      spawnCount += 1;
      return successResult();
    }
  });

  assert.equal(code, 1);
  assert.match(output.stderr.join(""), /macOS senders only/);
  assert.equal(spawnCount, 0);
});

test("empty clipboard image is reported before spawning", async () => {
  const output = outputDeps();
  let spawnCount = 0;
  const code = await cmdCp(["mini"], {
    ...output,
    platform: "darwin",
    createAdapter: () => imageAdapter(null),
    spawnFn: () => {
      spawnCount += 1;
      return successResult();
    }
  });

  assert.equal(code, 1);
  assert.match(output.stderr.join(""), /no image/);
  assert.equal(spawnCount, 0);
});

test("happy path uploads png, sets remote clipboard, and cleans up", async () => {
  const output = outputDeps();
  const calls: SpawnCall[] = [];
  const removed: string[] = [];
  const written: Array<{ file: string; data: Buffer }> = [];
  const code = await cmdCp(["mini"], {
    ...output,
    platform: "darwin",
    createAdapter: () => imageAdapter(Buffer.from("PNG_BYTES")),
    randomId: () => "fixed",
    tmpdir: () => "/tmp",
    mkdtempFn: () => "/tmp/agent-infra-cp-local",
    writeFileFn: (file, data) => {
      written.push({ file, data });
    },
    rmFn: (target) => {
      removed.push(target);
    },
    spawnFn: (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (calls.length === 1) return { ...successResult(), stdout: "Darwin\n" };
      return successResult();
    }
  });

  assert.equal(code, 0);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.data.toString(), "PNG_BYTES");
  assert.equal(calls.length, 4);
  assert.equal(calls[0]?.cmd, "ssh");
  assert.equal(calls[1]?.cmd, "scp");
  assert.equal(calls[1]?.args.at(-1), "mini:/tmp/agent-infra-cp-fixed.png");
  assert.equal(calls[2]?.cmd, "ssh");
  assert.deepEqual(calls[2]?.args.slice(-3), ["mini", "osascript", "-"]);
  assert.match(calls[2]?.input ?? "", /«class PNGf»/);
  assert.match(calls[2]?.input ?? "", /\/tmp\/agent-infra-cp-fixed\.png/);
  assert.equal(calls[3]?.cmd, "ssh");
  assert.deepEqual(calls[3]?.args.slice(-3), ["rm", "-f", "/tmp/agent-infra-cp-fixed.png"]);
  assert.deepEqual(removed, ["/tmp/agent-infra-cp-local"]);
  assert.match(output.stdout.join(""), /copied clipboard image to mini/);
});

test("scp failure reports captured stderr and only local cleanup runs", async () => {
  const output = outputDeps();
  const calls: SpawnCall[] = [];
  const removed: string[] = [];
  const code = await cmdCp(["mini"], {
    ...output,
    platform: "darwin",
    createAdapter: () => imageAdapter(Buffer.from("PNG_BYTES")),
    randomId: () => "fixed",
    tmpdir: () => "/tmp",
    mkdtempFn: () => "/tmp/agent-infra-cp-local",
    writeFileFn: () => {},
    rmFn: (target) => {
      removed.push(target);
    },
    spawnFn: (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (calls.length === 1) return { ...successResult(), stdout: "Darwin\n" };
      return { status: 1, stdout: "", stderr: "scp failed" };
    }
  });

  assert.equal(code, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.cmd, "scp");
  assert.match(output.stderr.join(""), /failed to upload image to mini/);
  assert.match(output.stderr.join(""), /scp failed/);
  assert.deepEqual(removed, ["/tmp/agent-infra-cp-local"]);
});

test("remote clipboard failure reports captured stderr and runs remote cleanup", async () => {
  const output = outputDeps();
  const calls: SpawnCall[] = [];
  const removed: string[] = [];
  const code = await cmdCp(["mini"], {
    ...output,
    platform: "darwin",
    createAdapter: () => imageAdapter(Buffer.from("PNG_BYTES")),
    randomId: () => "fixed",
    tmpdir: () => "/tmp",
    mkdtempFn: () => "/tmp/agent-infra-cp-local",
    writeFileFn: () => {},
    rmFn: (target) => {
      removed.push(target);
    },
    spawnFn: (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (calls.length === 1) return { ...successResult(), stdout: "Darwin\n" };
      if (calls.length === 3) {
        return { status: 255, stdout: "", stderr: "osascript failed" };
      }
      return successResult();
    }
  });

  assert.equal(code, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[2]?.cmd, "ssh");
  assert.equal(calls[3]?.cmd, "ssh");
  assert.deepEqual(calls[3]?.args.slice(-3), ["rm", "-f", "/tmp/agent-infra-cp-fixed.png"]);
  assert.match(output.stderr.join(""), /failed to set remote clipboard on mini/);
  assert.match(output.stderr.join(""), /osascript failed/);
  assert.deepEqual(removed, ["/tmp/agent-infra-cp-local"]);
});

test("linux remote flow verifies the receiver before uploading and preserves the pending path", async () => {
  const output = outputDeps();
  const calls: SpawnCall[] = [];
  const code = await cmdCp(["cloud"], {
    ...output,
    platform: "darwin",
    createAdapter: () => imageAdapter(Buffer.from("PNG_BYTES")),
    randomId: () => "fixed",
    mkdtempFn: () => "/tmp/agent-infra-cp-local",
    writeFileFn: () => {},
    rmFn: () => {},
    spawnFn: (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (calls.length === 1) return { ...successResult(), stdout: "Linux\n" };
      if (calls.length === 2) return successResult();
      if (calls.length === 3) return { ...successResult(), stdout: "AGENT_INFRA_CLIPBOARD_RECEIVER:v1\n" };
      if (calls.length === 5) return { ...successResult(), stdout: "/clipboard/1234567890abcdef.png\n" };
      return successResult();
    }
  });

  assert.equal(code, 0);
  assert.equal(calls[3]?.cmd, "scp");
  assert.deepEqual(calls[4]?.args.slice(-4), ["ai", "cp", "--remote-receive-v1", "/tmp/agent-infra-cp-fixed.png"]);
  assert.match(output.stdout.join(""), /uploaded clipboard image to cloud;.*Ctrl\+V/);
});
