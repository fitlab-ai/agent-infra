import fs from 'node:fs';
import path from 'node:path';

type Artifact = {
  index: number;
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

// Lifecycle group ranking. Lower rank sorts first; within a rank, entries sort
// by filename ascending. `task.md` always leads, then the lifecycle order
// analysis → review-analysis → plan → review-plan → fallback. The more specific
// `review-*` matchers are listed before their base prefixes so the match order
// is unambiguous, but each keeps the rank that places it AFTER its base group.
const GROUP_MATCHERS: ReadonlyArray<{ rank: number; test: (name: string) => boolean }> = [
  { rank: 0, test: (n) => n === 'task.md' },
  { rank: 2, test: (n) => /^review-analysis/.test(n) },
  { rank: 1, test: (n) => /^analysis/.test(n) },
  { rank: 4, test: (n) => /^review-plan/.test(n) },
  { rank: 3, test: (n) => /^plan/.test(n) }
];
// Anything not matched above (reports, code*, review-code*, verify-pr-*, etc.).
const FALLBACK_RANK = 5;

function groupRank(name: string): number {
  for (const matcher of GROUP_MATCHERS) {
    if (matcher.test(name)) return matcher.rank;
  }
  return FALLBACK_RANK;
}

/**
 * Enumerate a task directory's artifacts in a deterministic order: `task.md`
 * first, then by lifecycle group (analysis → review-analysis → plan →
 * review-plan → fallback), and filename-ascending within each group.
 *
 * Only top-level regular files are included; subdirectories and dotfiles are
 * skipped so the numbered index contract stays stable and every entry is
 * something `cat` can print. The returned 1-based `index` is the single source
 * of truth shared by `files` and `cat`.
 */
function enumerateArtifacts(taskDir: string): Artifact[] {
  const entries = fs
    .readdirSync(taskDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && !dirent.name.startsWith('.'))
    .map((dirent) => dirent.name);

  entries.sort((a, b) => {
    const rankDiff = groupRank(a) - groupRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return entries.map((name, i) => {
    const abs = path.join(taskDir, name);
    const stat = fs.statSync(abs);
    return { index: i + 1, name, path: abs, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

/**
 * Resolve an artifact selector to an absolute path within `taskDir`. The
 * selector is either a 1-based index `N` (as listed by `files`) or a filename
 * (with or without the `.md` suffix). Throws with a clear message on failure.
 */
function resolveArtifact(taskDir: string, artifactOrN: string): string {
  if (path.basename(artifactOrN) !== artifactOrN) {
    throw new Error('artifact name must not contain path separators');
  }

  if (/^\d+$/.test(artifactOrN)) {
    const n = Number(artifactOrN);
    const match = enumerateArtifacts(taskDir).find((a) => a.index === n);
    if (!match) {
      throw new Error(`invalid artifact index ${n} (run 'ai task files <ref>' to list)`);
    }
    return match.path;
  }

  const candidates = artifactOrN.endsWith('.md')
    ? [artifactOrN]
    : [artifactOrN, `${artifactOrN}.md`];
  for (const candidate of candidates) {
    const abs = path.join(taskDir, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return abs;
    }
  }
  throw new Error(`artifact '${artifactOrN}' not found in task directory`);
}

export { enumerateArtifacts, resolveArtifact };
export type { Artifact };
