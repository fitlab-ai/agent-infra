import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findIssueCommentViolations,
  formatKnownNonUserTokens
} from '../../../lib/task/issue-comment-content.ts';

function locations(content: string) {
  return findIssueCommentViolations(content).map(({ kind, line, column, token }) => ({ kind, line, column, token }));
}

test('formats raw and escaped non-user tokens while preserving real mentions and email addresses', () => {
  assert.equal(formatKnownNonUserTokens('清晰度 @2x'), '清晰度 `@2x`');
  assert.equal(formatKnownNonUserTokens(String.raw`清晰度 \@2x`), '清晰度 `@2x`');
  assert.equal(formatKnownNonUserTokens('请联系 @alice 或 test@example.com'), '请联系 @alice 或 test@example.com');
});

test('formatting is idempotent and skips successfully closed code spans and fences', () => {
  const content = '已处理 `@2x`。\n```text\n@2x\n```';
  assert.equal(formatKnownNonUserTokens(content), content);
  assert.equal(formatKnownNonUserTokens(formatKnownNonUserTokens('raw @2x')), 'raw `@2x`');
});

test('reports raw and escaped non-user tokens outside successful code spans', () => {
  assert.deepEqual(locations('raw @2x\nescaped \\@2x'), [
    { kind: 'non-user-token', line: 1, column: 5, token: '@2x' },
    { kind: 'non-user-token', line: 2, column: 10, token: '@2x' }
  ]);
  assert.deepEqual(locations('`@2x`\n```\n@2x\n```'), []);
});

test('continues scanning after an unclosed or mismatched inline delimiter', () => {
  assert.deepEqual(locations('literal ` then @2x and [x](/workspace/file.md)'), [
    { kind: 'non-user-token', line: 1, column: 16, token: '@2x' },
    { kind: 'local-link', line: 1, column: 24, token: '/workspace/file.md' }
  ]);
  assert.deepEqual(locations('`literal `` then @2x'), [
    { kind: 'non-user-token', line: 1, column: 18, token: '@2x' }
  ]);
});

test('only successfully closed fences protect their contents', () => {
  assert.deepEqual(locations('```text\n@2x\n```'), []);
  assert.deepEqual(locations('```text\n@2x'), [
    { kind: 'non-user-token', line: 2, column: 1, token: '@2x' }
  ]);
  assert.deepEqual(locations('~~~\n[x](/workspace/file.md)\n~~~'), []);
  assert.deepEqual(locations('~~~\n[x](/workspace/file.md)'), [
    { kind: 'local-link', line: 2, column: 1, token: '/workspace/file.md' }
  ]);
});

test('does not protect content after an invalid backtick fence opener', () => {
  assert.deepEqual(locations('``` info ` bad\n@2x\n```'), [
    { kind: 'non-user-token', line: 2, column: 1, token: '@2x' }
  ]);
  assert.deepEqual(locations('``` info ` bad\n[x](/workspace/file.md)\n```'), [
    { kind: 'local-link', line: 2, column: 1, token: '/workspace/file.md' }
  ]);
  assert.deepEqual(locations('~~~ info ` allowed\n@2x\n~~~'), []);
});

test('rejects canonical artifact and local path destinations but keeps valid links', () => {
  const content = [
    '[artifact](analysis.md)',
    '[workspace](/workspace/file.md)',
    '[user](/Users/alice/file.md)',
    '[temp](C:\\Temp\\file.md)',
    '[external](https://example.com/analysis.md)',
    '[anchor](#analysis)',
    '[docs](docs/guide.md)'
  ].join('\n');
  assert.deepEqual(locations(content), [
    { kind: 'canonical-artifact-link', line: 1, column: 1, token: 'analysis.md' },
    { kind: 'local-link', line: 2, column: 1, token: '/workspace/file.md' },
    { kind: 'local-link', line: 3, column: 1, token: '/Users/alice/file.md' },
    { kind: 'local-link', line: 4, column: 1, token: 'C:\\Temp\\file.md' }
  ]);
});

test('keeps non-user tokens inside valid URL contexts unchanged', () => {
  const content = [
    '[asset](https://example.com/@2x)',
    'https://example.com/@2x',
    '<a href="https://example.com/@2x">external</a>',
    '[https://example.com/@2x](#anchor)'
  ].join('\n');
  assert.equal(formatKnownNonUserTokens(content), content);
  assert.deepEqual(locations(content), []);
});

test('parses quoted HTML attributes and checks every local destination', () => {
  const quotedAttribute = '<a title="x>y" href="/workspace/file.md">workspace</a>';
  const multipleAttributes = '<img href="https://example.com/x" src="/workspace/file.png">';
  assert.deepEqual(locations(quotedAttribute), [
    { kind: 'local-link', line: 1, column: quotedAttribute.indexOf('href') + 1, token: '/workspace/file.md' }
  ]);
  assert.deepEqual(locations(multipleAttributes), [
    { kind: 'local-link', line: 1, column: multipleAttributes.indexOf('src') + 1, token: '/workspace/file.png' }
  ]);
  assert.deepEqual(locations('[home](~/secret.md)\n[root](/root/secret.md)'), [
    { kind: 'local-link', line: 1, column: 1, token: '~/secret.md' },
    { kind: 'local-link', line: 2, column: 1, token: '/root/secret.md' }
  ]);
});

test('uses the same destination policy for reference links and HTML attributes', () => {
  const content = [
    '[artifact][report]',
    '[report]: plan-r2.md',
    '<a href="/workspace/file.md">workspace</a>',
    '<a href="https://example.com/file.md">external</a>',
    '<!-- [ignored](/workspace/file.md) @2x -->'
  ].join('\n');
  assert.deepEqual(locations(content), [
    { kind: 'canonical-artifact-link', line: 2, column: 1, token: 'plan-r2.md' },
    { kind: 'local-link', line: 3, column: 4, token: '/workspace/file.md' }
  ]);
});

test('scans visible inline-link labels while leaving their destinations to the link policy', () => {
  const violations = findIssueCommentViolations('[@2x](https://example.com/@2x)');
  assert.deepEqual(violations.map((item) => ({ kind: item.kind, column: item.column, token: item.token })), [
    { kind: 'non-user-token', column: 2, token: '@2x' }
  ]);
});
