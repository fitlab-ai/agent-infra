import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// =====================================================================
// CRITICAL: tests that spawn real `git` commands MUST use gitSafeEnv()
// ---------------------------------------------------------------------
// When `npm test` is invoked from a context that exports GIT_DIR,
// GIT_INDEX_FILE, GIT_WORK_TREE, or similar variables, child `git`
// processes inherit those vars and operate on the outer repository even
// when `cwd` points at a temp directory.
//
// Real-world incident on this repo (2026-04-29): a sandbox signing-key
// test leaked LOCAL-KEY-123 and core.bare=true into agent-infra's own
// .git/config, breaking GPG signing and repository discovery.
//
// Tests that exec/spawn `git` must pass env: gitSafeEnv(), or use
// initIsolatedGitRepo() for repo bootstrap.
// =====================================================================

function gitSafeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_DATE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR"
  ]) {
    delete env[key];
  }
  return env;
}

function withGitSafeProcessEnv<T>(fn: () => T, extra: NodeJS.ProcessEnv = {}): T {
  const previousEnv = process.env;
  process.env = gitSafeEnv(extra);

  try {
    const result = fn();
    // Test helpers only need native Promise support; custom thenables are out of scope.
    if (result instanceof Promise) {
      return result.finally(() => {
        process.env = previousEnv;
      }) as T;
    }
    process.env = previousEnv;
    return result;
  } catch (error) {
    process.env = previousEnv;
    throw error;
  }
}

function initIsolatedGitRepo(repoRoot: string, { remote = null }: { remote?: string | null } = {}): void {
  const env = gitSafeEnv();
  const initResult = spawnSync("git", ["init", "-q", "-b", "main"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  if (initResult.status !== 0) {
    throw new Error(`git init failed: ${initResult.stderr}`);
  }

  if (remote) {
    const remoteResult = spawnSync("git", ["remote", "add", "origin", remote], {
      cwd: repoRoot,
      encoding: "utf8",
      env
    });
    if (remoteResult.status !== 0) {
      throw new Error(`git remote add failed: ${remoteResult.stderr}`);
    }
  }
}

// List repo-tracked files matching the given git pathspecs, relative to the
// repository root. Callers can pass exclude pathspecs (e.g. ":!:node_modules/**")
// to scope the result. Uses gitSafeEnv() so it never touches an outer repo.
function listTrackedFiles(...patterns: string[]): string[] {
  const result = spawnSync("git", ["ls-files", "-z", ...patterns], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitSafeEnv()
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout.split("\0").filter((line) => line.length > 0);
}

export {
  gitSafeEnv,
  initIsolatedGitRepo,
  listTrackedFiles,
  withGitSafeProcessEnv
};
