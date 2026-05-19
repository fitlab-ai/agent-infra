import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolveTemplateDir() {
  const bundledDir = fileURLToPath(new URL('../templates', import.meta.url));
  return fs.existsSync(bundledDir) ? bundledDir : null;
}

export { resolveTemplateDir };
