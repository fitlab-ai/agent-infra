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

function mkTask(activeDir: string, taskId: string): string {
  const dir = path.join(activeDir, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const taskMd = path.join(dir, "task.md");
  fs.writeFileSync(
    taskMd,
    `---\nid: ${taskId}\nbranch: x\n---\n# body\n`
  );
  return taskMd;
}

function run(
  args: string[],
  cwd: string = process.cwd()
): SpawnSyncReturns<string> {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", cwd });
}

// Tests that use the single-digit semantics (#1, #2, …) explicitly request
// shortIdLength=1 to remain independent of the project default (now 2).
function runW1(args: string[]): SpawnSyncReturns<string> {
  return run([...args, "--short-id-length", "1"]);
}

// Tests that exercise the zero-padded default (#01, #02, …) explicitly pin
// shortIdLength=2 to be robust against future default changes.
function runW2(args: string[]): SpawnSyncReturns<string> {
  return run([...args, "--short-id-length", "2"]);
}

test("alloc and release reuse minimal free integer (shortIdLength=1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  mkTask(active, "TASK-20250101-000001");
  mkTask(active, "TASK-20250101-000002");

  const r1 = runW1(["alloc", "TASK-20250101-000001", "--active-dir", active]);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout.trim(), "#1");

  const r2 = runW1(["alloc", "TASK-20250101-000002", "--active-dir", active]);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), "#2");

  const r3 = runW1(["release", "TASK-20250101-000001", "--active-dir", active]);
  assert.equal(r3.status, 0);

  // Reallocating after release should reuse #1.
  const r4 = runW1(["alloc", "TASK-20250101-000001", "--active-dir", active]);
  assert.equal(r4.status, 0);
  assert.equal(r4.stdout.trim(), "#1");
});

test("alloc and release with default shortIdLength=2 emit zero-padded short ids", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const md1Path = mkTask(active, "TASK-20260101-000001");
  mkTask(active, "TASK-20260101-000002");
  const md1Before = fs.readFileSync(md1Path, "utf8");

  const r1 = runW2(["alloc", "TASK-20260101-000001", "--active-dir", active]);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout.trim(), "#01");

  const r2 = runW2(["alloc", "TASK-20260101-000002", "--active-dir", active]);
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout.trim(), "#02");

  // The registry is the sole store of short ids; task.md never carries one.
  const registry = JSON.parse(fs.readFileSync(path.join(active, ".short-ids.json"), "utf8"));
  assert.deepEqual(registry.ids, {
    "01": "TASK-20260101-000001",
    "02": "TASK-20260101-000002"
  });
  // alloc must not touch task.md at all (AC-1): content is byte-identical.
  assert.equal(fs.readFileSync(md1Path, "utf8"), md1Before);

  // resolve accepts both zero-padded and non-padded forms (numeric-value contract).
  const hit = runW2(["resolve", "#01", "--active-dir", active]);
  assert.equal(hit.status, 0);
  assert.equal(hit.stdout.trim(), "TASK-20260101-000001");

  const unpaddedHit = runW2(["resolve", "#1", "--active-dir", active]);
  assert.equal(unpaddedHit.status, 0, `stderr=${unpaddedHit.stderr}`);
  assert.equal(unpaddedHit.stdout.trim(), "TASK-20260101-000001");

  const bareHit = runW2(["resolve", "1", "--active-dir", active]);
  assert.equal(bareHit.status, 0, `stderr=${bareHit.stderr}`);
  assert.equal(bareHit.stdout.trim(), "TASK-20260101-000001");
});

test("release is idempotent (exit 0 when no entry; m-1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  mkTask(active, "TASK-20250101-000003");

  const r = runW1(["release", "TASK-20250101-000003", "--active-dir", active]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test("resolve returns task id on hit; error on miss (shortIdLength=1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  mkTask(active, "TASK-20250101-000010");

  runW1(["alloc", "TASK-20250101-000010", "--active-dir", active]);
  const hit = runW1(["resolve", "#1", "--active-dir", active]);
  assert.equal(hit.status, 0);
  assert.equal(hit.stdout.trim(), "TASK-20250101-000010");

  const miss = runW1(["resolve", "#9", "--active-dir", active]);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /not found/);
});

