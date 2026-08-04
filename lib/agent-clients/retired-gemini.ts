import crypto from 'node:crypto';
import path from 'node:path';

import retiredCommandHashes from './retired-gemini-command-hashes.json' with { type: 'json' };

type RetiredGeminiCommand = keyof typeof retiredCommandHashes;

function normalizeProjectReference(content: string, project: string): string {
  return project === '' ? content : content.replaceAll(`for ${project}.`, 'for {{project}}.');
}

function isRetiredGeminiCommand(target: string, content: string | Buffer, project: string): boolean {
  const command = path.basename(target, '.toml') as RetiredGeminiCommand;
  const expected = retiredCommandHashes[command];
  if (!expected) return false;
  const normalized = normalizeProjectReference(content.toString(), project);
  const localHash = `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
  return expected.includes(localHash);
}

export { isRetiredGeminiCommand };
