import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const SHORT_ID_RE = /^#\d+$/;
const REGISTRY_NAME = ".short-ids.json";
const LOCK_NAME = ".short-ids.json.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

function usage() {
  return [
    "Usage: task-short-id.js <subcommand> [args]",
    "",
    "Subcommands:",
    "  alloc <task-id>      Allocate short id for a task; writes registry + short_id to task.md",
    "  release <task-id>    Release short id (idempotent; exit 0 if not present)",
    "  resolve <#N>         Resolve short id to full task id",
    "  list                 Print registry JSON",
    "  list --verify        Read-only check; exit 1 if active dir / registry / task.md disagree",
    "",
    "Options:",
    "  --active-dir <path>  Override active dir (default: <repo>/.agents/workspace/active)",
    "  --short-id-length N  Override configured width (default: from .airc.json or 1)"
  ].join("\n");
}

function parseArgs(argv) {
  const args = { positional: [], activeDir: null, shortIdLength: null, verify: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--active-dir") {
      args.activeDir = argv[++i];
    } else if (a === "--short-id-length") {
      args.shortIdLength = Number(argv[++i]);
    } else if (a === "--verify") {
      args.verify = true;
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function findRepoRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".agents", ".airc.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readShortIdLength(repoRoot, override) {
  if (typeof override === "number" && Number.isFinite(override) && override >= 1) {
    return override;
  }
  if (!repoRoot) return 1;
  try {
    const cfgPath = path.join(repoRoot, ".agents", ".airc.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const v = cfg && cfg.task && cfg.task.shortIdLength;
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) return v;
  } catch {
    // ignore
  }
  return 1;
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return { version: 1, ids: {} };
  }
  let raw;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (e) {
    process.stderr.write(`Error: cannot read registry ${registryPath}: ${e.message}\n`);
    process.exit(2);
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.ids || typeof data.ids !== "object") {
      process.stderr.write(`Error: registry ${registryPath} has invalid schema\n`);
      process.exit(2);
    }
    if (data.version !== 1) data.version = 1;
    return data;
  } catch (e) {
    process.stderr.write(`Error: registry ${registryPath} is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }
}

function writeRegistryAtomic(data, registryPath) {
  const tmpPath = `${registryPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmpPath, registryPath);
}

function withRegistryLock(activeDir, fn, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  fs.mkdirSync(activeDir, { recursive: true });
  const lockDir = path.join(activeDir, LOCK_NAME);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        process.stderr.write(`Error: registry lock timeout after ${timeoutMs}ms\n`);
        process.exit(3);
      }
      const elapsed = Date.now() - start;
      const wait = Math.min(500, 50 * Math.pow(2, Math.floor(elapsed / 200)));
      const deadline = Date.now() + wait;
      while (Date.now() < deadline) {
        /* busy wait, ms-scale */
      }
    }
  }
  // Register cleanup that runs even on process.exit (which skips try/finally).
  const cleanup = () => {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* lock-dir already removed */
    }
  };
  process.once("exit", cleanup);
  try {
    return fn();
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
}

function writeTaskMdShortId(taskMdPath, shortId) {
  const content = fs.readFileSync(taskMdPath, "utf8");
  let updated;
  if (/^short_id:.*$/m.test(content)) {
    updated = content.replace(/^short_id:.*$/m, `short_id: ${shortId}`);
  } else {
    updated = content.replace(/^(id:.*)$/m, `$1\nshort_id: ${shortId}`);
  }
  fs.writeFileSync(taskMdPath, updated);
}

function allocateMinFreeInt(registry, maxN) {
  for (let n = 1; n <= maxN; n += 1) {
    if (!registry.ids[String(n)]) return n;
  }
  return null;
}