test("resolve rejects reserved key, over capacity, malformed input", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });

  // shortIdLength=1: #0 and bare 0 are reserved; #abc malformed.
  const zero1 = runW1(["resolve", "#0", "--active-dir", active]);
  assert.equal(zero1.status, 1);
  assert.match(zero1.stderr, /reserved/);

  const bareZero1 = runW1(["resolve", "0", "--active-dir", active]);
  assert.equal(bareZero1.status, 1);
  assert.match(bareZero1.stderr, /reserved/);

  // #10 exceeds shortIdLength=1 capacity (max=9).
  const overW1 = runW1(["resolve", "#10", "--active-dir", active]);
  assert.equal(overW1.status, 1);
  assert.match(overW1.stderr, /exceeds shortIdLength=1 capacity/);

  const bad = runW1(["resolve", "#abc", "--active-dir", active]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid short id format/);

  // shortIdLength=2: #00 and bare 00 reserved.
  const zero2 = runW2(["resolve", "#00", "--active-dir", active]);
  assert.equal(zero2.status, 1);
  assert.match(zero2.stderr, /reserved/);

  // #100 exceeds shortIdLength=2 capacity (max=99).
  const overW2 = runW2(["resolve", "#100", "--active-dir", active]);
  assert.equal(overW2.status, 1);
  assert.match(overW2.stderr, /exceeds shortIdLength=2 capacity/);

  // #001 in L=2 is now valid (numeric value=1, ≤ max=99) — registry just won't have it.
  // Confirm format pass-through doesn't itself error.
  const okFormat = runW2(["resolve", "#001", "--active-dir", active]);
  // Registry empty here → exit 1 with "not found", NOT "invalid format".
  assert.equal(okFormat.status, 1);
  assert.doesNotMatch(okFormat.stderr, /invalid short id format/);
});

test("explicit alloc rejects when width is exhausted (shortIdLength=1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  // Fill all 9 slots (#1..#9) via explicit alloc.
  for (let i = 1; i <= 9; i += 1) {
    const taskId = `TASK-20250103-${String(i).padStart(6, "0")}`;
    mkTask(active, taskId);
    const r = runW1(["alloc", taskId, "--active-dir", active]);
    assert.equal(r.status, 0, `alloc ${i} failed: ${r.stderr}`);
  }
  // A 10th explicit alloc must fail on capacity, not silently extend.
  const overflowId = "TASK-20250103-000010";
  mkTask(active, overflowId);
  const r = runW1(["alloc", overflowId, "--active-dir", active]);
  assert.equal(r.status, 2, `expected capacity failure; stderr=${r.stderr}`);
  assert.match(r.stderr, /width exhausted/);
  // The registry still holds exactly the 9 originally allocated entries.
  const registry = JSON.parse(fs.readFileSync(path.join(active, ".short-ids.json"), "utf8"));
  assert.equal(Object.keys(registry.ids).length, 9);
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

test("list --verify exits 0 with empty stdout when active dir and registry agree", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  // task.md carries NO short_id — the registry alone is authoritative.
  const taskId = "TASK-20250110-000001";
  mkTask(active, taskId);
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "1": taskId } })
  );

  const r = run(["list", "--verify", "--active-dir", active, "--short-id-length", "1"]);
  assert.equal(r.status, 0, `expected pass; stderr=${r.stderr}; stdout=${r.stdout}`);
  assert.equal(r.stdout, "", "consistent verify must emit empty stdout");
});

