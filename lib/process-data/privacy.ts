import { sha256 } from './store.ts';

import type { CapturedObject, PrivacyDisposition, SourceKind } from './types.ts';

type ScannedDisposition =
  | Extract<PrivacyDisposition, { state: 'included' }>
  | Extract<PrivacyDisposition, { state: 'excluded-sensitive' }>;

const RULES = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'github-token', pattern: /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/i },
  { id: 'credential-field', pattern: /(?:api[_-]?key|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i }
] as const;

function inspectPrivacy(content: string): ScannedDisposition {
  for (const rule of RULES) {
    if (rule.pattern.test(content)) return { state: 'excluded-sensitive', ruleId: rule.id };
  }
  return { state: 'included' };
}

function captureText(sourceKind: SourceKind, sourceIdentity: string, content: string): CapturedObject {
  const bytes = Buffer.byteLength(content);
  const digest = sha256(Buffer.from(content, 'utf8'));
  const disposition = inspectPrivacy(content);
  return disposition.state === 'included'
    ? { sourceKind, sourceIdentity, sha256: digest, bytes, content, disposition }
    : { sourceKind, sourceIdentity, sha256: digest, bytes, disposition };
}

function redactExcerpt(content: string, maxBytes = 4096): string | null {
  if (inspectPrivacy(content).state !== 'included') return null;
  const buffer = Buffer.from(content, 'utf8');
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\b(token|password|secret)=\S+/gi, '$1=[REDACTED]');
}

export { captureText, inspectPrivacy, redactExcerpt };
