import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { filePath } from "../helpers.js";

function modeBits(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function runMigration(homeDir) {
  execFileSync("sh", [filePath("scripts/migrate-to-agent-infra.sh")], {
    env: { ...process.env, HOME: homeDir },
    stdio: "pipe"
  });
}

test("migrate-to-agent-infra moves legacy sandbox state into ~/.agent-infra and is idempotent", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-migrate-full-"));

  try {
    fs.mkdirSync(path.join(homeDir, ".claude-sandboxes", "demo", "feature..demo"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".claude-sandboxes", "demo", "feature..demo", "settings.json"),
      "{}\n",
      "utf8"
    );
    fs.mkdirSync(path.join(homeDir, ".codex-sandboxes", "demo", "feature-demo"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".codex-sandboxes", "demo", "feature-demo", "config.toml"),
      "trusted = true\n",
      "utf8"
    );

    fs.mkdirSync(path.join(homeDir, ".demo-worktrees", "feature..demo"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".demo-worktrees", "feature..demo", "README.md"), "demo\n", "utf8");

    const gpgDir = path.join(homeDir, ".demo-gpg-cache");
    fs.mkdirSync(gpgDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(gpgDir, "public.asc"), "pub", { mode: 0o644 });
    fs.writeFileSync(path.join(gpgDir, "secret.asc"), "sec", { mode: 0o644 });
    fs.writeFileSync(path.join(gpgDir, "state.json"), "{\n}\n", { mode: 0o644 });

    const credentialsDir = path.join(homeDir, ".demo-claude-credentials");
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(credentialsDir, ".credentials.json"), '{"token":"demo"}\n', { mode: 0o644 });

    fs.writeFileSync(path.join(homeDir, ".ai-sandbox-aliases"), "alias cy='claude --dangerously-skip-permissions'\n", "utf8");

    runMigration(homeDir);

    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "sandboxes", "claude-code", "demo", "feature..demo")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "sandboxes", "codex", "demo", "feature-demo")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "worktrees", "demo", "feature..demo")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "gpg-cache", "demo", "public.asc")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "aliases", "sandbox.sh")),
      true
    );

    assert.equal(fs.existsSync(path.join(homeDir, ".claude-sandboxes")), false);
    assert.equal(fs.existsSync(path.join(homeDir, ".codex-sandboxes")), false);
    assert.equal(fs.existsSync(path.join(homeDir, ".demo-worktrees")), false);
    assert.equal(fs.existsSync(path.join(homeDir, ".demo-gpg-cache")), false);
    assert.equal(fs.existsSync(path.join(homeDir, ".demo-claude-credentials")), false);
    assert.equal(fs.existsSync(path.join(homeDir, ".ai-sandbox-aliases")), false);

    assert.equal(modeBits(path.join(homeDir, ".agent-infra", "gpg-cache", "demo")), 0o700);
    assert.equal(modeBits(path.join(homeDir, ".agent-infra", "gpg-cache", "demo", "public.asc")), 0o600);
    assert.equal(modeBits(path.join(homeDir, ".agent-infra", "gpg-cache", "demo", "secret.asc")), 0o600);
    assert.equal(modeBits(path.join(homeDir, ".agent-infra", "gpg-cache", "demo", "state.json")), 0o600);
    assert.equal(modeBits(path.join(homeDir, ".agent-infra", "credentials", "demo", "claude-code")), 0o700);
    assert.equal(
      modeBits(path.join(homeDir, ".agent-infra", "credentials", "demo", "claude-code", ".credentials.json")),
      0o600
    );

    const aliasesPath = path.join(homeDir, ".agent-infra", "aliases", "sandbox.sh");
    const aliasesBefore = fs.readFileSync(aliasesPath, "utf8");
    runMigration(homeDir);
    assert.equal(fs.readFileSync(aliasesPath, "utf8"), aliasesBefore);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("migrate-to-agent-infra migrates only the aliases file when it is the sole legacy artifact", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-migrate-aliases-"));

  try {
    fs.writeFileSync(path.join(homeDir, ".ai-sandbox-aliases"), "alias xy='codex --yolo'\n", "utf8");

    runMigration(homeDir);

    assert.equal(
      fs.readFileSync(path.join(homeDir, ".agent-infra", "aliases", "sandbox.sh"), "utf8"),
      "alias xy='codex --yolo'\n"
    );
    assert.equal(fs.existsSync(path.join(homeDir, ".ai-sandbox-aliases")), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("migrate-to-agent-infra migrates only the worktree directory when it is the sole legacy artifact", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-migrate-worktrees-"));

  try {
    fs.mkdirSync(path.join(homeDir, ".demo-worktrees", "feature..demo"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".demo-worktrees", "feature..demo", "notes.txt"), "ok\n", "utf8");

    runMigration(homeDir);

    assert.equal(
      fs.existsSync(path.join(homeDir, ".agent-infra", "worktrees", "demo", "feature..demo", "notes.txt")),
      true
    );
    assert.equal(fs.existsSync(path.join(homeDir, ".demo-worktrees")), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