test("list --verify reports missing_in_registry and orphans_in_registry diffs", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  // One active task absent from the registry → missing_in_registry.
  const present = "TASK-20250111-000001";
  mkTask(active, present);
  // One registry entry whose task dir does not exist → orphans_in_registry.
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "2": "TASK-99999999-999999" } })
  );

  const r = run(["list", "--verify", "--active-dir", active, "--short-id-length", "1"]);
  assert.equal(r.status, 1, `expected fail; stderr=${r.stderr}`);
  // Pin the full diff shape: registry-only dimensions, no task.md dimension.
  assert.deepEqual(JSON.parse(r.stdout), {
    missing_in_registry: [{ taskId: present }],
    orphans_in_registry: [{ key: "#2", taskId: "TASK-99999999-999999" }],
    duplicate_registry_keys: []
  });
});

test("resolve returns the task id for a registry hit without touching task.md", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const taskId = "TASK-20250105-000001";
  const taskMd = mkTask(active, taskId);
  fs.writeFileSync(
    path.join(active, ".short-ids.json"),
    JSON.stringify({ version: 1, ids: { "1": taskId } })
  );
  const before = fs.readFileSync(taskMd, "utf8");

  const r = runW1(["resolve", "#1", "--active-dir", active]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), taskId);
  // resolve never writes the short id back into task.md (registry is the source).
  assert.equal(fs.readFileSync(taskMd, "utf8"), before);
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

  const r = runW1(["resolve", "#1", "--active-dir", active]);
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

  const r = runW1(["alloc", "TASK-20250107-000001", "--active-dir", active]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // Stale #3 cleaned, new task gets #1 (lowest free).
  assert.equal(r.stdout.trim(), "#1");

  const list = JSON.parse(
    fs.readFileSync(path.join(active, ".short-ids.json"), "utf8")
  );
  assert.deepEqual(list.ids, { "1": "TASK-20250107-000001" });
});

test("alloc rejects a task id not in active without touching state (R5 B-1)", () => {
  const tmp = mkTmp();
  const active = path.join(tmp, "active");
  fs.mkdirSync(active, { recursive: true });
  const md1 = mkTask(active, "TASK-20250108-000001");
  const md2 = mkTask(active, "TASK-20250108-000002");
  const before1 = fs.readFileSync(md1, "utf8");
  const before2 = fs.readFileSync(md2, "utf8");

  const r = runW1(["alloc", "TASK-99999999-000000", "--active-dir", active]);
  assert.equal(r.status, 1, `stderr=${r.stderr}`);
  assert.match(r.stderr, /not found in/);

  // No state mutated: existing task.md files unchanged, registry not created.
  assert.equal(fs.readFileSync(md1, "utf8"), before1);
  assert.equal(fs.readFileSync(md2, "utf8"), before2);
  assert.equal(fs.existsSync(path.join(active, ".short-ids.json")), false);
});

// --- U-2 structural assertions: SKILL.md inline bash is gone ---

test("default width is 2 even without --short-id-length flag and without task.shortIdLength in .airc.json (R4 B-1)", () => {
  // Simulate a project that upgraded but hasn't backfilled task.shortIdLength
  // into .agents/.airc.json yet. The script must still allocate / resolve with
  // the default 2-digit zero-padded form (matching lib/defaults.json).
  const tmp = mkTmp();
  const agentsDir = path.join(tmp, ".agents");
  const active = path.join(agentsDir, "workspace", "active");
  fs.mkdirSync(active, { recursive: true });
  // Stub .airc.json without a `task` key.
  fs.writeFileSync(path.join(agentsDir, ".airc.json"), JSON.stringify({ project: "x" }));
  const taskId = "TASK-20260601-000001";
  fs.mkdirSync(path.join(active, taskId), { recursive: true });
  fs.writeFileSync(
    path.join(active, taskId, "task.md"),
    `---\nid: ${taskId}\nbranch: x\n---\nbody\n`
  );

  // No --short-id-length: script must fall back to DEFAULT_SHORT_ID_LENGTH=2.
  const alloc = spawnSync("node", [SCRIPT, "alloc", taskId], { encoding: "utf8", cwd: tmp });
  assert.equal(alloc.status, 0, `alloc failed: ${alloc.stderr}`);
  assert.equal(alloc.stdout.trim(), "#01", "default must emit zero-padded form");

  const hit = spawnSync("node", [SCRIPT, "resolve", "#01"], { encoding: "utf8", cwd: tmp });
  assert.equal(hit.status, 0);
  assert.equal(hit.stdout.trim(), taskId);

  // Bare numeric and non-padded #N also resolve to the same task under L=2.
  const bareHit = spawnSync("node", [SCRIPT, "resolve", "1"], { encoding: "utf8", cwd: tmp });
  assert.equal(bareHit.status, 0, `stderr=${bareHit.stderr}`);
  assert.equal(bareHit.stdout.trim(), taskId);

  const unpaddedHit = spawnSync("node", [SCRIPT, "resolve", "#1"], { encoding: "utf8", cwd: tmp });
  assert.equal(unpaddedHit.status, 0, `stderr=${unpaddedHit.stderr}`);
  assert.equal(unpaddedHit.stdout.trim(), taskId);

  // Over-capacity is still rejected at the script level.
  const overWidth = spawnSync("node", [SCRIPT, "resolve", "#100"], { encoding: "utf8", cwd: tmp });
  assert.equal(overWidth.status, 1, `stderr=${overWidth.stderr}`);
  assert.match(overWidth.stderr, /exceeds shortIdLength=2 capacity/);
});

