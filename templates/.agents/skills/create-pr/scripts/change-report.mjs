import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), kind: "merge-base" };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if ((argument === "--base" || argument === "--head" || argument === "--cwd" || argument === "--from-head" || argument === "--kind") && value) {
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }

    fail(`Unknown or incomplete argument: ${argument}`);
  }

  if (!options.base || !options.head) {
    fail("Usage: change-report.mjs --base <sha> --head <sha> [--kind merge-base|head-to-head] [--from-head <sha>] [--cwd <repository>]");
  }
  if (!['merge-base', 'head-to-head'].includes(options.kind) || (options.kind === 'head-to-head' && !options['from-head']) || (options.kind === 'merge-base' && options['from-head'])) fail('Invalid comparison kind or from-head argument');

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

function changedRanges(patch) {
  const ranges = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.toString('utf8').split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      appendPosition(ranges, 'new', newLine++);
    } else if (line.startsWith('-')) {
      appendPosition(ranges, 'old', oldLine++);
    } else if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return ranges;
}

function appendPosition(ranges, side, line) {
  const previous = ranges.at(-1);
  if (previous && previous.side === side && previous.endLine + 1 === line) previous.endLine = line;
  else ranges.push({ side, startLine: line, endLine: line });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const mergeBase = options.kind === 'merge-base' ? git(["merge-base", options.base, options.head], options).trim() : null;
  const from = options.kind === 'merge-base' ? mergeBase : options['from-head'];
  const to = options.head;
  const patch = git(["diff", "--no-ext-diff", "--binary", "--find-renames", from, to], options, null);
  const diffArgs = ["diff", "--no-ext-diff", "--find-renames", "-z", from, to];
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

    const filePatch = git(["diff", "--no-ext-diff", "--find-renames", "--unified=0", from, to, "--", ...(file.oldPath && file.newPath && file.oldPath !== file.newPath ? [file.oldPath, file.newPath] : [file.oldPath || file.newPath])], options, null);
    const locations = lines.additions === '-' && lines.deletions === '-' ? [] : changedRanges(filePatch);
    const addedPositions = locations.filter((range) => range.side === 'new').reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
    const deletedPositions = locations.filter((range) => range.side === 'old').reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
    if (lines.additions !== '-' && addedPositions !== Number(lines.additions)) fail(`Added position count does not match numstat for ${file.newPath || file.oldPath}`);
    if (lines.deletions !== '-' && deletedPositions !== Number(lines.deletions)) fail(`Deleted position count does not match numstat for ${file.newPath || file.oldPath}`);
    return {
      status: file.status,
      oldPath: file.oldPath,
      newPath: file.newPath,
      additions: numericLineCount(lines.additions),
      deletions: numericLineCount(lines.deletions),
      oldBytes,
      newBytes,
      netBytes: newBytes - oldBytes,
      locations
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
    kind: options.kind,
    from,
    to,
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
