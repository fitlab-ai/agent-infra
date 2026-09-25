import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { read } from "../../helpers.ts";

type CompletedTaskOptions = {
  completedAt: string;
  updatedAt?: string;
  type?: string;
  title: string;
  extraFile?: string;
};

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function runArchiveScript(repoDir: string, ...args: string[]): string {
  const result = spawnSync(
    "sh",
    [path.join(repoDir, ".agents/skills/archive-tasks/scripts/archive-tasks.sh"), ...args],
    {
      cwd: repoDir,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error(`archive-tasks failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

function setupRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-tasks-"));

  fs.mkdirSync(path.join(repoDir, ".agents/skills/archive-tasks/scripts"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".agents/workspace/completed"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, ".agents/skills/archive-tasks/scripts/archive-tasks.sh"),
    read(".agents/skills/archive-tasks/scripts/archive-tasks.sh"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repoDir, ".agents/skills/archive-tasks/scripts/migrate-archive.mjs"),
    read(".agents/skills/archive-tasks/scripts/migrate-archive.mjs"),
    "utf8"
  );

  return repoDir;
}

test("archive migration verifies an external backup, writes local checksums, and restores the old tree", () => {
  const repoDir = setupRepo();
  const taskId = "TASK-20260301-000101";
  const taskDir = path.join(repoDir, ".agents/workspace/archive/2026/03/01", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), `---\nid: ${taskId}\n---\n# Task\n`);
  fs.writeFileSync(path.join(taskDir, "note.txt"), "original note\n");
  fs.writeFileSync(path.join(repoDir, ".agents/workspace/archive/manifest.md"), "navigation\n");
  const migration = path.join(repoDir, ".agents/skills/archive-tasks/scripts/migrate-archive.mjs");
  const migrated = spawnSync(process.execPath, [migration], { cwd: repoDir, encoding: "utf8" });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(fs.existsSync(path.join(taskDir, "local/task.md")), true);
  assert.equal(fs.existsSync(path.join(taskDir, "local/contents.sha256")), true);
  assert.equal(fs.existsSync(path.join(repoDir, ".agents/workspace/.archive-migration-state.json")), false);

  const backup = fs.readdirSync(path.join(repoDir, ".agents/workspace/archive-backups"))
    .filter((name) => name.endsWith(".tar"))
    .map((name) => path.join(repoDir, ".agents/workspace/archive-backups", name))[0]!;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(backup)).digest("hex");
  const markerPath = path.join(repoDir, ".agents/workspace/.archive-migration-state.json");
  fs.writeFileSync(markerPath, JSON.stringify({
    schema_version: 1,
    state: "migrating",
    backup: path.relative(path.join(repoDir, ".agents/workspace"), backup).split(path.sep).join("/"),
    backup_sha256: digest
  }));
  const restored = spawnSync(process.execPath, [migration, "--restore", backup], { cwd: repoDir, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(taskDir, "task.md"), "utf8").includes(taskId), true);
  assert.equal(fs.readFileSync(path.join(taskDir, "note.txt"), "utf8"), "original note\n");
  assert.equal(fs.existsSync(markerPath), false);
});

test("archive migration validates multi-file checksums in path order", () => {
  const repoDir = setupRepo();
  const taskId = "TASK-20260301-000104";
  const taskDir = path.join(repoDir, ".agents/workspace/archive/2026/03/01", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), "a");
  fs.writeFileSync(path.join(taskDir, "z.txt"), "b");
  const migration = path.join(repoDir, ".agents/skills/archive-tasks/scripts/migrate-archive.mjs");

  const result = spawnSync(process.execPath, [migration], { cwd: repoDir, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(taskDir, "local/task.md"), "utf8"), "a");
  assert.equal(fs.readFileSync(path.join(taskDir, "local/z.txt"), "utf8"), "b");
  assert.equal(fs.existsSync(path.join(repoDir, ".agents/workspace/.archive-migration-state.json")), false);
});

