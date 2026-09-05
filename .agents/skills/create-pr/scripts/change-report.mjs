import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { cwd: process.cwd() };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if ((argument === "--base" || argument === "--head" || argument === "--cwd") && value) {
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }

    fail(`Unknown or incomplete argument: ${argument}`);
  }

  if (!options.base || !options.head) {
    fail("Usage: change-report.mjs --base <sha> --head <sha> [--cwd <repository>]");
  }

  return options;
}

function git(args, options, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: options.cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024
  });
}

function parseRawDiff(buffer) {
  const tokens = buffer.toString("utf8").split("\0");
  const files = [];

  for (let index = 0; index < tokens.length && tokens[index];) {
    const header = tokens[index++];
    const [oldMode, newMode, oldOid, newOid, status] = header.slice(1).split(" ");
    const firstPath = tokens[index++];
    const hasPathPair = status.startsWith("R") || status.startsWith("C");
    const secondPath = hasPathPair ? tokens[index++] : firstPath;

    files.push({
      status,
      oldMode,
      newMode,
      oldOid,
      newOid,
      oldPath: status.startsWith("A") ? null : firstPath,
      newPath: status.startsWith("D") ? null : secondPath
    });
  }

  return files;
}

function parseNumstat(buffer) {
  const tokens = buffer.toString("utf8").split("\0");
  const stats = new Map();

  for (let index = 0; index < tokens.length && tokens[index];) {
    const record = tokens[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);

    if (path) {
      stats.set(`path:${path}`, { additions, deletions });
      continue;
    }

    const oldPath = tokens[index++];
    const newPath = tokens[index++];
    stats.set(`pair:${oldPath}\0${newPath}`, { additions, deletions });
  }

  return stats;
}

function objectSizes(files, options) {
  const objectIds = new Set();

  for (const file of files) {
    if (file.oldMode !== "000000" && file.oldMode !== "160000" && !file.status.startsWith("C")) {
      objectIds.add(file.oldOid);
    }
    if (file.newMode !== "000000" && file.newMode !== "160000") {
      objectIds.add(file.newOid);
    }
  }

  if (objectIds.size === 0) return new Map();

  const ids = [...objectIds];
  const output = execFileSync(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    {
      cwd: options.cwd,
      input: `${ids.join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }
  );
  const sizes = new Map();

  for (const line of output.trim().split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (type === "blob") sizes.set(oid, Number(size));
  }

  return sizes;
}

function numericLineCount(value) {
  return value === "-" ? null : Number(value);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mergeBase = git(["merge-base", options.base, options.head], options).trim();
  const patch = git(["diff", "--no-ext-diff", "--binary", "--find-renames", mergeBase, options.head], options, null);
  const diffArgs = ["diff", "--no-ext-diff", "--find-renames", "-z", mergeBase, options.head];
  const files = parseRawDiff(git([...diffArgs.slice(0, 2), "--raw", "--abbrev=64", ...diffArgs.slice(2)], options, null));
  const numstat = parseNumstat(git([...diffArgs.slice(0, 2), "--numstat", ...diffArgs.slice(2)], options, null));
  const sizes = objectSizes(files, options);

  const reportFiles = files.map((file) => {
    const key = file.status.startsWith("R") || file.status.startsWith("C")
      ? `pair:${file.oldPath}\0${file.newPath}`
      : `path:${file.newPath || file.oldPath}`;
    const lines = numstat.get(key);
    if (!lines) fail(`Missing numstat record for ${file.newPath || file.oldPath}`);

    const oldBytes = file.oldMode === "000000" || file.oldMode === "160000" || file.status.startsWith("C")
      ? 0
      : sizes.get(file.oldOid);
    const newBytes = file.newMode === "000000" || file.newMode === "160000"
      ? 0
      : sizes.get(file.newOid);
    if (oldBytes === undefined || newBytes === undefined) {
      fail(`Unable to resolve blob size for ${file.newPath || file.oldPath}`);
    }

    return {
      status: file.status,
      oldPath: file.oldPath,
      newPath: file.newPath,
      additions: numericLineCount(lines.additions),
      deletions: numericLineCount(lines.deletions),
      oldBytes,
      newBytes,
      netBytes: newBytes - oldBytes
    };
  });

  const totals = reportFiles.reduce((result, file) => {
    result.files += 1;
    result.oldBytes += file.oldBytes;
    result.newBytes += file.newBytes;
    result.netBytes += file.netBytes;
    if (file.additions === null || file.deletions === null) {
      result.binaryFiles += 1;
    } else {
      result.textFiles += 1;
      result.additions += file.additions;
      result.deletions += file.deletions;
    }
    return result;
  }, {
    files: 0,
    textFiles: 0,
    binaryFiles: 0,
    additions: 0,
    deletions: 0,
    oldBytes: 0,
    newBytes: 0,
    netBytes: 0
  });

  process.stdout.write(`${JSON.stringify({
    version: 1,
    base: options.base,
    head: options.head,
    mergeBase,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    files: reportFiles,
    totals
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
