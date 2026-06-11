import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATES_SKILLS = path.resolve(process.cwd(), "templates/.agents/skills");

test("all 4 alloc-class SKILLs invoke task-short-id.js alloc inside execution steps", () => {
  const skills = ["create-task", "import-issue", "import-codescan", "import-dependabot"];
  for (const skill of skills) {
    for (const lang of ["en", "zh-CN"]) {
      const file = path.join(TEMPLATES_SKILLS, skill, `SKILL.${lang}.md`);
      const content = fs.readFileSync(file, "utf8");
      const matches = content.match(/node \.agents\/scripts\/task-short-id\.js alloc/g);
      assert.ok(
        matches && matches.length >= 1,
        `${skill}/${lang}: missing alloc call`
      );
    }
  }
});

test("all 5 release-class SKILLs invoke task-short-id.js release inside execution steps", () => {
  const skills = ["complete-task", "cancel-task", "block-task", "close-codescan", "close-dependabot"];
  for (const skill of skills) {
    for (const lang of ["en", "zh-CN"]) {
      const file = path.join(TEMPLATES_SKILLS, skill, `SKILL.${lang}.md`);
      const content = fs.readFileSync(file, "utf8");
      const matches = content.match(/node \.agents\/scripts\/task-short-id\.js release/g);
      assert.ok(
        matches && matches.length >= 1,
        `${skill}/${lang}: missing release call`
      );
    }
  }
});

test("restore-task re-allocates short id", () => {
  for (const lang of ["en", "zh-CN"]) {
    const file = path.join(TEMPLATES_SKILLS, "restore-task", `SKILL.${lang}.md`);
    const content = fs.readFileSync(file, "utf8");
    const matches = content.match(/node \.agents\/scripts\/task-short-id\.js alloc/g);
    assert.ok(matches && matches.length >= 1, `restore-task/${lang}: missing alloc call`);
  }
});

const SCRIPT = path.resolve(
  process.cwd(),
  "templates/.agents/scripts/task-short-id.js"
);

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tsid-"));
}

function mkTask(activeDir: string, taskId: string, withShortId?: string): string {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const taskMd = path.join(dir, "task.md");
  const short = withShortId ? `\nshort_id: ${withShortId}` : "";
  fs.writeFileSync(
    taskMd,
    `---\nid: ${taskId}${short}\nbranch: x\n---\n# body\n`
  );
  return taskMd;
}

function run(
  args: string[],
  cwd: string = process.cwd()
): SpawnSyncReturns<string> {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", cwd });
}

test("alloc and release reuse minimal free integer", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  mkTask(active, "TASK-20250101-000001");
  mkTask(active, "TASK-20250101-000002");

  const r1 = run(["alloc", "TASK-20250101-000001", "--active-dir", active]);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout.trim(), "#1");

  const r2 = run(["alloc", "TASK-20250101-000002", "--active-dir", active]);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), "#2");

  const r3 = run(["release", "TASK-20250101-000001", "--active-dir", active]);
  assert.equal(r3.status, 0);

  // Reallocating after release should reuse #1.
  const r4 = run(["alloc", "TASK-20250101-000001", "--active-dir", active]);
  assert.equal(r4.status, 0);
  assert.equal(r4.stdout.trim(), "#1");
});

test("release is idempotent (exit 0 when no entry; m-1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  mkTask(active, "TASK-20250101-000003");

  const r = run(["release", "TASK-20250101-000003", "--active-dir", active]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test("resolve returns task id on hit; error on miss", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  mkTask(active, "TASK-20250101-000010");

  run(["alloc", "TASK-20250101-000010", "--active-dir", active]);
  const hit = run(["resolve", "#1", "--active-dir", active]);
  assert.equal(hit.status, 0);
  assert.equal(hit.stdout.trim(), "TASK-20250101-000010");

  const miss = run(["resolve", "#9", "--active-dir", active]);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /not found/);
});

test("resolve rejects #0, leading-zero, malformed input", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });

  const zero = run(["resolve", "#0", "--active-dir", active]);
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /reserved/);

  const leading = run(["resolve", "#01", "--active-dir", active]);
  assert.equal(leading.status, 1);
  assert.match(leading.stderr, /reserved|leading/);

  const bad = run(["resolve", "#abc", "--active-dir", active]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid short id format/);
});

test("width exhaustion (case D): cold start aborts before any write", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const paths: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    paths.push(
      mkTask(active, `TASK-20250102-${String(i).padStart(6, "0")}`)
    );
  }
  const beforeMtimes = paths.map((p) => fs.statSync(p).mtimeMs);
  const beforeContents = paths.map((p) => fs.readFileSync(p, "utf8"));

  // shortIdLength=1 → capacity = 9; need 10 → fail
  const r = run([
    "resolve",
    "#1",
    "--active-dir",
    active,
    "--short-id-length",
    "1"
  ]);
  assert.equal(r.status, 2, `unexpected exit; stderr=${r.stderr}`);
  assert.match(r.stderr, /needs 10 short id\(s\) but only 9/);

  // No fs writes: all task.md mtimes + contents preserved.
  for (let i = 0; i < paths.length; i += 1) {
    assert.equal(fs.statSync(paths[i]!).mtimeMs, beforeMtimes[i]);
    assert.equal(fs.readFileSync(paths[i]!, "utf8"), beforeContents[i]);
  }
  // Registry must not exist.
  assert.equal(fs.existsSync(path.join(active, ".short-ids.json")), false);
});

