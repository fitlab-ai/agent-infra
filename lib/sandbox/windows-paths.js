const WINDOWS_DRIVE_PATH_PATTERN = /^([A-Za-z]):[\\/](.*)$/;
const UNC_PATH_PATTERN = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;

export function isWindowsDrivePath(value) {
  return typeof value === 'string' && WINDOWS_DRIVE_PATH_PATTERN.test(value);
}

export function isUncPath(value) {
  return typeof value === 'string' && UNC_PATH_PATTERN.test(value);
}

export function windowsPathToWslPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }

  if (isUncPath(value)) {
    throw new Error(`UNC paths are not supported for WSL2 sandbox mounts: ${value}`);
  }

  const match = value.match(WINDOWS_DRIVE_PATH_PATTERN);
  if (!match) {
    return value.replace(/\\/g, '/');
  }

  const [, drive, rest] = match;
  const normalizedRest = rest.replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive.toLowerCase()}/${normalizedRest}`;
}

export function toEnginePath(engine, value) {
  if (engine !== 'wsl2') {
    return value;
  }

  return windowsPathToWslPath(value);
}
