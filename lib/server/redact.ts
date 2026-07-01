const SECRET_PATTERNS = [
  /\b(token|secret|password|passwd|api[_-]?key)=([^\s]+)/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix) => `${prefix}=<redacted>`);
  }
  return out;
}