test("a killed migration leaves a marker that blocks a fresh archive writer until restore", async () => {
  const repoDir = setupRepo();
  const taskId = "TASK-20260301-000102";
  const taskDir = path.join(repoDir, ".agents/workspace/archive/2026/03/01", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "task.md"), `---\nid: ${taskId}\n---\n# Task\n`);
  const completed = path.join(repoDir, ".agents/workspace/completed/TASK-20260301-000103");
  fs.mkdirSync(completed, { recursive: true });
  fs.writeFileSync(path.join(completed, "task.md"), "---\ncompleted_at: 2026-03-01\n---\n# Task\n");
  const migration = path.join(repoDir, ".agents/skills/archive-tasks/scripts/migrate-archive.mjs");
  const child = spawn(process.execPath, [migration], {
    cwd: repoDir,
    env: { ...process.env, NODE_ENV: "test", ARCHIVE_MIGRATION_TEST_PAUSE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("marker-ready")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`migration exited before marker: ${code}; ${stdout}`)));
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const markerPath = path.join(repoDir, ".agents/workspace/.archive-migration-state.json");
  assert.equal(fs.existsSync(markerPath), true);
  const writer = spawnSync("sh", [path.join(repoDir, ".agents/skills/archive-tasks/scripts/archive-tasks.sh")], { cwd: repoDir, encoding: "utf8" });
  assert.notEqual(writer.status, 0);
  assert.match(writer.stderr, /migration state exists/);
  assert.equal(fs.existsSync(completed), true);

  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { backup: string };
  const backup = path.join(repoDir, ".agents/workspace", marker.backup);
  const restored = spawnSync(process.execPath, [migration, "--restore", backup], { cwd: repoDir, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.existsSync(path.join(taskDir, "task.md")), true);
  assert.equal(fs.existsSync(markerPath), false);
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function writeCompletedTask(
  repoDir: string,
  taskId: string,
  { completedAt, updatedAt = completedAt, type = "feature", title, extraFile = "note.txt" }: CompletedTaskOptions
) {
  const taskDir = path.join(repoDir, ".agents/workspace/completed", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "task.md"),
    `---\nid: ${taskId}\ntype: ${type}\nstatus: completed\nupdated_at: ${updatedAt}\ncompleted_at: ${completedAt}\n---\n\n# 任务：${title}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(taskDir, extraFile), `${taskId}\n`, "utf8");
}

test("archive-tasks archives all completed tasks and rebuilds the manifest", () => {
  const repoDir = setupRepo();

  try {
    writeCompletedTask(repoDir, "TASK-20260301-000001", {
      completedAt: "2026-03-01 09:00:00",
      type: "feature",
      title: "归档旧任务"
    });
    writeCompletedTask(repoDir, "TASK-20260302-000002", {
      completedAt: "2026-03-02 11:30:00",
      type: "bug",
      title: "修复 manifest | 表格"
    });

    const output = runArchiveScript(repoDir);
    const archiveRoot = path.join(repoDir, ".agents/workspace/archive");
    const firstArchive = path.join(archiveRoot, "2026/03/01/TASK-20260301-000001");
    const secondArchive = path.join(archiveRoot, "2026/03/02/TASK-20260302-000002");
    const rootManifest = fs.readFileSync(path.join(archiveRoot, "manifest.md"), "utf8");
    const yearManifest = fs.readFileSync(path.join(archiveRoot, "2026/manifest.md"), "utf8");
    const monthManifest = fs.readFileSync(path.join(archiveRoot, "2026/03/manifest.md"), "utf8");

    assert.match(output, /Archived TASK-20260301-000001 -> 2026\/03\/01\/TASK-20260301-000001\//);
    assert.match(output, /Archived TASK-20260302-000002 -> 2026\/03\/02\/TASK-20260302-000002\//);
    assert.match(output, /- Archived: 2/);
    assert.ok(fs.existsSync(firstArchive), "first task should be moved into the dated archive path");
    assert.ok(fs.existsSync(secondArchive), "second task should be moved into the dated archive path");
    assert.ok(fs.existsSync(path.join(secondArchive, "local/note.txt")), "task files should be moved without compression");
    assert.ok(fs.existsSync(path.join(secondArchive, "local/contents.sha256")), "local archive content should have a checksum manifest");
    assert.ok(
      !fs.existsSync(path.join(repoDir, ".agents/workspace/completed", "TASK-20260301-000001")),
      "archived tasks should no longer remain in completed/"
    );
    assert.match(rootManifest, /\| 2026 \| 2 \| \[2026\/manifest\.md\]\(2026\/manifest\.md\) \|/);
    assert.match(yearManifest, /\| 03 \| 2 \| \[03\/manifest\.md\]\(03\/manifest\.md\) \|/);
    assert.match(monthManifest, /\| TASK-20260302-000002 \| 修复 manifest \\| 表格 \| bug \| 2026-03-02 11:30:00 \| 2026\/03\/02\/TASK-20260302-000002\/ \|/);
    assert.match(monthManifest, /\| TASK-20260301-000001 \| 归档旧任务 \| feature \| 2026-03-01 09:00:00 \| 2026\/03\/01\/TASK-20260301-000001\/ \|/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("archive-tasks limits monthly manifests to 1000 entries with a truncation note", () => {
  const repoDir = setupRepo();

  try {
    for (let index = 1; index <= 1001; index += 1) {
      const taskId = `TASK-20260315-${String(index).padStart(6, "0")}`;
      const local = path.join(repoDir, ".agents/workspace/archive/2026/03/15", taskId, "local");
      fs.mkdirSync(
        local,
        { recursive: true }
      );
      const taskContent = `---\nid: ${taskId}\n---\n# ${taskId}\n`;
      fs.writeFileSync(path.join(local, "task.md"), taskContent);
      const digest = crypto.createHash("sha256").update(taskContent).digest("hex");
      fs.writeFileSync(path.join(local, "contents.sha256"), `${digest}  task.md\n`);
    }

    runArchiveScript(repoDir);

    const monthManifest = fs.readFileSync(
      path.join(repoDir, ".agents/workspace/archive/2026/03/manifest.md"),
      "utf8"
    );

    const taskRows = monthManifest.match(/\| TASK-20260315-[0-9]{6} \|/g) ?? [];
    assert.equal(taskRows.length, 1000, "monthly manifest should keep only the latest 1000 task rows");
    assert.match(monthManifest, /> Showing 1000 of 1001 entries\./);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("archive-tasks supports --before and explicit task IDs", () => {
  const repoDir = setupRepo();

  try {
    writeCompletedTask(repoDir, "TASK-20260305-000005", {
      completedAt: "2026-03-05 08:00:00",
      title: "较早任务"
    });
    writeCompletedTask(repoDir, "TASK-20260312-000012", {
      completedAt: "2026-03-12 08:00:00",
      title: "较新任务"
    });

    runArchiveScript(repoDir, "--before", "2026-03-10");
    assert.ok(
      fs.existsSync(path.join(repoDir, ".agents/workspace/archive/2026/03/05/TASK-20260305-000005")),
      "--before should archive tasks older than the given date"
    );
    assert.ok(
      fs.existsSync(path.join(repoDir, ".agents/workspace/completed/TASK-20260312-000012")),
      "--before should retain newer tasks in completed/"
    );

    const output = runArchiveScript(repoDir, "TASK-20260312-000012");
    assert.match(output, /Archived TASK-20260312-000012 -> 2026\/03\/12\/TASK-20260312-000012\//);
    assert.ok(
      fs.existsSync(path.join(repoDir, ".agents/workspace/archive/2026/03/12/TASK-20260312-000012")),
      "explicit task IDs should archive the requested task"
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("archive-tasks supports --days and skips already archived task IDs", () => {
  const repoDir = setupRepo();
  const now = new Date();
  const older = new Date(now);
  const recent = new Date(now);

  older.setDate(older.getDate() - 10);
  recent.setDate(recent.getDate() - 2);

  try {
    writeCompletedTask(repoDir, "TASK-OLDER-0001", {
      completedAt: `${formatDate(older)} 10:00:00`,
      title: "旧任务"
    });
    writeCompletedTask(repoDir, "TASK-RECENT-0002", {
      completedAt: `${formatDate(recent)} 10:00:00`,
      title: "新任务"
    });

    const firstOutput = runArchiveScript(repoDir, "--days", "5");
    assert.match(firstOutput, /- Archived: 1/);
    assert.ok(
      fs.existsSync(path.join(repoDir, `.agents/workspace/archive/${formatDate(older).replace(/-/g, "/")}/TASK-OLDER-0001`)),
      "--days should archive tasks older than the retention window"
    );
    assert.ok(
      fs.existsSync(path.join(repoDir, ".agents/workspace/completed/TASK-RECENT-0002")),
      "--days should keep recent tasks in completed/"
    );

    const secondOutput = runArchiveScript(repoDir, "TASK-OLDER-0001");
    assert.match(secondOutput, /Skipped TASK-OLDER-0001 \(already archived at .*TASK-OLDER-0001\/\)/);
    assert.match(secondOutput, /- Archived: 0/);
    assert.match(secondOutput, /- Skipped: 1/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
