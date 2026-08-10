const SENSITIVE_OUTPUT_PATTERNS = [
  { pattern: /\{[^{}]*"claudeAiOauth"[\s\S]*?\}\s*\}/g, replacement: '[REDACTED credentials blob]' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED claude token]' },
  { pattern: /gh[psoru]_[A-Za-z0-9]{30,}/g, replacement: '[REDACTED github token]' },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, replacement: 'Bearer [REDACTED]' }
];

export function redactCommandError(text: unknown): string {
  if (!text || typeof text !== 'string') return '';
  return SENSITIVE_OUTPUT_PATTERNS.reduce(
    (result, { pattern, replacement }) => result.replace(pattern, replacement),
    text
  );
}
