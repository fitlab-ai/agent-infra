import fs from 'node:fs';
import path from 'node:path';

import type { PlatformClient } from './context.ts';
import { resolvePlatformProviderContext } from './context.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus
} from './provider-bridge.ts';
import type {
  PlatformError,
  SecurityAlertKind,
  SecurityAlertSnapshot
} from './provider-contract.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';

type SecurityAlertOptions = {
  cwd?: string;
  client?: PlatformClient;
  platformType?: string;
};

type SecurityAlertResult = PlatformResult & {
  operation: 'read' | 'dismiss';
  alert: SecurityAlertSnapshot | null;
  data: SecurityAlertSnapshot['data'] | null;
};

function baseResult(
  operation: SecurityAlertResult['operation'],
  status: PlatformResult['status'],
  context: PlatformResult,
  overrides: Partial<SecurityAlertResult> = {}
): SecurityAlertResult {
  return {
    ...platformResult(status, {
      platform: context.platform,
      capabilities: context.capabilities,
      operations: context.operations,
      error: context.error,
      changed: false
    }),
    operation,
    alert: null,
    data: null,
    ...overrides
  };
}

function unsupported(providerType: string): PlatformError {
  return {
    code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
    message: `Platform '${providerType}' does not provide securityAlerts`,
    retryable: false
  };
}

function resultStatus(error: PlatformError): PlatformResult['status'] {
  return error.code === 'PLATFORM_CAPABILITY_UNSUPPORTED' ? 'degraded' : providerStatus(error);
}

function validKind(value: string | undefined): value is SecurityAlertKind {
  return value === 'dependabot' || value === 'code-scanning';
}

function validNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function unavailable(
  operation: SecurityAlertResult['operation'],
  context: PlatformResult,
  error?: PlatformError
): SecurityAlertResult {
  const status = context.status === 'blocked' || context.status === 'failed' ? context.status : 'degraded';
  return baseResult(operation, status, context, {
    error: error || context.error || { code: 'PLATFORM_CAPABILITY_UNSUPPORTED', message: 'Security alert operations are unavailable', retryable: false }
  });
}

async function readSecurityAlert(
  input: { kind: SecurityAlertKind; number: number },
  options: SecurityAlertOptions = {}
): Promise<SecurityAlertResult> {
  if (!validKind(input.kind)) return baseResult('read', 'failed', platformResult('failed'), {
    error: { code: 'SECURITY_KIND_INVALID', message: 'Alert kind must be dependabot or code-scanning', retryable: false }
  });
  if (!validNumber(input.number)) return baseResult('read', 'failed', platformResult('failed'), {
    error: { code: 'SECURITY_NUMBER_INVALID', message: 'Alert number must be a positive integer', retryable: false }
  });

  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client, platformType: options.platformType });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!loaded.ok || !context.platform.repository) return unavailable('read', context);
  const inspect = loaded.value.provider.securityAlerts?.inspect;
  if (!inspect) return unavailable('read', context, unsupported(loaded.value.provider.type));
  const result = await inspect({ context: providerOperationContext(loaded.value), kind: input.kind, number: input.number });
  if (!result.ok) return {
    ...baseResult('read', resultStatus(result.error), context),
    error: providerError(result.error, 'SECURITY_ALERT_READ_FAILED')
  };
  return {
    ...baseResult('read', 'applied', context, {
      alert: result.value,
      data: result.value.data,
      operations: [{ name: 'inspect-alert', status: 'applied', reasonCode: null }]
    }),
    changed: false,
    error: null
  };
}

async function dismissSecurityAlert(
  input: { kind: SecurityAlertKind; number: number; reason: string; comment: string },
  options: SecurityAlertOptions = {}
): Promise<SecurityAlertResult> {
  if (!validKind(input.kind)) return baseResult('dismiss', 'failed', platformResult('failed'), {
    error: { code: 'SECURITY_KIND_INVALID', message: 'Alert kind must be dependabot or code-scanning', retryable: false }
  });
  if (!validNumber(input.number)) return baseResult('dismiss', 'failed', platformResult('failed'), {
    error: { code: 'SECURITY_NUMBER_INVALID', message: 'Alert number must be a positive integer', retryable: false }
  });
  if (!input.reason || typeof input.comment !== 'string') return baseResult('dismiss', 'failed', platformResult('failed'), {
    error: { code: 'SECURITY_DISMISS_INPUT_INVALID', message: 'Dismissal reason and comment are required', retryable: false }
  });

  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client, platformType: options.platformType });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  if (!loaded.ok || !context.platform.repository) return unavailable('dismiss', context);
  const inspect = loaded.value.provider.securityAlerts?.inspect;
  const dismiss = loaded.value.provider.securityAlerts?.dismiss;
  if (!inspect || !dismiss) return unavailable('dismiss', context, unsupported(loaded.value.provider.type));
  const current = await inspect({ context: providerOperationContext(loaded.value), kind: input.kind, number: input.number });
  if (!current.ok) return {
    ...baseResult('dismiss', resultStatus(current.error), context),
    error: providerError(current.error, 'SECURITY_ALERT_READ_FAILED')
  };
  if (current.value.state === 'dismissed' || current.value.state === 'fixed') return {
    ...baseResult('dismiss', 'no-op', context, {
      alert: current.value,
      data: current.value.data,
      operations: [{ name: 'inspect-alert', status: 'no-op', reasonCode: 'ALREADY_CLOSED' }]
    }),
    error: null
  };
  if (current.value.state !== 'open') return {
    ...baseResult('dismiss', 'failed', context, {
      alert: current.value,
      data: current.value.data,
      operations: [{ name: 'inspect-alert', status: 'failed', reasonCode: 'INVALID_STATE' }]
    }),
    error: { code: 'SECURITY_RESPONSE_INVALID', message: 'The platform returned an alert without a valid state', retryable: false }
  };
  const changed = await dismiss({
    context: providerOperationContext(loaded.value),
    kind: input.kind,
    number: input.number,
    reason: input.reason,
    comment: input.comment,
    mutation: { idempotencyKey: `security-alert:dismiss:${input.kind}:${input.number}` }
  });
  if (!changed.ok) return {
    ...baseResult('dismiss', resultStatus(changed.error), context, {
      alert: current.value,
      data: current.value.data,
      operations: [{ name: 'dismiss-alert', status: 'failed', reasonCode: null }]
    }),
    error: providerError(changed.error, 'SECURITY_ALERT_DISMISS_FAILED')
  };
  return {
    ...baseResult('dismiss', changed.value.changed ? 'applied' : 'no-op', context, {
      operations: [{ name: 'dismiss-alert', status: changed.value.changed ? 'applied' : 'no-op', reasonCode: null }]
    }),
    changed: changed.value.changed,
    error: null
  };
}

function readCommentFile(commentFile: string, cwd = process.cwd()): { ok: true; value: string } | { ok: false; error: PlatformError } {
  try {
    const requested = path.resolve(cwd, commentFile);
    return { ok: true, value: fs.readFileSync(requested, 'utf8') };
  } catch {
    return { ok: false, error: { code: 'SECURITY_DISMISS_INPUT_INVALID', message: 'Dismissal comment file could not be read', retryable: false } };
  }
}

export { dismissSecurityAlert, readCommentFile, readSecurityAlert };
export type { SecurityAlertOptions, SecurityAlertResult };