test("width tight boundary (case D'): 9 tasks fit exactly", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  for (let i = 1; i <= 9; i += 1) {
    mkTask(active, `TASK-20250103-${String(i).padStart(6, "0")}`);
  }
  const r = run([
    "resolve",
    "#1",
    "--active-dir",
    active,
    "--short-id-length",
    "1"
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // Every task.md must now carry a short_id field.
  for (let i = 1; i <= 9; i += 1) {
    const taskId = `TASK-20250103-${String(i).padStart(6, "0")}`;
    const content = fs.readFileSync(path.join(active, taskId, "task.md"), "utf8");
    assert.match(content, /^short_id: #\d+$/m, `task ${taskId} missing short_id`);
  }
  // list --verify must agree.
  const verify = run(["list", "--verify", "--active-dir", active]);
  assert.equal(verify.status, 0, `verify stderr=${verify.stderr}; stdout=${verify.stdout}`);
});

test("list --verify is strictly read-only (R3 B-1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const taskMd = mkTask(active, "TASK-20250104-000001");
  // Active dir has a task with no short_id; registry is empty → inconsistent.
  const beforeMtime = fs.statSync(taskMd).mtimeMs;
  const beforeContent = fs.readFileSync(taskMd, "utf8");

  const r = run(["list", "--verify", "--active-dir", active]);
  assert.equal(r.status, 1, `expected fail; stderr=${r.stderr}`);
  // Must not have written task.md or created the registry.
  assert.equal(fs.statSync(taskMd).mtimeMs, beforeMtime, "task.md mtime mutated");
  assert.equal(fs.readFileSync(taskMd, "utf8"), beforeContent, "task.md content mutated");
  assert.equal(fs.existsSync(path.join(active, ".short-ids.json")), false);
});

test("cold-start case B: registry has entry, task.md missing short_id → writes back", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const taskId = "TASK-20250105-000001";
  mkTask(active, taskId);
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "1": taskId } })
  );

  const r = run(["resolve", "#1", "--active-dir", active]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), taskId);

  const taskMd = fs.readFileSync(path.join(active, taskId, "task.md"), "utf8");
  assert.match(taskMd, /^short_id: #1$/m);
});

test("cold-start case C (duplicate registry keys) → exit 2", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const taskId = "TASK-20250106-000001";
  mkTask(active, taskId);
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "1": taskId, "2": taskId } })
  );

  const r = run(["resolve", "#1", "--active-dir", active]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /duplicate registry entries/);
});

test("stale entries are cleaned automatically (B4)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  // Registry contains a taskId whose dir does not exist.
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "3": "TASK-99999999-999999" } })
  );
  // A real task is created.
  mkTask(active, "TASK-20250107-000001");

  const r = run(["alloc", "TASK-20250107-000001", "--active-dir", active]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // Stale #3 cleaned, new task gets #1 (lowest free).
  assert.equal(r.stdout.trim(), "#1");

  const list = JSON.parse(
    fs.readFileSync(path.join(active, ".short-ids.json"), "utf8")
  );
  assert.deepEqual(list.ids, { "1": "TASK-20250107-000001" });
});

test("alloc rejects task id not in active (R5 B-1) without touching state", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  // Pre-existing tasks without short_id (would trigger cold-start migration).
  mkTask(active, "TASK-20250108-000001");
  mkTask(active, "TASK-20250108-000002");

  const r = run(["alloc", "TASK-99999999-000000", "--active-dir", active]);
  assert.equal(r.status, 1, `stderr=${r.stderr}`);
  assert.match(r.stderr, /not found in/);

  // The two existing tasks must remain untouched.
  for (const id of ["TASK-20250108-000001", "TASK-20250108-000002"]) {
    const md = fs.readFileSync(path.join(active, id, "task.md"), "utf8");
    assert.doesNotMatch(md, /short_id:/, `${id} mutated`);
  }
  assert.equal(fs.existsSync(path.join(active, ".short-ids.json")), false);
});

test("alloc skips re-write when task.md already declares the same short_id", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const taskId = "TASK-20250109-000001";
  mkTask(active, taskId, "#1");
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "1": taskId } })
  );
  const taskMd = path.join(active, taskId, "task.md");
  const beforeMtime = fs.statSync(taskMd).mtimeMs;

  const r = run(["alloc", taskId, "--active-dir", active]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "#1");
  // mtime unchanged because nothing to write.
  assert.equal(fs.statSync(taskMd).mtimeMs, beforeMtime);
});
