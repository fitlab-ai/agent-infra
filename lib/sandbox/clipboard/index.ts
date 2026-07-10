import { platform } from 'node:os';
import { createDarwinClipboardAdapter, type DarwinClipboardAdapter } from './darwin.ts';
import { createLinuxClipboardAdapter, type LinuxClipboardAdapter } from './linux.ts';
import { createWin32ClipboardAdapter, type Win32ClipboardAdapter } from './win32.ts';

export type ClipboardAdapter = DarwinClipboardAdapter | LinuxClipboardAdapter | Win32ClipboardAdapter;

export function createClipboardAdapter({
  platformName = platform()
}: { platformName?: NodeJS.Platform } = {}): ClipboardAdapter | null {
  switch (platformName) {
    case 'darwin':
      return createDarwinClipboardAdapter();
    case 'linux':
      return createLinuxClipboardAdapter();
    case 'win32':
      return createWin32ClipboardAdapter();
    default:
      return null;
  }
}
