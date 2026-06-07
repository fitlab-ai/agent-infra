import { platform } from 'node:os';
import { createDarwinClipboardAdapter, type DarwinClipboardAdapter } from './darwin.ts';

export type ClipboardAdapter = DarwinClipboardAdapter;

export function createClipboardAdapter({
  platformName = platform()
}: { platformName?: NodeJS.Platform } = {}): ClipboardAdapter | null {
  switch (platformName) {
    case 'darwin':
      return createDarwinClipboardAdapter();
    case 'linux':
      // Future work: dispatch based on $WAYLAND_DISPLAY (wl-paste) or $DISPLAY (xclip);
      // see Issue #386 follow-up. Returning null disables the bridge for now.
      return null;
    case 'win32':
      // Future work: native Win32 clipboard reader. Returning null disables the bridge.
      return null;
    default:
      return null;
  }
}
