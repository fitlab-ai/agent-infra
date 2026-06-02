import { platform } from 'node:os';
import { createDarwinClipboardAdapter, type DarwinClipboardAdapter } from './darwin.ts';

export type ClipboardAdapter = DarwinClipboardAdapter;

export function createClipboardAdapter({
  platformName = platform()
}: { platformName?: NodeJS.Platform } = {}): ClipboardAdapter | null {
  if (platformName !== 'darwin') {
    return null;
  }
  return createDarwinClipboardAdapter();
}
