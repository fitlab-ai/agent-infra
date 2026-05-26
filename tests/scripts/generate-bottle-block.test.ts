import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filePath } from "../helpers.ts";

const scriptPath = filePath(".github/scripts/generate-bottle-block.mjs");
const rootUrl = "https://github.com/fitlab-ai/agent-infra/releases/download/v0.6.2";
const platforms = ["arm64_tahoe", "arm64_sequoia", "arm64_sonoma", "sonoma"];

function bottleJson(platform: string, sha256: string, options: { rootUrl?: string; cellar?: string } = {}) {
  return {
    "fitlab-ai/tap/agent-infra": {
      formula: {
        name: "agent-infra",
        pkg_version: "0.6.2",
      },
      bottle: {
        root_url: options.rootUrl ?? rootUrl,
        cellar: options.cellar ?? "any_skip_relocation",
        rebuild: 0,
        tags: {
          [platform]: {
            filename: `agent-infra-0.6.2.${platform}.bottle.tar.gz`,
            local_filename: `agent-infra--0.6.2.${platform}.bottle.tar.gz`,
            sha256,
          },
        },
      },
    },
  };
}

function withTempDir(callback: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-bottles-"));
  try {
    callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeBottles(dir: string, selectedPlatforms = platforms, options: { rootUrl?: string; cellar?: string } = {}) {
  for (const [index, platform] of selectedPlatforms.entries()) {
    const sha256 = `${index + 1}`.repeat(64).slice(0, 64);
    fs.writeFileSync(
      path.join(dir, `agent-infra--0.6.2.${platform}.bottle.json`),
      JSON.stringify(bottleJson(platform, sha256, options), null, 2),
    );
  }
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: filePath("."),
    encoding: "utf8",
    env: process.env,
  });
}

test("generate-bottle-block prints a Homebrew bottle block for all expected platforms", () => {
  withTempDir((dir) => {
    writeBottles(dir);

    const result = runScript(["--bottles", dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /  bottle do/);
    assert.match(result.stdout, new RegExp(`root_url "${rootUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    for (const platform of platforms) {
      assert.match(result.stdout, new RegExp(`sha256 cellar: :any_skip_relocation, ${platform}:\\s+"[0-9a-f]+"`));
    }
    assert.match(result.stdout, /  end/);
  });
});

test("generate-bottle-block replaces the formula placeholder when a formula path is provided", () => {
  withTempDir((dir) => {
    writeBottles(dir);
    const formulaPath = path.join(dir, "agent-infra.rb");
    fs.writeFileSync(formulaPath, [
      "class AgentInfra < Formula",
      "  license \"MIT\"",
      "  # __BOTTLE_BLOCK__",
      "end",
      "",
    ].join("\n"));

    const result = runScript(["--bottles", dir, "--formula", formulaPath]);
    const formula = fs.readFileSync(formulaPath, "utf8");

    assert.equal(result.status, 0, result.stderr);
    assert.match(formula, /  bottle do/);
    assert.match(formula, /root_url/);
    assert.match(formula, /sha256 cellar: :any_skip_relocation, sonoma:/);
  });
});

test("generate-bottle-block fails when an expected platform is missing", () => {
  withTempDir((dir) => {
    writeBottles(dir, platforms.filter((platform) => platform !== "sonoma"));

    const result = runScript(["--bottles", dir]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing bottle for platform: sonoma/);
  });
});

test("generate-bottle-block fails when root URLs disagree", () => {
  withTempDir((dir) => {
    writeBottles(dir, ["arm64_tahoe"]);
    fs.writeFileSync(
      path.join(dir, "agent-infra--0.6.2.arm64_sequoia.bottle.json"),
      JSON.stringify(bottleJson("arm64_sequoia", "2".repeat(64), { rootUrl: `${rootUrl}-other` }), null, 2),
    );
    writeBottles(dir, ["arm64_sonoma", "sonoma"]);

    const result = runScript(["--bottles", dir]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root_url mismatch/);
  });
});

test("generate-bottle-block quotes path cellar values", () => {
  withTempDir((dir) => {
    writeBottles(dir, platforms, { cellar: "/opt/homebrew/Cellar" });

    const result = runScript(["--bottles", dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cellar: "\/opt\/homebrew\/Cellar"/);
  });
});
