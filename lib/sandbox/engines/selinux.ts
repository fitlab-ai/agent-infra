// @ts-nocheck
import fs from 'node:fs';

const SELINUX_ENFORCE_PATH = '/sys/fs/selinux/enforce';
const detectionCache = new WeakMap();
const VALID_DISABLE_VALUES = new Set([undefined, '', '0', '1']);

function isDisabled(env) {
  return env?.AGENT_INFRA_SELINUX_DISABLE === '1';
}

function readEnforceFlag(fsImpl) {
  try {
    return fsImpl.readFileSync(SELINUX_ENFORCE_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function isSelinuxEnforcing(fsImpl, platform) {
  let cache = detectionCache.get(fsImpl);
  if (!cache) {
    cache = new Map();
    detectionCache.set(fsImpl, cache);
  }

  if (cache.has(platform)) {
    return cache.get(platform);
  }

  const enforcing = readEnforceFlag(fsImpl) === '1';
  cache.set(platform, enforcing);
  return enforcing;
}

export function selinuxLabelForMount(engine, options = {}) {
  const {
    fs: fsImpl = fs,
    platform = process.platform,
    env = process.env
  } = options;

  if (engine !== 'native' || platform !== 'linux') {
    return null;
  }
  if (isDisabled(env)) {
    return null;
  }
  if (!isSelinuxEnforcing(fsImpl, platform)) {
    return null;
  }

  return 'z';
}

export function validateSelinuxDisableEnv(env = process.env) {
  const value = env?.AGENT_INFRA_SELINUX_DISABLE;
  if (!VALID_DISABLE_VALUES.has(value)) {
    throw new Error('Invalid AGENT_INFRA_SELINUX_DISABLE value. Expected 1 to disable, or unset/0 for default.');
  }
}
