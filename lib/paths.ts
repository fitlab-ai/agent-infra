import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveTemplateDir() {
  const candidates = [
    // Source checkout: lib/paths.ts -> repo-root/templates.
    new URL('../templates', import.meta.url),
    // Installed package: dist/lib/paths.js -> package-root/templates.
    new URL('../../templates', import.meta.url)
  ];
  for (const candidate of candidates) {
    const bundledDir = fileURLToPath(candidate);
    if (fs.existsSync(bundledDir)) return bundledDir;
  }
  return null;
}

export { resolveTemplateDir };
