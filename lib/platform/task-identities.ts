import type { ResourceIdentity } from './resource-identity.ts';
import { parseResourceIdentity } from './resource-identity.ts';
import { parse as parseYaml } from 'yaml';

function taskIssueIdentity(frontmatter: Record<string, string | number | boolean | null>): ResourceIdentity | null {
  const serialized = frontmatter.platform_issue_identity;
  if (typeof serialized === 'string' && serialized.trim()) {
    try {
      const decoded = parseYaml(serialized);
      return parseResourceIdentity(
        JSON.parse(typeof decoded === 'string' ? decoded : serialized),
        'platform_issue_identity'
      );
    } catch {
      return null;
    }
  }
  // TODO(compat): Remove this transition-only legacy reader once the active migration manifest is completed and the current-only build is deployed.
  if (process.env.AGENT_INFRA_TRANSITION_BUILD === '1') {
    const legacy = frontmatter.issue_number;
    if (typeof legacy === 'number' && Number.isSafeInteger(legacy) && legacy > 0) return { kind: 'number', value: legacy };
    if (typeof legacy === 'string' && /^[1-9]\d*$/u.test(legacy)) {
      const value = Number(legacy);
      if (Number.isSafeInteger(value) && value > 0) return { kind: 'number', value };
    }
  }
  return null;
}

function taskIssueIdentityError(error: unknown): { code: string; message: string } {
  const value = error && typeof error === 'object' ? error as { code?: unknown } : {};
  return {
    code: typeof value.code === 'string' ? value.code : 'PLATFORM_IDENTITY_INVALID',
    message: error instanceof Error ? error.message : String(error)
  };
}

export { taskIssueIdentity, taskIssueIdentityError };
