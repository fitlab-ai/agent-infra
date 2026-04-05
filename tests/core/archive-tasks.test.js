import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { read } from "../helpers.js";

function formatDate(value) {
  return value.toISOString().slice(0, 10);
}

function runArchiveScript(repoDir, ...args) {
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

  return repoDir;
}

function writeCompletedTask(
  repoDir,
  taskId,
  { completedAt, updatedAt = completedAt, type = "feature", title, extraFile = "note.txt" }
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
    assert.ok(fs.existsSync(path.join(secondArchive, "note.txt")), "task files should be moved without compression");
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
      fs.mkdirSync(
        path.join(repoDir, ".agents/workspace/archive/2026/03/15", taskId),
        { recursive: true }
      );
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
