import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { envWithPrependedPath, read } from "../helpers.js";

function makeFakeGif(frameCount, initialDelayCs = 2) {
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

  for (let index = 0; index < frameCount; index += 1) {
    bytes.push(
      0x21,
      0xF9,
      0x04,
      0x00,
      initialDelayCs & 0xFF,
      initialDelayCs >> 8,
      0x00,
      0x00
    );
  }

  bytes.push(0x3B);
  return Buffer.from(bytes);
}

function readGifDelays(filePath) {
  const data = fs.readFileSync(filePath);
  const delays = [];

  for (let index = 0; index < data.length - 7; index += 1) {
    if (data[index] === 0x21 && data[index + 1] === 0xF9 && data[index + 2] === 0x04) {
      delays.push(data.readUInt16LE(index + 4));
      index += 7;
    }
  }

  return delays;
}

function setupDemoRegenFixture({ withLocalSettings }) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-regen-"));
  const assetsDir = path.join(repoDir, "assets");
  const scriptsDir = path.join(repoDir, "scripts");
  const binDir = path.join(repoDir, "bin");
  const capturedTapePath = path.join(repoDir, "captured.tape");
  const sourceGifPath = path.join(repoDir, "source.gif");

  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(path.join(assetsDir, "demo-init.tape"), read("assets/demo-init.tape"), "utf8");
  if (withLocalSettings) {
    fs.writeFileSync(path.join(assetsDir, "demo-settings.tape"), "Set Framerate 19\n", "utf8");
  }
  fs.writeFileSync(path.join(scriptsDir, "demo-regen.sh"), read("scripts/demo-regen.sh"), "utf8");
  fs.writeFileSync(
    path.join(scriptsDir, "normalize-gif-duration.js"),
    read("scripts/normalize-gif-duration.js"),
    "utf8"
  );
  fs.writeFileSync(sourceGifPath, makeFakeGif(4));

  // VHS shim: captures the merged tape and outputs the source GIF as a webm
  const vhsShimPath = path.join(binDir, "vhs");
  fs.writeFileSync(
    vhsShimPath,
    `#!/bin/sh
set -e
cp "$1" "$TEST_CAPTURE_TAPE"
cp "$TEST_SOURCE_GIF" assets/demo-init.webm
`,
    "utf8"
  );
  fs.chmodSync(vhsShimPath, 0o755);

  // ffmpeg shim: for palette pass outputs a dummy png, for encode pass copies webm as gif
  const ffmpegShimPath = path.join(binDir, "ffmpeg");
  fs.writeFileSync(
    ffmpegShimPath,
    `#!/bin/sh
set -e
# Find the output file (last argument)
out=""
for arg; do out="$arg"; done
case "$out" in
  *.png) touch "$out" ;;
  *.gif) cp assets/demo-init.webm "$out" ;;
esac
`,
    "utf8"
  );
  fs.chmodSync(ffmpegShimPath, 0o755);

  return {
    repoDir,
    assetsDir,
    capturedTapePath,
    sourceGifPath,
    env: {
      ...envWithPrependedPath(process.env, binDir),
      TEST_CAPTURE_TAPE: capturedTapePath,
      TEST_SOURCE_GIF: sourceGifPath
    }
  };
}

test("normalize-gif-duration distributes delays to hit the target duration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "normalize-gif-"));
  const gifPath = path.join(tempDir, "demo.gif");

  try {
    fs.writeFileSync(gifPath, makeFakeGif(663));

    const result = spawnSync(
      process.execPath,
      ["scripts/normalize-gif-duration.js", gifPath, "25"],
      {
        cwd: path.resolve("."),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);

    const delays = readGifDelays(gifPath);
    assert.equal(delays.length, 663);
    assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 2500);
    assert.deepEqual(new Set(delays), new Set([3, 4]));
    assert.match(result.stdout, /Normalized: 663 frames, 30-40ms, total 25\.0s/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normalize-gif-duration leaves files without GCE blocks unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "normalize-gif-"));
  const gifPath = path.join(tempDir, "empty.gif");
  const original = Buffer.from("GIF89a\x3B", "binary");

  try {
    fs.writeFileSync(gifPath, original);

    const result = spawnSync(
      process.execPath,
      ["scripts/normalize-gif-duration.js", gifPath, "25"],
      {
        cwd: path.resolve("."),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(gifPath).equals(original), true);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("demo-regen merges local settings before running VHS and normalizes output", () => {
  const fixture = setupDemoRegenFixture({ withLocalSettings: true });
  const {
    repoDir,
    assetsDir,
    capturedTapePath,
    env
  } = fixture;

  try {
    const result = spawnSync("sh", ["scripts/demo-regen.sh"], {
      cwd: repoDir,
      encoding: "utf8",
      env
    });

    assert.equal(result.status, 0, result.stderr);

    const mergedTape = fs.readFileSync(capturedTapePath, "utf8");
    assert.match(mergedTape, /^Set Framerate 19$/m);
    assert.match(mergedTape, /Output assets\/demo-init\.webm/);
    assert.match(result.stdout, /Normalized: 4 frames, 6250ms, total 25\.0s/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("demo-regen works without a local settings tape", () => {
  const fixture = setupDemoRegenFixture({ withLocalSettings: false });
  const {
    repoDir,
    capturedTapePath,
    env
  } = fixture;

  try {
    const result = spawnSync("sh", ["scripts/demo-regen.sh"], {
      cwd: repoDir,
      encoding: "utf8",
      env
    });

    assert.equal(result.status, 0, result.stderr);

    const mergedTape = fs.readFileSync(capturedTapePath, "utf8");
    assert.doesNotMatch(mergedTape, /^Set Framerate 19$/m);
    assert.match(mergedTape, /Output assets\/demo-init\.webm/);
    assert.match(result.stdout, /Normalized: 4 frames, 6250ms, total 25\.0s/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
