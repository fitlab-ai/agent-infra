import type { PlatformCheckSnapshot } from './snapshots.ts';

export function checkStatusBucket(status: string): PlatformCheckSnapshot['bucket'] {
  const value = status.toLowerCase();
  if (['pass', 'success', 'successful', 'neutral'].includes(value)) return 'pass';
  if (['fail', 'failure', 'failed', 'error', 'timed_out', 'action_required'].includes(value)) return 'fail';
  if (['cancel', 'cancelled', 'canceled', 'skipped', 'stale'].includes(value)) return 'cancel';
  return 'pending';
}
