import fs from 'node:fs';
import path from 'node:path';

import { getArtifactSchema } from './artifact-schema.ts';

type VerificationConfig = {
  skill?: string;
  checks: Record<string, Record<string, unknown> | null>;
};

function loadVerificationConfig(repositoryRoot: string, skillName: string): VerificationConfig {
  const verifyPath = path.join(repositoryRoot, '.agents', 'skills', skillName, 'config', 'verify.json');
  if (!fs.existsSync(verifyPath)) throw new Error(`config/verify.json not found for skill '${skillName}'`);
  const parsed = JSON.parse(fs.readFileSync(verifyPath, 'utf8')) as Partial<VerificationConfig>;
  if (!parsed.checks || typeof parsed.checks !== 'object' || Array.isArray(parsed.checks)) {
    throw new Error(`config/verify.json has invalid checks for skill '${skillName}'`);
  }
  const artifact = parsed.checks.artifact;
  if (artifact && typeof artifact === 'object' && !Array.isArray(artifact)) {
    const schema = artifact.schema;
    if (schema !== undefined && (typeof schema !== 'string' || !getArtifactSchema(schema))) {
      throw new Error(`config/verify.json has unknown artifact schema '${String(schema)}' for skill '${skillName}'`);
    }
  }
  return { ...(parsed.skill ? { skill: parsed.skill } : {}), checks: parsed.checks };
}

export { loadVerificationConfig };
export type { VerificationConfig };