function planTransaction(registry, activeDir, shortIdLength) {
  const maxN = Math.pow(10, shortIdLength) - 1;

  // A1: active task id set
  const activeTaskIds = new Set(
    fs
      .readdirSync(activeDir)
      .filter((d) => TASK_ID_RE.test(d))
      .filter((d) => fs.existsSync(path.join(activeDir, d, "task.md")))
  );

  // A2: stale entries
  const pendingRegistryDeletes = [];
  for (const [key, taskId] of Object.entries(registry.ids)) {
    if (!activeTaskIds.has(taskId)) pendingRegistryDeletes.push(key);
  }

  const projectedIds = { ...registry.ids };
  for (const key of pendingRegistryDeletes) delete projectedIds[key];

  // A3: duplicate key detection (after stale cleanup)
  const taskIdToKey = new Map();
  for (const [key, taskId] of Object.entries(projectedIds)) {
    if (taskIdToKey.has(taskId)) {
      const existingKey = taskIdToKey.get(taskId);
      process.stderr.write(
        `Error: duplicate registry entries for taskId ${taskId} at keys [#${existingKey}, #${key}]; manual resolution required\n`
      );
      process.exit(2);
    }
    taskIdToKey.set(taskId, key);
  }

  // A4: classify each active task
  const plannedRegistryWrites = [];
  const plannedTaskMdWrites = [];
  const pendingAlloc = [];

  for (const taskId of activeTaskIds) {
    const taskMdPath = path.join(activeDir, taskId, "task.md");
    const originalStat = fs.statSync(taskMdPath);
    const originalContent = fs.readFileSync(taskMdPath, "utf8");
    const existing = originalContent.match(/^short_id:\s*(#\d+)\s*$/m);

    if (existing) {
      const declared = existing[1];
      const n = declared.slice(1);
      if (projectedIds[n] === taskId) continue; // 4a
      if (taskIdToKey.has(taskId)) {
        const registryKey = taskIdToKey.get(taskId);
        process.stderr.write(
          `Inconsistent: task ${taskId} declares ${declared} but registry holds it at #${registryKey}\n`
        );
        process.exit(2);
      }
      if (projectedIds[n] && projectedIds[n] !== taskId) {
        process.stderr.write(
          `Inconsistent: task ${taskId} declares ${declared} but registry maps ${declared} to ${projectedIds[n]}\n`
        );
        process.exit(2);
      }
      // 4d
      plannedRegistryWrites.push({ key: n, taskId });
      projectedIds[n] = taskId;
      taskIdToKey.set(taskId, n);
      continue;
    }

    if (taskIdToKey.has(taskId)) {
      // 4e
      const registryKey = taskIdToKey.get(taskId);
      plannedTaskMdWrites.push({
        taskMdPath,
        originalContent,
        originalAtime: originalStat.atime,
        originalMtime: originalStat.mtime,
        shortId: `#${registryKey}`,
        kind: "4e"
      });
      continue;
    }

    // 4f: deferred
    pendingAlloc.push({
      taskId,
      taskMdPath,
      originalContent,
      originalAtime: originalStat.atime,
      originalMtime: originalStat.mtime
    });
  }

  // A5: capacity pre-check
  const availableSlots = maxN - Object.keys(projectedIds).length;
  if (pendingAlloc.length > availableSlots) {
    process.stderr.write(
      `Error: cold-start migration needs ${pendingAlloc.length} short id(s) but only ${availableSlots} ` +
        `slot(s) available (capacity=${maxN}, in-use after stale-cleanup=${Object.keys(projectedIds).length}). ` +
        `Archive some active tasks (complete-task / cancel-task / block-task) ` +
        `or raise task.shortIdLength in .agents/.airc.json.\n`
    );
    process.exit(2);
  }

  pendingAlloc.sort((a, b) => a.taskId.localeCompare(b.taskId));

  for (const item of pendingAlloc) {
    const shortId = allocateMinFreeInt({ ids: projectedIds }, maxN);
    if (shortId === null) {
      throw new Error("Internal invariant: pendingAlloc capacity check failed");
    }
    projectedIds[String(shortId)] = item.taskId;
    taskIdToKey.set(item.taskId, String(shortId));
    plannedRegistryWrites.push({ key: String(shortId), taskId: item.taskId });
    plannedTaskMdWrites.push({
      taskMdPath: item.taskMdPath,
      originalContent: item.originalContent,
      originalAtime: item.originalAtime,
      originalMtime: item.originalMtime,
      shortId: `#${shortId}`,
      kind: "4f"
    });
  }

  // Build transaction object
  const tx = {
    _registry: registry,
    _activeDir: activeDir,
    _registrySnapshot: { ...registry.ids },
    _pendingRegistryDeletes: pendingRegistryDeletes,
    _plannedRegistryWrites: plannedRegistryWrites,
    _plannedTaskMdWrites: plannedTaskMdWrites,
    _projectedIds: projectedIds,
    _taskIdToKey: taskIdToKey,
    _shortIdLength: shortIdLength,
    _maxN: maxN,

    planAlloc(taskId) {
      const taskMdPath = path.join(activeDir, taskId, "task.md");
      if (!fs.existsSync(taskMdPath)) {
        throw new Error(`planAlloc: task.md not found for ${taskId}`);
      }
      if (this._taskIdToKey.has(taskId)) {
        return this._taskIdToKey.get(taskId);
      }
      const inUse = Object.keys(this._projectedIds).length;
      if (inUse >= this._maxN) {
        throw new Error(
          `Error: short id width exhausted (current shortIdLength=${this._shortIdLength}, ` +
            `${inUse}/${this._maxN} slots in use). Archive some active tasks or raise task.shortIdLength.`
        );
      }
      const shortId = allocateMinFreeInt({ ids: this._projectedIds }, this._maxN);
      this._projectedIds[String(shortId)] = taskId;
      this._taskIdToKey.set(taskId, String(shortId));
      this._plannedRegistryWrites.push({ key: String(shortId), taskId });
      const originalStat = fs.statSync(taskMdPath);
      const originalContent = fs.readFileSync(taskMdPath, "utf8");
      // If task.md already declares the same short id (e.g. R-alloc replay), skip writing.
      const existing = originalContent.match(/^short_id:\s*(#\d+)\s*$/m);
      if (!existing || existing[1] !== `#${shortId}`) {
        this._plannedTaskMdWrites.push({
          taskMdPath,
          originalContent,
          originalAtime: originalStat.atime,
          originalMtime: originalStat.mtime,
          shortId: `#${shortId}`,
          kind: "caller-alloc"
        });
      }
      return String(shortId);
    },

    planRelease(taskId) {
      const key = this._taskIdToKey.get(taskId);
      if (!key) return; // idempotent
      this._plannedRegistryWrites = this._plannedRegistryWrites.filter(
        (w) => w.taskId !== taskId
      );
      this._plannedTaskMdWrites = this._plannedTaskMdWrites.filter(
        (w) => path.basename(path.dirname(w.taskMdPath)) !== taskId
      );
      this._pendingRegistryDeletes.push(key);
      delete this._projectedIds[key];
      this._taskIdToKey.delete(taskId);
    },

    commit(registryPath) {
      // B1: apply registry mutation in memory
      for (const key of this._pendingRegistryDeletes) delete this._registry.ids[key];
      for (const { key, taskId } of this._plannedRegistryWrites) {
        this._registry.ids[key] = taskId;
      }

      const completedWrites = [];
      const rollback = (reason) => {
        for (const done of completedWrites.reverse()) {
          try {
            fs.writeFileSync(done.taskMdPath, done.originalContent);
            fs.utimesSync(done.taskMdPath, done.originalAtime, done.originalMtime);
          } catch {
            /* best-effort */
          }
        }
        this._registry.ids = this._registrySnapshot;
        const tail =
          completedWrites.length > 0
            ? `; rolled back ${completedWrites.length} prior task.md write(s)`
            : "";
        throw new Error(`${reason}${tail}`);
      };

      // B2: write task.md per plan
      for (const write of this._plannedTaskMdWrites) {
        try {
          writeTaskMdShortId(write.taskMdPath, write.shortId);
          completedWrites.push(write);
        } catch (e) {
          rollback(`Failed to write short_id to ${write.taskMdPath}: ${e.message}`);
        }
      }

      // B3: atomic registry persistence
      try {
        writeRegistryAtomic(this._registry, registryPath);
      } catch (e) {
        rollback(`Failed to persist registry to ${registryPath}: ${e.message}`);
      }
    }
  };

  return tx;
}

function verifyRegistry(registry, activeDir) {
  const activeTaskIds = new Set(
    fs
      .readdirSync(activeDir)
      .filter((d) => TASK_ID_RE.test(d))
      .filter((d) => fs.existsSync(path.join(activeDir, d, "task.md")))
  );
  const registryTaskIds = new Set(Object.values(registry.ids));
  const taskmdShortIds = new Map();
  for (const taskId of activeTaskIds) {
    const taskMdPath = path.join(activeDir, taskId, "task.md");
    const content = fs.readFileSync(taskMdPath, "utf8");
    const m = content.match(/^short_id:\s*(#\d+)\s*$/m);
    taskmdShortIds.set(taskId, m ? m[1] : null);
  }
  const missing_in_registry = [];
  for (const taskId of activeTaskIds) {
    if (!registryTaskIds.has(taskId)) {
      missing_in_registry.push({ taskId, declared: taskmdShortIds.get(taskId) });
    }
  }
  const missing_in_taskmd = [];
  for (const [key, taskId] of Object.entries(registry.ids)) {
    if (!activeTaskIds.has(taskId)) continue;
    const declared = taskmdShortIds.get(taskId);
    if (declared === null) {
      missing_in_taskmd.push({ taskId, expected: `#${key}` });
    } else if (declared !== `#${key}`) {
      missing_in_taskmd.push({ taskId, expected: `#${key}`, declared });
    }
  }
  const orphans_in_registry = [];
  for (const [key, taskId] of Object.entries(registry.ids)) {
    if (!activeTaskIds.has(taskId)) {
      orphans_in_registry.push({ key: `#${key}`, taskId });
    }
  }
  const taskIdToKeys = new Map();
  for (const [key, taskId] of Object.entries(registry.ids)) {
    if (!taskIdToKeys.has(taskId)) taskIdToKeys.set(taskId, []);
    taskIdToKeys.get(taskId).push(key);
  }
  const duplicate_registry_keys = [];
  for (const [taskId, keys] of taskIdToKeys) {
    if (keys.length > 1) {
      duplicate_registry_keys.push({ taskId, keys: keys.map((k) => `#${k}`) });
    }
  }
  return {
    missing_in_registry,
    missing_in_taskmd,
    orphans_in_registry,
    duplicate_registry_keys
  };
}

function cmdAlloc(taskId, activeDir, registryPath, shortIdLength) {
  if (!TASK_ID_RE.test(taskId)) {
    process.stderr.write(`Error: invalid task id format '${taskId}'\n`);
    process.exit(1);
  }
  return withRegistryLock(activeDir, () => {
    const taskMdPath = path.join(activeDir, taskId, "task.md");
    if (!fs.existsSync(taskMdPath)) {
      process.stderr.write(`Error: task ${taskId} not found in ${activeDir} (no task.md)\n`);
      process.exit(1);
    }
    const registry = readRegistry(registryPath);
    const tx = planTransaction(registry, activeDir, shortIdLength);
    let shortId;
    try {
      shortId = tx.planAlloc(taskId);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    try {
      tx.commit(registryPath);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`#${shortId}\n`);
  });
}

function cmdRelease(taskId, activeDir, registryPath, shortIdLength) {
  if (!TASK_ID_RE.test(taskId)) {
    process.stderr.write(`Error: invalid task id format '${taskId}'\n`);
    process.exit(1);
  }
  return withRegistryLock(activeDir, () => {
    const registry = readRegistry(registryPath);
    const tx = planTransaction(registry, activeDir, shortIdLength);
    tx.planRelease(taskId);
    try {
      tx.commit(registryPath);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    // idempotent exit 0
  });
}

function cmdResolve(shortIdArg, activeDir, registryPath, shortIdLength) {
  if (!SHORT_ID_RE.test(shortIdArg)) {
    process.stderr.write(
      `Error: invalid short id format '${shortIdArg}'. Use quoted '#N' (e.g. '#1').\n`
    );
    process.exit(1);
  }
  const n = shortIdArg.slice(1);
  if (n === "0" || (n.length > 1 && n.startsWith("0"))) {
    process.stderr.write(
      `Error: short id '${shortIdArg}' is invalid (#0 is reserved, leading zeros not allowed).\n`
    );
    process.exit(1);
  }
  return withRegistryLock(activeDir, () => {
    const registry = readRegistry(registryPath);
    const tx = planTransaction(registry, activeDir, shortIdLength);
    const taskId = tx._projectedIds[n];
    if (!taskId) {
      const hasPendingMutations =
        tx._plannedRegistryWrites.length > 0 ||
        tx._pendingRegistryDeletes.length > 0 ||
        tx._plannedTaskMdWrites.length > 0;
      if (hasPendingMutations) {
        try {
          tx.commit(registryPath);
        } catch (e) {
          process.stderr.write(`${e.message}\n`);
          process.exit(1);
        }
      }
      if (Object.keys(tx._projectedIds).length === 0) {
        process.stderr.write(
          `Error: short id '${shortIdArg}' not found; active task registry is empty.\n`
        );
      } else {
        process.stderr.write(
          `Error: short id '${shortIdArg}' not found in active task registry ` +
            `(it may have been cleaned up after archival; check 'task-short-id.js list').\n`
        );
      }
      process.exit(1);
    }
    try {
      tx.commit(registryPath);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(`${taskId}\n`);
  });
}

function cmdList(activeDir, registryPath, verify) {
  if (!verify) {
    const registry = readRegistry(registryPath);
    process.stdout.write(`${JSON.stringify(registry, null, 2)}\n`);
    return;
  }
  const registry = readRegistry(registryPath);
  if (!fs.existsSync(activeDir)) {
    process.stdout.write("");
    return;
  }
  const diff = verifyRegistry(registry, activeDir);
  const hasIssues =
    diff.missing_in_registry.length > 0 ||
    diff.missing_in_taskmd.length > 0 ||
    diff.orphans_in_registry.length > 0 ||
    diff.duplicate_registry_keys.length > 0;
  if (hasIssues) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
    process.exit(1);
  }
  // consistent: empty stdout, exit 0
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n${usage()}\n`);
    process.exit(1);
  }
  if (args.help || args.positional.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const subcommand = args.positional[0];
  const repoRoot = findRepoRoot(process.cwd());
  const activeDir = args.activeDir
    ? path.resolve(args.activeDir)
    : repoRoot
    ? path.join(repoRoot, ".agents", "workspace", "active")
    : null;
  if (!activeDir) {
    process.stderr.write(
      `Error: cannot locate active dir (no .agents/.airc.json found above ${process.cwd()})\n`
    );
    process.exit(2);
  }
  const shortIdLength = readShortIdLength(repoRoot, args.shortIdLength);
  const registryPath = path.join(activeDir, REGISTRY_NAME);

  switch (subcommand) {
    case "alloc":
      if (!args.positional[1]) {
        process.stderr.write(`Usage: alloc <task-id>\n`);
        process.exit(1);
      }
      return cmdAlloc(args.positional[1], activeDir, registryPath, shortIdLength);
    case "release":
      if (!args.positional[1]) {
        process.stderr.write(`Usage: release <task-id>\n`);
        process.exit(1);
      }
      return cmdRelease(args.positional[1], activeDir, registryPath, shortIdLength);
    case "resolve":
      if (!args.positional[1]) {
        process.stderr.write(`Usage: resolve <#N>\n`);
        process.exit(1);
      }
      return cmdResolve(args.positional[1], activeDir, registryPath, shortIdLength);
    case "list":
      return cmdList(activeDir, registryPath, args.verify);
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n${usage()}\n`);
      process.exit(1);
  }
}

const isCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  main(process.argv.slice(2));
}

export {
  TASK_ID_RE,
  SHORT_ID_RE,
  REGISTRY_NAME,
  parseArgs,
  findRepoRoot,
  readShortIdLength,
  readRegistry,
  writeRegistryAtomic,
  withRegistryLock,
  writeTaskMdShortId,
  allocateMinFreeInt,
  planTransaction,
  verifyRegistry,
  cmdAlloc,
  cmdRelease,
  cmdResolve,
  cmdList,
  main
};
