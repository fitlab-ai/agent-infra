import semver from 'semver';

export type RuntimeEngineMismatch = {
  runtimes: string[];
  enginesNode: string;
};

function nodeMajor(runtime: string): number | null {
  const match = /^node(\d+)$/.exec(runtime);
  return match ? Number(match[1]) : null;
}

export function findRuntimeEngineMismatches(
  runtimes: string[],
  enginesNode: string | undefined
): RuntimeEngineMismatch[] {
  if (!enginesNode) {
    return [];
  }

  const range = semver.validRange(enginesNode);
  if (!range) {
    return [];
  }

  const nodeRuntimes: string[] = [];
  for (const runtime of runtimes) {
    const major = nodeMajor(runtime);
    if (major === null) {
      continue;
    }
    nodeRuntimes.push(runtime);
    if (semver.intersects(`${major}.x`, range)) {
      return [];
    }
  }

  return nodeRuntimes.length > 0 ? [{ runtimes: nodeRuntimes, enginesNode }] : [];
}
