import fs from 'node:fs';
import os from 'node:os';

export type DetectHostTimezoneOptions = {
  platform?: NodeJS.Platform;
  readlink?: (targetPath: string) => string;
  env?: NodeJS.ProcessEnv;
};

const ZONEINFO_MARK = '/zoneinfo/';
const IANA_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

function safeTimezone(value: string | undefined): string | null {
  if (!value || !IANA_ZONE_RE.test(value)) {
    return null;
  }
  return value;
}

export function detectHostTimezone(options: DetectHostTimezoneOptions = {}): string | null {
  const platform = options.platform ?? os.platform();
  const env = options.env ?? process.env;
  if (env.TZ) {
    return safeTimezone(env.TZ);
  }

  if (platform !== 'darwin' && platform !== 'linux') {
    return null;
  }

  const readlink = options.readlink ?? fs.readlinkSync;
  try {
    const target = readlink('/etc/localtime');
    const idx = target.indexOf(ZONEINFO_MARK);
    if (idx < 0) {
      return null;
    }
    return safeTimezone(target.slice(idx + ZONEINFO_MARK.length));
  } catch {
    return null;
  }
}
