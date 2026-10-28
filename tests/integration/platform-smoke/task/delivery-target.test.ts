import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  bindDeliveryTarget,
  readDeliveryDefaults,
  validateBaseRef,
  validateRemote
} from '../../../../lib/task/delivery-target.ts';
import { classifyDeliveryState } from '../../../../lib/task/delivery.ts';
import { extractReviewTargetHead, extractReviewedHead } from '../../../../lib/task/review-fingerprint.ts';
import { createTempDir } from '../../../helpers.ts';

test('delivery target binding prefers explicit values only before a task is bound', () => {
  const result = bindDeliveryTarget({
    defaults: { remote: 'origin', baseRef: 'main' },
    explicit: { remote: 'upstream', baseRef: 'release/next' }
  });
  assert.deepEqual(result, { ok: true, value: { remote: 'upstream', baseRef: 'release/next' } });
});

test('delivery target binding rejects changes after a task is bound', () => {
  const result = bindDeliveryTarget({
    defaults: { remote: 'origin', baseRef: 'main' },
    existing: { remote: 'origin', baseRef: 'main' },
    explicit: { remote: 'origin', baseRef: 'release' }
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'DELIVERY_TARGET_CONFLICT');
});

test('delivery defaults require an explicit project configuration', () => {
  const root = createTempDir('delivery-target-config-');
  try {
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{}\n');
    const result = readDeliveryDefaults(root);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'DELIVERY_CONFIG_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('delivery target validators reject ambiguous refs and accept nested branch refs', () => {
  assert.equal(validateRemote('origin'), true);
  assert.equal(validateRemote('https://example.test/repo'), false);
  assert.equal(validateBaseRef('release/2026'), true);
  assert.equal(validateBaseRef('../main'), false);
  assert.equal(validateBaseRef('refs/heads/main'), false);
});

test('delivery classifies only the last delivered remote head as safely replaceable', () => {
  const local = 'a'.repeat(40);
  assert.deepEqual(classifyDeliveryState(local, null, null), { state: 'absent', shouldPush: true });
  assert.deepEqual(classifyDeliveryState(local, local, null), { state: 'same', shouldPush: false });
  assert.deepEqual(classifyDeliveryState(local, 'b'.repeat(40), 'b'.repeat(40)), { state: 'known-old', shouldPush: true });
  assert.deepEqual(classifyDeliveryState(local, 'c'.repeat(40), 'b'.repeat(40)), { state: 'unknown-drift', shouldPush: false });
});

test('review evidence exposes immutable target and reviewed heads separately', () => {
  const content = [
    '**审查目标提交**：`' + 'a'.repeat(40) + '`',
    '**审查差异基线**：`' + 'b'.repeat(40) + '`',
    '**审查已检视提交**：`' + 'c'.repeat(40) + '`'
  ].join('\n');
  assert.equal(extractReviewTargetHead(content), 'a'.repeat(40));
  assert.equal(extractReviewedHead(content), 'c'.repeat(40));
});
