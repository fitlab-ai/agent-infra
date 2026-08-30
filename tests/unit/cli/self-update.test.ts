import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cmdUpdate,
  detectUpdateSource
} from "../../../lib/self-update.ts";
import { needsShell, resolveCommand } from "../../../lib/run/host.ts";
import { onPlatforms } from "../../helpers.ts";

type CommandResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
};

type SelfUpdateOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  run?: (command: readonly string[]) => CommandResult;
};

function writeFile(filePath: string, content = "fixture\n", mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  if (mode !== undefined) fs.chmodSync(filePath, mode);
}

function makePackage(root: string): { packageRoot: string; entry: string } {
  const packageRoot = path.join(root, "@fitlab-ai", "agent-infra");
  const entry = path.join(packageRoot, "dist", "bin", "cli.js");
  writeFile(entry);
  writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@fitlab-ai/agent-infra", version: "0.0.0-test" })
  );
  return { packageRoot, entry };
}

function npmRunner(prefix: string, root: string, status = 0, calls: string[][] = []) {
  return (command: readonly string[]): CommandResult => {
    calls.push([...command]);
    const args = command.slice(1);
    if (args.join(" ") === "prefix --global") return { status: 0, stdout: `${prefix}\n` };
    if (args.join(" ") === "root --global") return { status: 0, stdout: `${root}\n` };
    return { status, stderr: status === 0 ? "" : "npm failed\n" };
  };
}

