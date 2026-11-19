import path from "node:path";
import { inspectArtifactDirectory } from "./artifact-lifecycle.ts";

export function findAuthoritativeReviewCodeArtifact(taskDir: string) {
  const inventory = inspectArtifactDirectory(taskDir, 'review-code');
  if (inventory.status !== 'ready' || !inventory.latest) {
    return { ok: false, round: 0, fileName: null, path: null, error: null };
  }
  const { round, name: fileName } = inventory.latest;
  return {
    ok: true,
    round,
    fileName,
    path: path.join(taskDir, fileName),
    error: null
  };
}
