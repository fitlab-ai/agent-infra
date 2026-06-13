import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const SHORT_ID_RE = /^#\d+$/;
const REGISTRY_NAME = ".short-ids.json";
const LOCK_NAME = ".short-ids.json.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
// Kept in sync with lib/defaults.json's task.shortIdLength. Used when there is
// no `--short-id-length` flag and no readable `task.shortIdLength` in
// .agents/.airc.json (e.g. the project upgraded but hasn't re-run
// ai update-agent-infra to backfill the field).
const DEFAULT_SHORT_ID_LENGTH = 2;

// process.stdout.write / process.stderr.write are non-blocking when the
// destination is a pipe (e.g. when spawned via child_process.spawnSync). On
// some platforms (notably macOS) the Node process can exit before the buffer
// flushes, leaving the parent with empty stdout. Use fs.writeSync to guarantee
// synchronous, fully-flushed writes — this is critical because the parent
// CLI/test code relies on stdout to carry the resolved task id / short id.
function writeStdout(text) {
  fs.writeSync(1, text);
}

function writeStderr(text) {
  fs.writeSync(2, text);
}

function usage() {
  return [
    "Usage: task-short-id.js <subcommand> [args]",
    "",
    "Subcommands:",
    "  alloc <task-id>      Allocate short id for a task in the registry",
    "  release <task-id>    Release short id (idempotent; exit 0 if not present)",
    "  resolve <#N>         Resolve short id to full task id",
    "  list                 Print registry JSON",
    "  list --verify        Read-only check; exit 1 if active dir / registry disagree",
    "",
    "Options:",
    "  --active-dir <path>  Override active dir (default: <repo>/.agents/workspace/active)",
    "  --short-id-length N  Override configured width (default: from .airc.json or 2)"
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
  if (!repoRoot) return DEFAULT_SHORT_ID_LENGTH;
  try {
    const cfgPath = path.join(repoRoot, ".agents", ".airc.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const v = cfg && cfg.task && cfg.task.shortIdLength;
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) return v;
  } catch {
    // ignore
  }
  return DEFAULT_SHORT_ID_LENGTH;
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return { version: 1, ids: {} };
  }
  let raw;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (e) {
    writeStderr(`Error: cannot read registry ${registryPath}: ${e.message}\n`);
    process.exit(2);
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !data.ids || typeof data.ids !== "object") {
      writeStderr(`Error: registry ${registryPath} has invalid schema\n`);
      process.exit(2);
    }
    if (data.version !== 1) data.version = 1;
    return data;
  } catch (e) {
    writeStderr(`Error: registry ${registryPath} is not valid JSON: ${e.message}\n`);
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
        writeStderr(`Error: registry lock timeout after ${timeoutMs}ms\n`);
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

function padShortId(n, shortIdLength) {
  return String(n).padStart(shortIdLength, "0");
}

function allocateMinFreeInt(registry, shortIdLength) {
  const maxN = Math.pow(10, shortIdLength) - 1;
  for (let n = 1; n <= maxN; n += 1) {
    if (!registry.ids[padShortId(n, shortIdLength)]) return n;
  }
  return null;
}

function parseShortIdArg(arg, shortIdLength) {
  const L = shortIdLength;
  const max = Math.pow(10, L) - 1;
  // Accept bare numeric or '#'-prefixed; canonicalize to zero-padded key.
  // Bare numeric is the recommended form (no shell quoting needed).
  const m = /^#?(\d+)$/.exec(arg);
  if (!m) {
    writeStderr(
      `Error: invalid short id format '${arg}', ` +
        `expected bare digits (recommended) or '#'-prefixed digits; ` +
        `e.g. '11' or '#11' (shortIdLength=${L}, max=${max})\n`
    );
    process.exit(1);
  }
  const n = Number(m[1]);
  if (n === 0) {
    writeStderr(
      `Error: short id '${arg}' is invalid (#${"0".repeat(L)} is reserved)\n`
    );
    process.exit(1);
  }
  if (n > max) {
    writeStderr(
      `Error: short id ${n} exceeds shortIdLength=${L} capacity (max=${max}); ` +
        `archive tasks or raise task.shortIdLength in .agents/.airc.json\n`
    );
    process.exit(1);
  }
  return String(n).padStart(L, "0");
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

  // A2: stale entries (registry points at a task no longer active)
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
      writeStderr(
        `Error: duplicate registry entries for taskId ${taskId} at keys [#${existingKey}, #${key}]; manual resolution required\n`
      );
      process.exit(2);
    }
    taskIdToKey.set(taskId, key);
  }

  // The registry is the sole source of truth: short ids are allocated only by
  // explicit `alloc` (planAlloc), never inferred from task.md or auto-allocated
  // for active tasks. Read paths (resolve/list) only run stale cleanup (A2).
  const plannedRegistryWrites = [];

  const tx = {
    _registry: registry,
    _activeDir: activeDir,
    _registrySnapshot: { ...registry.ids },
    _pendingRegistryDeletes: pendingRegistryDeletes,
    _plannedRegistryWrites: plannedRegistryWrites,
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
      const n = allocateMinFreeInt({ ids: this._projectedIds }, this._shortIdLength);
      const key = padShortId(n, this._shortIdLength);
      this._projectedIds[key] = taskId;
      this._taskIdToKey.set(taskId, key);
      this._plannedRegistryWrites.push({ key, taskId });
      return key;  // zero-padded; matches registry key
    },

    planRelease(taskId) {
      const key = this._taskIdToKey.get(taskId);
      if (!key) return; // idempotent
      this._plannedRegistryWrites = this._plannedRegistryWrites.filter(
        (w) => w.taskId !== taskId
      );
      this._pendingRegistryDeletes.push(key);
      delete this._projectedIds[key];
      this._taskIdToKey.delete(taskId);
    },

    commit(registryPath) {
      // Apply registry mutation in memory, then persist atomically.
      for (const key of this._pendingRegistryDeletes) delete this._registry.ids[key];
      for (const { key, taskId } of this._plannedRegistryWrites) {
        this._registry.ids[key] = taskId;
      }
      try {
        writeRegistryAtomic(this._registry, registryPath);
      } catch (e) {
        this._registry.ids = this._registrySnapshot;
        throw new Error(`Failed to persist registry to ${registryPath}: ${e.message}`);
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
  const missing_in_registry = [];
  for (const taskId of activeTaskIds) {
    if (!registryTaskIds.has(taskId)) {
      missing_in_registry.push({ taskId });
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
    orphans_in_registry,
    duplicate_registry_keys
  };
}

function cmdAlloc(taskId, activeDir, registryPath, shortIdLength) {
  if (!TASK_ID_RE.test(taskId)) {
    writeStderr(`Error: invalid task id format '${taskId}'\n`);
    process.exit(1);
  }
  return withRegistryLock(activeDir, () => {
    const taskMdPath = path.join(activeDir, taskId, "task.md");
    if (!fs.existsSync(taskMdPath)) {
      writeStderr(`Error: task ${taskId} not found in ${activeDir} (no task.md)\n`);
      process.exit(1);
    }
    const registry = readRegistry(registryPath);
    const tx = planTransaction(registry, activeDir, shortIdLength);
    let shortId;
    try {
      shortId = tx.planAlloc(taskId);
    } catch (e) {
      writeStderr(`${e.message}\n`);
      process.exit(2);
    }
    try {
      tx.commit(registryPath);
    } catch (e) {
      writeStderr(`${e.message}\n`);
      process.exit(1);
    }
    // shortId is already zero-padded (returned by tx.planAlloc; matches registry key)
    writeStdout(`#${shortId}\n`);
  });
}

function cmdRelease(taskId, activeDir, registryPath, shortIdLength) {
  if (!TASK_ID_RE.test(taskId)) {
    writeStderr(`Error: invalid task id format '${taskId}'\n`);
    process.exit(1);
  }
  return withRegistryLock(activeDir, () => {
    const registry = readRegistry(registryPath);
    const tx = planTransaction(registry, activeDir, shortIdLength);
    tx.planRelease(taskId);
    try {
      tx.commit(registryPath);
    } catch (e) {
      writeStderr(`${e.message}\n`);
      process.exit(1);
    }
    // idempotent exit 0
  });
}

function cmdResolve(shortIdArg, activeDir, registryPath, shortIdLength) {
  // Accepts bare digits ('11') or '#'-prefixed form ('#11', '#11', '#005'); normalized by
  // numeric value with capacity check (n > 10^L-1) and reserved-zero rejection.
  const key = parseShortIdArg(shortIdArg, shortIdLength);
  return withRegistryLock(activeDir, () => {
    const registry = readRegistry(registryPath);
    const tx = planTransaction(registry, activeDir, shortIdLength);
    const taskId = tx._projectedIds[key];
    if (!taskId) {
      const hasPendingMutations =
        tx._plannedRegistryWrites.length > 0 ||
        tx._pendingRegistryDeletes.length > 0;
      if (hasPendingMutations) {
        try {
          tx.commit(registryPath);
        } catch (e) {
          writeStderr(`${e.message}\n`);
          process.exit(1);
        }
      }
      if (Object.keys(tx._projectedIds).length === 0) {
        writeStderr(
          `Error: short id '#${key}' not found; active task registry is empty.\n`
        );
      } else {
        writeStderr(
          `Error: short id '#${key}' not found in active task registry ` +
            `(it may have been cleaned up after archival; check 'task-short-id.js list').\n`
        );
      }
      process.exit(1);
    }
    try {
      tx.commit(registryPath);
    } catch (e) {
      writeStderr(`${e.message}\n`);
      process.exit(1);
    }
    writeStdout(`${taskId}\n`);
  });
}

function cmdList(activeDir, registryPath, verify) {
  if (!verify) {
    const registry = readRegistry(registryPath);
    writeStdout(`${JSON.stringify(registry, null, 2)}\n`);
    return;
  }
  const registry = readRegistry(registryPath);
  if (!fs.existsSync(activeDir)) {
    writeStdout("");
    return;
  }
  const diff = verifyRegistry(registry, activeDir);
  const hasIssues =
    diff.missing_in_registry.length > 0 ||
    diff.orphans_in_registry.length > 0 ||
    diff.duplicate_registry_keys.length > 0;
  if (hasIssues) {
    writeStdout(`${JSON.stringify(diff, null, 2)}\n`);
    process.exit(1);
  }
  // consistent: empty stdout, exit 0
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    writeStderr(`${e.message}\n${usage()}\n`);
    process.exit(1);
  }
  if (args.help || args.positional.length === 0) {
    writeStdout(`${usage()}\n`);
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
    writeStderr(
      `Error: cannot locate active dir (no .agents/.airc.json found above ${process.cwd()})\n`
    );
    process.exit(2);
  }
  const shortIdLength = readShortIdLength(repoRoot, args.shortIdLength);
  const registryPath = path.join(activeDir, REGISTRY_NAME);

  switch (subcommand) {
    case "alloc":
      if (!args.positional[1]) {
        writeStderr(`Usage: alloc <task-id>\n`);
        process.exit(1);
      }
      return cmdAlloc(args.positional[1], activeDir, registryPath, shortIdLength);
    case "release":
      if (!args.positional[1]) {
        writeStderr(`Usage: release <task-id>\n`);
        process.exit(1);
      }
      return cmdRelease(args.positional[1], activeDir, registryPath, shortIdLength);
    case "resolve":
      if (!args.positional[1]) {
        writeStderr(`Usage: resolve <#N>\n`);
        process.exit(1);
      }
      return cmdResolve(args.positional[1], activeDir, registryPath, shortIdLength);
    case "list":
      return cmdList(activeDir, registryPath, args.verify);
    default:
      writeStderr(`Unknown subcommand: ${subcommand}\n${usage()}\n`);
      process.exit(1);
  }
}

// Compare canonicalized (symlink-resolved) paths so this script still runs as a
// CLI when invoked through a temp-dir symlink (notably /var/folders on macOS,
// which is a symlink to /private/var/folders; process.argv[1] keeps the
// symlinked path while import.meta.url is auto-resolved to the realpath).
const isCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const realEntry = fs.realpathSync(entry);
    const realModule = fs.realpathSync(fileURLToPath(import.meta.url));
    return realEntry === realModule;
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
  padShortId,
  parseShortIdArg,
  allocateMinFreeInt,
  planTransaction,
  verifyRegistry,
  cmdAlloc,
  cmdRelease,
  cmdResolve,
  cmdList,
  main
};
