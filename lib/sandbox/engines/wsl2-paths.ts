import path from 'node:path';
import { selinuxLabelForMount } from './selinux.ts';

const WINDOWS_DRIVE_PATH_PATTERN = /^([A-Za-z]):[\\/](.*)$/;
const UNC_PATH_PATTERN = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;

export function hostJoin(basePath: string, ...segments: string[]): string {
  return basePath.startsWith('/') ? path.posix.join(basePath, ...segments) : path.join(basePath, ...segments);
}

export function isWindowsDrivePath(value: unknown): boolean {
  return typeof value === 'string' && WINDOWS_DRIVE_PATH_PATTERN.test(value);
}

export function isUncPath(value: unknown): boolean {
  return typeof value === 'string' && UNC_PATH_PATTERN.test(value);
}

export function windowsPathToWslPath(value: string): string {
  if (value.length === 0) {
    return value;
  }

  if (isUncPath(value)) {
    throw new Error(`UNC paths are not supported for WSL2 sandbox mounts: ${value}`);
  }

  const match = value.match(WINDOWS_DRIVE_PATH_PATTERN);
  if (!match) {
    return value.replace(/\\/g, '/');
  }

  const [, drive = '', rest = ''] = match;
  const normalizedRest = rest.replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive.toLowerCase()}/${normalizedRest}`;
}

export function toEnginePath(engine: string, value: string): string {
  if (engine !== 'wsl2') {
    return value;
  }

  return windowsPathToWslPath(value);
}

export function volumeArg(
  engine: string,
  hostPath: string,
  containerPath: string,
  suffix = '',
  options: { selinux?: 'shared' | 'none'; fs?: typeof import('node:fs'); platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): string {
  const { selinux = 'shared', ...selinuxOptions } = options;
  const flags = suffix.replace(/^:/, '').split(',').filter(Boolean);

  if (selinux !== 'none') {
    const label = selinuxLabelForMount(engine, selinuxOptions);
    if (label && !flags.includes(label)) {
      flags.push(label);
    }
  }

  const composedSuffix = flags.length > 0 ? `:${flags.join(',')}` : '';
  return `${toEnginePath(engine, hostPath)}:${containerPath}${composedSuffix}`;
}
