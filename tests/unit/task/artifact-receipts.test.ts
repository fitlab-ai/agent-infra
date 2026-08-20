import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ArtifactReceiptError,
  parseArtifactReceipts,
  receiptForOutput,
  sha256Bytes,
  upsertArtifactReceipt
} from '../../../lib/task/artifact-receipts.ts';

const RECEIPT = {
  event: 'review-plan.completed' as const,
  output: 'review-plan.md',
  input: 'plan.md',
  inputSha256: sha256Bytes(Buffer.from('plan\n')),
  completedAt: '2026-08-19 20:00:00+00:00'
};

test('sha256Bytes hashes exact bytes and preserves newline sensitivity', () => {
  assert.equal(sha256Bytes(Buffer.from('plan\n')), '1b4025dc7b8d27cf38df85e77b20ed44a00851a2c28b338560560d85deded8e3');
  assert.notEqual(sha256Bytes(Buffer.from('plan\r\n')), sha256Bytes(Buffer.from('plan\n')));
});

test('receipt upsert creates a portable task section and parses it back', () => {
  const content = '# Task\n';
  const mutation = upsertArtifactReceipt(content, RECEIPT);
  const updated = `${content}\n## ${mutation.heading}\n\n${mutation.body}\n`;
  const parsed = parseArtifactReceipts(updated);

  assert.equal(parsed.present, true);
  assert.deepEqual(receiptForOutput(updated, 'review-plan.md'), RECEIPT);
});

test('receipt parsing fails closed for invalid digest and duplicate output', () => {
  const invalid = `## 产物生命周期收据\n\n| event | output | input | input_sha256 | completed_at |\n|---|---|---|---|---|\n| review-plan.completed | review-plan.md | plan.md | invalid | 2026-08-19 20:00:00+00:00 |\n`;
  assert.throws(() => parseArtifactReceipts(invalid), ArtifactReceiptError);

  const first = upsertArtifactReceipt('# Task\n', RECEIPT);
  const withSection = `## ${first.heading}\n\n${first.body}\n`;
  const duplicate = `${withSection}| review-plan.completed | review-plan.md | plan.md | ${RECEIPT.inputSha256} | ${RECEIPT.completedAt} |\n`;
  assert.throws(() => parseArtifactReceipts(duplicate), ArtifactReceiptError);
});

test('receipt parsing accepts multiple rounds but rejects noncanonical and mismatched identities', () => {
  const first = upsertArtifactReceipt('# Task\n', RECEIPT);
  const second = upsertArtifactReceipt(`## ${first.heading}\n\n${first.body}\n`, {
    ...RECEIPT,
    output: 'review-plan-r2.md',
    input: 'plan-r2.md',
    inputSha256: 'b'.repeat(64)
  });
  const content = `## ${second.heading}\n\n${second.body}\n`;
  assert.equal(parseArtifactReceipts(content).rows.length, 2);
  assert.throws(() => upsertArtifactReceipt('# Task\n', {
    ...RECEIPT,
    output: 'review-plan-r1.md'
  }), ArtifactReceiptError);
  assert.throws(() => upsertArtifactReceipt('# Task\n', {
    ...RECEIPT,
    output: 'review-code.md',
    input: 'code.md'
  }), ArtifactReceiptError);
});

test('receipt identity accepts canonical double- and triple-digit rounds', () => {
  for (const round of [10, 19, 100, 200]) {
    assert.doesNotThrow(() => upsertArtifactReceipt('# Task\n', {
      ...RECEIPT,
      output: `review-plan-r${round}.md`,
      input: `plan-r${round}.md`
    }));
  }
  assert.throws(() => upsertArtifactReceipt('# Task\n', {
    ...RECEIPT,
    output: 'review-plan-r01.md',
    input: 'plan-r01.md'
  }), ArtifactReceiptError);
});

test('receipt identity enforces the canonical safe-integer round boundary', () => {
  const maxSafeRound = Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(() => upsertArtifactReceipt('# Task\n', {
    ...RECEIPT,
    output: `review-plan-r${maxSafeRound}.md`,
    input: `plan-r${maxSafeRound}.md`
  }));
  assert.throws(() => upsertArtifactReceipt('# Task\n', {
    ...RECEIPT,
    output: `review-plan-r${maxSafeRound + 1}.md`,
    input: `plan-r${maxSafeRound + 1}.md`
  }), ArtifactReceiptError);
});

test('receipt upsert rejects different evidence for an existing output', () => {
  const first = upsertArtifactReceipt('# Task\n', RECEIPT);
  const content = `## ${first.heading}\n\n${first.body}\n`;
  assert.throws(() => upsertArtifactReceipt(content, {
    ...RECEIPT,
    inputSha256: 'f'.repeat(64)
  }), ArtifactReceiptError);
});