test("SKILL.md no longer embeds multi-line short-id bash snippet (U-2 slimming)", () => {
  const skills = fs.readdirSync(TEMPLATES_SKILLS);
  // Match the 5-line conditional block that used to live in every SKILL.md
  // (`if [[ "{task-id}" == "#"* ]]; then` followed by a `node …` call).
  const oldSnippet = /if \[\[ "\{task-id\}" == "#"\*[\s\S]+task-short-id\.js resolve/m;
  let offenders: string[] = [];
  for (const skill of skills) {
    for (const lang of ["en", "zh-CN"]) {
      const file = path.join(TEMPLATES_SKILLS, skill, `SKILL.${lang}.md`);
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (oldSnippet.test(content)) offenders.push(`${skill}/${lang}`);
    }
  }
  assert.deepEqual(offenders, [], `SKILL.md still embeds old inline bash: ${offenders.join(", ")}`);
});

test("19 lifecycle SKILLs reference the centralized task-short-id rule doc (U-2)", () => {
  const skills = [
    "create-task", "import-issue", "import-codescan", "import-dependabot",
    "analyze-task", "plan-task", "code-task", "review-analysis", "review-plan",
    "review-code", "commit", "create-pr", "check-task",
    "complete-task", "cancel-task", "block-task", "close-codescan", "close-dependabot",
    "restore-task"
  ];
  const pointerRe = /rules\/task-short-id\.md/;
  for (const skill of skills) {
    for (const lang of ["en", "zh-CN"]) {
      const file = path.join(TEMPLATES_SKILLS, skill, `SKILL.${lang}.md`);
      const content = fs.readFileSync(file, "utf8");
      assert.match(content, pointerRe, `${skill}/${lang} missing rule pointer`);
    }
  }
});

// --- U-3 structural assertions: rule doc declares storage + SKILL parser ---

test("task-short-id rule doc declares SKILL parser + storage sections (U-2/U-3)", () => {
  const docs = {
    "en": path.resolve(process.cwd(), "templates/.agents/rules/task-short-id.en.md"),
    "zh-CN": path.resolve(process.cwd(), "templates/.agents/rules/task-short-id.zh-CN.md")
  };
  const skillSection = { en: /^## SKILL parameter resolver$/m, "zh-CN": /^## SKILL 入参解析$/m };
  const storageSection = { en: /^## Storage$/m, "zh-CN": /^## 存储位置$/m };
  for (const [lang, file] of Object.entries(docs)) {
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, skillSection[lang as keyof typeof skillSection], `${lang}: SKILL section missing`);
    assert.match(content, storageSection[lang as keyof typeof storageSection], `${lang}: storage section missing`);
  }
});
