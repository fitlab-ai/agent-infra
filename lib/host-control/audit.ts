import fs from 'node:fs';
import path from 'node:path';

import type { HostControlAudit } from './server.ts';

export const HOST_CONTROL_AUDIT_FILE = 'audit.ndjson';

export function hostControlAuditPath(endpoint: string): string {
  return path.join(path.dirname(endpoint), HOST_CONTROL_AUDIT_FILE);
}

export function appendHostControlAudit(endpoint: string, entry: HostControlAudit, at = Date.now()): void {
  const filePath = hostControlAuditPath(endpoint);
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, at, ...entry })}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
