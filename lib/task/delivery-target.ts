import fs from 'node:fs';
import path from 'node:path';

export type DeliveryTarget = Readonly<{
  remote: string;
  baseRef: string;
}>;

export type DeliveryTargetBindingInput = Readonly<{
  defaults?: Partial<DeliveryTarget>;
  existing?: Partial<DeliveryTarget>;
  explicit?: Partial<DeliveryTarget>;
}>;

export type DeliveryTargetResult =
  | { ok: true; value: DeliveryTarget }
  | { ok: false; code: string; message: string };

export type DiffBaseResult =
  | { ok: true; diffBase: string }
  | { ok: false; code: string; message: string };

const REMOTE_RE = /^(?!-)(?!.*\.\.)(?!.*[~^:?*\\\s])[A-Za-z0-9._/-]+$/;
const REF_RE = /^(?!-)(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*[~^:?*\\\s])[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function validateRemote(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && REMOTE_RE.test(value);
}

function validateBaseRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('refs/') && REF_RE.test(value);
}

function invalid(field: string, value: unknown): DeliveryTargetResult {
  return { ok: false, code: 'DELIVERY_TARGET_INVALID', message: `${field} is invalid: ${String(value ?? '')}` };
}

function bindDeliveryTarget(input: DeliveryTargetBindingInput): DeliveryTargetResult {
  const remote = input.existing?.remote ?? input.explicit?.remote ?? input.defaults?.remote;
  const baseRef = input.existing?.baseRef ?? input.explicit?.baseRef ?? input.defaults?.baseRef;
  if (input.existing?.remote !== undefined && input.explicit?.remote !== undefined && input.existing.remote !== input.explicit.remote) {
    return { ok: false, code: 'DELIVERY_TARGET_CONFLICT', message: 'Explicit delivery remote does not match the task binding' };
  }
  if (input.existing?.baseRef !== undefined && input.explicit?.baseRef !== undefined && input.existing.baseRef !== input.explicit.baseRef) {
    return { ok: false, code: 'DELIVERY_TARGET_CONFLICT', message: 'Explicit delivery base ref does not match the task binding' };
  }
  if (!validateRemote(remote)) return invalid('delivery remote', remote);
  if (!validateBaseRef(baseRef)) return invalid('delivery base ref', baseRef);
  return { ok: true, value: { remote, baseRef } };
}

function readDeliveryDefaults(repoRoot: string): DeliveryTargetResult {
  try {
    const configPath = path.join(repoRoot, '.agents', '.airc.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    if (!config.delivery || typeof config.delivery !== 'object' || Array.isArray(config.delivery)) {
      return { ok: false, code: 'DELIVERY_CONFIG_INVALID', message: 'delivery config must declare remote and baseRef' };
    }
    const delivery = config.delivery as Record<string, unknown>;
    if (typeof delivery.remote !== 'string' || typeof delivery.baseRef !== 'string') {
      return { ok: false, code: 'DELIVERY_CONFIG_INVALID', message: 'delivery config must declare remote and baseRef' };
    }
    return bindDeliveryTarget({
      defaults: {
        remote: delivery.remote,
        baseRef: delivery.baseRef
      }
    });
  } catch (error) {
    return { ok: false, code: 'DELIVERY_CONFIG_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
}

function resolveDeliveryTarget(
  repoRoot: string,
  existing: Partial<DeliveryTarget> = {},
  explicit: Partial<DeliveryTarget> = {}
): DeliveryTargetResult {
  const defaults = readDeliveryDefaults(repoRoot);
  if (!defaults.ok) return defaults;
  return bindDeliveryTarget({ defaults: defaults.value, existing, explicit });
}

export {
  bindDeliveryTarget,
  readDeliveryDefaults,
  resolveDeliveryTarget,
  validateBaseRef,
  validateRemote
};
