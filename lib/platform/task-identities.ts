import type { ProviderIdentityDeclaration, ResourceIdentity } from './resource-identity.ts';
import { parseResourceIdentity } from './resource-identity.ts';
import { parse as parseYaml } from 'yaml';

function taskIssueIdentity(
  frontmatter: Record<string, string | number | boolean | null>,
  _declaration?: ProviderIdentityDeclaration
): ResourceIdentity | null {
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
  const legacy = frontmatter.issue_number;
  const number = typeof legacy === 'number' ? legacy : typeof legacy === 'string' && /^[1-9]\d*$/u.test(legacy) ? Number(legacy) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? { kind: 'number', value: number } : null;
}

export { taskIssueIdentity };