test("host command resolution honors Windows PATHEXT and batch shell rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-command-"));
  try {
    const binDir = path.join(root, "node");
    const npmCmd = path.join(binDir, "npm.cmd");
    writeFile(npmCmd);
    const env = { Path: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    assert.equal(resolveCommand("npm", "win32", env), npmCmd);
    assert.equal(needsShell(npmCmd, "win32"), true);
    assert.equal(needsShell(npmCmd, "linux"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX command resolution skips a non-executable earlier PATH file", onPlatforms("linux", "darwin"), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-command-mode-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    writeFile(path.join(first, "probe"));
    writeFile(path.join(second, "probe"), "fixture\n", 0o755);

    assert.equal(
      resolveCommand("probe", "linux", { PATH: [first, second].join(path.delimiter) }),
      path.join(second, "probe")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX command resolution uses PATH instead of a non-standard Path variable", onPlatforms("linux", "darwin"), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-command-path-case-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    writeFile(path.join(first, "probe"), "first\n", 0o755);
    writeFile(path.join(second, "probe"), "second\n", 0o755);

    assert.equal(
      resolveCommand("probe", "linux", { Path: first, PATH: second }),
      path.join(second, "probe")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX command resolution preserves the current directory for an empty PATH entry", onPlatforms("linux", "darwin"), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-host-command-empty-path-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    const second = path.join(root, "second");
    const cwdProbe = path.join(root, "probe");
    writeFile(cwdProbe, "cwd\n", 0o755);
    writeFile(path.join(second, "probe"), "second\n", 0o755);

    assert.equal(
      resolveCommand("probe", "linux", { PATH: ["", second].join(path.delimiter) }),
      cwdProbe
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update rejects a manager resolved from an empty POSIX PATH entry", onPlatforms("linux", "darwin"), () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-empty-path-"));
  const previousCwd = process.cwd();
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { entry } = makePackage(globalRoot);
    const manager = path.join(prefix, "npm");
    writeFile(manager, "fixture\n", 0o755);
    process.chdir(prefix);

    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: ["", path.join(root, "empty")].join(path.delimiter) },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot)
    });

    assert.equal(detected.source, null);
    assert.match(detected.error ?? "", /manager|PATH|source/i);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows npm source accepts a Node manager directory separate from global packages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-win-"));
  try {
    const prefix = path.join(root, "AppData", "npm");
    const globalRoot = path.join(prefix, "node_modules");
    const nodeHome = path.join(root, "Program Files", "nodejs");
    const { packageRoot, entry } = makePackage(globalRoot);
    const manager = path.join(nodeHome, "npm.cmd");
    writeFile(manager);
    const env = {
      Path: nodeHome,
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    };
    const calls: string[][] = [];
    const options: SelfUpdateOptions = {
      platform: "win32",
      env,
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot, 0, calls)
    };

    const detected = detectUpdateSource(options);
    assert.equal(detected.source?.kind, "npm");
    assert.equal(detected.source?.managerPath, manager);
    assert.equal(detected.source?.packageRoot, packageRoot);

    const code = await cmdUpdate(options);
    assert.equal(code, 0);
    assert.deepEqual(calls.map((call) => call[0]), [manager, manager, manager, manager, manager]);
    assert.deepEqual(calls.at(-1)?.slice(1), ["update", "--global", "@fitlab-ai/agent-infra"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX npm source rejects a manager outside its global prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-posix-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "lib", "node_modules");
    const managerHome = path.join(root, "other");
    const { entry } = makePackage(globalRoot);
    const manager = path.join(managerHome, "npm");
    writeFile(manager, "fixture\n", 0o755);
    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: managerHome },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot)
    });

    assert.equal(detected.source, null);
    assert.match(detected.error ?? "", /source|prefix/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX npm source accepts a symlinked npm entry point", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-npm-link-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "lib", "node_modules");
    const { entry } = makePackage(globalRoot);
    const managerHome = path.join(prefix, "bin");
    const managerTarget = path.join(prefix, "libexec", "npm-cli.js");
    const manager = path.join(managerHome, "npm");
    writeFile(managerTarget, "fixture\n", 0o755);
    fs.mkdirSync(managerHome, { recursive: true });
    fs.symlinkSync(managerTarget, manager);

    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: managerHome },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot)
    });

    assert.equal(detected.source?.kind, "npm");
    assert.equal(detected.source?.managerPath, managerTarget);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manager failure returns the manager exit code without success output contract", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-failure-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { entry } = makePackage(globalRoot);
    const manager = path.join(prefix, "bin", "npm");
    writeFile(manager, "fixture\n", 0o755);
    const calls: string[][] = [];
    const code = await cmdUpdate({
      platform: "linux",
      env: { PATH: path.dirname(manager) },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot, 17, calls)
    });

    assert.equal(code, 17);
    assert.equal(calls.at(-1)?.slice(1).join(" "), "update --global @fitlab-ai/agent-infra");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Homebrew source uses the formula manager without probing npm", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-brew-"));
  try {
    const homebrewRoot = path.join(root, "homebrew");
    const formulaRoot = path.join(homebrewRoot, "opt", "agent-infra");
    const { packageRoot, entry } = makePackage(formulaRoot);
    const manager = path.join(homebrewRoot, "bin", "brew");
    writeFile(manager, "fixture\n", 0o755);
    const calls: string[][] = [];
    const options: SelfUpdateOptions = {
      platform: "linux",
      env: { PATH: path.dirname(manager) },
      argv: ["node", entry],
      run: (command) => {
        calls.push([...command]);
        const args = command.slice(1).join(" ");
        if (args === "--prefix") return { status: 0, stdout: `${homebrewRoot}\n` };
        if (args === "--prefix agent-infra") return { status: 0, stdout: `${formulaRoot}\n` };
        return { status: 0, stderr: "" };
      }
    };

    const detected = detectUpdateSource(options);
    assert.equal(detected.source?.kind, "brew");
    assert.equal(detected.source?.packageRoot, packageRoot);
    assert.equal(await cmdUpdate(options), 0);
    assert.deepEqual(calls.at(-1)?.slice(1), ["upgrade", "agent-infra"]);
    assert.ok(calls.every((call) => call[0] === manager));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update rejects a package root that does not match npm global root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-package-root-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { entry } = makePackage(path.join(root, "other"));
    fs.mkdirSync(globalRoot, { recursive: true });
    const manager = path.join(prefix, "bin", "npm");
    writeFile(manager, "fixture\n", 0o755);
    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: path.dirname(manager) },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot)
    });

    assert.equal(detected.source, null);
    assert.match(detected.error ?? "", /global root|source/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update rejects a package name that is not agent-infra", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-package-name-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { packageRoot, entry } = makePackage(globalRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/not-agent-infra", version: "0.0.0-test" }),
      "utf8"
    );
    const manager = path.join(prefix, "bin", "npm");
    writeFile(manager, "fixture\n", 0o755);
    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: path.dirname(manager) },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot)
    });

    assert.equal(detected.source, null);
    assert.match(detected.error ?? "", /persistent|package/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update rejects PATH shadowing from a different installed package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-shadow-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { entry } = makePackage(globalRoot);
    const other = makePackage(path.join(root, "other"));
    fs.chmodSync(other.entry, 0o755);
    const managerHome = path.join(prefix, "bin");
    const manager = path.join(managerHome, "npm");
    writeFile(manager, "fixture\n", 0o755);
    const alias = path.join(managerHome, "ai");
    fs.symlinkSync(other.entry, alias);
    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: managerHome },
      argv: ["node", entry],
      run: npmRunner(prefix, globalRoot)
    });

    assert.equal(detected.source, null);
    assert.match(detected.error ?? "", /shadowing|ai/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update refuses when npm and Homebrew both claim the package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-dual-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { entry } = makePackage(globalRoot);
    const managerHome = path.join(prefix, "bin");
    const npm = path.join(managerHome, "npm");
    const brew = path.join(managerHome, "brew");
    writeFile(npm, "fixture\n", 0o755);
    writeFile(brew, "fixture\n", 0o755);
    const calls: string[][] = [];
    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: managerHome },
      argv: ["node", entry],
      run: (command) => {
        calls.push([...command]);
        const args = command.slice(1).join(" ");
        if (command[0] === npm && args === "prefix --global") return { status: 0, stdout: `${prefix}\n` };
        if (command[0] === npm && args === "root --global") return { status: 0, stdout: `${globalRoot}\n` };
        if (command[0] === brew && args === "--prefix") return { status: 0, stdout: `${prefix}\n` };
        if (command[0] === brew && args === "--prefix agent-infra") return { status: 0, stdout: `${prefix}\n` };
        return { status: 0, stderr: "" };
      }
    });

    assert.equal(detected.source, null);
    assert.match(detected.error ?? "", /Multiple package managers/i);
    assert.equal(calls.some((call) => call[1] === "update" || call[1] === "upgrade"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update fails closed when no package manager is on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-no-manager-"));
  try {
    const { entry } = makePackage(path.join(root, "prefix", "node_modules"));
    const calls: string[][] = [];
    const detected = detectUpdateSource({
      platform: "linux",
      env: { PATH: path.join(root, "empty") },
      argv: ["node", entry],
      run: (command) => {
        calls.push([...command]);
        return { status: 0, stdout: "" };
      }
    });

    assert.equal(detected.source, null);
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update refuses a manager that disappears after probing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-drift-"));
  try {
    const prefix = path.join(root, "prefix");
    const globalRoot = path.join(prefix, "node_modules");
    const { entry } = makePackage(globalRoot);
    const manager = path.join(prefix, "bin", "npm");
    writeFile(manager, "fixture\n", 0o755);
    const calls: string[][] = [];
    const code = await cmdUpdate({
      platform: "linux",
      env: { PATH: path.dirname(manager) },
      argv: ["node", entry],
      run: (command) => {
        calls.push([...command]);
        const args = command.slice(1).join(" ");
        if (args === "prefix --global") {
          fs.unlinkSync(manager);
          return { status: 0, stdout: `${prefix}\n` };
        }
        if (args === "root --global") return { status: 0, stdout: `${globalRoot}\n` };
        return { status: 0, stderr: "" };
      }
    });

    assert.equal(code, 1);
    assert.equal(calls.some((call) => call[1] === "update"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-update returns 1 for manager signal and spawn failures", async () => {
  for (const failure of [
    { signal: "SIGTERM" as NodeJS.Signals },
    { error: new Error("spawn failed") }
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-infra-self-update-run-failure-"));
    try {
      const prefix = path.join(root, "prefix");
      const globalRoot = path.join(prefix, "node_modules");
      const { entry } = makePackage(globalRoot);
      const manager = path.join(prefix, "bin", "npm");
      writeFile(manager, "fixture\n", 0o755);
      const code = await cmdUpdate({
        platform: "linux",
        env: { PATH: path.dirname(manager) },
        argv: ["node", entry],
        run: (command) => {
          const args = command.slice(1).join(" ");
          if (args === "prefix --global") return { status: 0, stdout: `${prefix}\n` };
          if (args === "root --global") return { status: 0, stdout: `${globalRoot}\n` };
          return { status: null, ...failure };
        }
      });

      assert.equal(code, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
