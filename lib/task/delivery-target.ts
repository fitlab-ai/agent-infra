import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
    const delivery = config.delivery && typeof config.delivery === 'object' && !Array.isArray(config.delivery)
      ? config.delivery as Record<string, unknown>
      : {};
    return bindDeliveryTarget({
      defaults: {
        remote: typeof delivery.remote === 'string' ? delivery.remote : 'origin',
        baseRef: typeof delivery.baseRef === 'string' ? delivery.baseRef : 'main'
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

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function resolveTargetHead(repoRoot: string, target: DeliveryTarget): DeliveryTargetResult & { head?: string } {
  try {
    const output = gitText(repoRoot, ['ls-remote', '--refs', target.remote, `refs/heads/${target.baseRef}`]);
    const head = output.split(/\s+/)[0] ?? '';
    if (!/^[a-f0-9]{40}$/i.test(head)) {
      return { ok: false, code: 'DELIVERY_TARGET_UNAVAILABLE', message: `Delivery target ${target.remote}/${target.baseRef} is unavailable` };
    }
    try { gitText(repoRoot, ['cat-file', '-e', `${head}^{commit}`]); }
    catch {
      return { ok: false, code: 'DELIVERY_TARGET_OBJECT_MISSING', message: `Delivery target commit ${head} is not available locally` };
    }
    return { ok: true, value: target, head };
  } catch (error) {
    return { ok: false, code: 'DELIVERY_TARGET_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) };
  }
}

function resolveDiffBase(repoRoot: string, reviewedHead: string, targetHead: string): DiffBaseResult {
  try {
    const diffBase = gitText(repoRoot, ['merge-base', reviewedHead, targetHead]);
    if (!/^[a-f0-9]{40}$/i.test(diffBase)) {
      return { ok: false, code: 'DELIVERY_DIFF_BASE_UNAVAILABLE', message: 'Git returned an invalid diff base' };
    }
    return { ok: true, diffBase };
  } catch (error) {
    return { ok: false, code: 'DELIVERY_DIFF_BASE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) };
  }
}

export {
  bindDeliveryTarget,
  readDeliveryDefaults,
  resolveDeliveryTarget,
  resolveTargetHead,
  resolveDiffBase,
  validateBaseRef,
  validateRemote
};
