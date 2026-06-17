import fs from 'node:fs';
import path from 'node:path';

type Artifact = {
  index: number;
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

/**
 * Enumerate a task directory's artifacts ordered by modification time, oldest
 * first, so the listing reads like the task's timeline. Filename ascending is a
 * deterministic tiebreak when two files share the same mtime (e.g. written in
 * the same millisecond).
 *
 * Only top-level regular files are included; subdirectories and dotfiles are
 * skipped so every entry is something `cat` can print. The returned 1-based
 * `index` is the source of truth shared by `files` and `cat`.
 */
function enumerateArtifacts(taskDir: string): Artifact[] {
  const entries = fs
    .readdirSync(taskDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && !dirent.name.startsWith('.'))
    .map((dirent) => {
      const abs = path.join(taskDir, dirent.name);
      const stat = fs.statSync(abs);
      return { name: dirent.name, path: abs, size: stat.size, mtimeMs: stat.mtimeMs };
    });

  entries.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return entries.map((entry, i) => ({ index: i + 1, ...entry }));
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
