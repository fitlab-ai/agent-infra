import test from 'node:test';
import assert from 'node:assert/strict';

import { findIssueCommentViolations } from '../../../lib/task/issue-comment-content.ts';

function locations(content: string) {
  return findIssueCommentViolations(content).map(({ kind, line, column, token }) => ({ kind, line, column, token }));
}

test('leaves @ content to the source author without classifying it as a violation', () => {
  assert.deepEqual(locations('清晰度 @2x\nescaped \\@2x\n请联系 @alice 或 test@example.com'), []);
  assert.deepEqual(locations('`@2x`\n```text\n@2x\n```'), []);
});

test('continues scanning after an unclosed or mismatched inline delimiter', () => {
  assert.deepEqual(locations('literal ` then @2x and [x](/workspace/file.md)'), [
    { kind: 'local-link', line: 1, column: 24, token: '/workspace/file.md' }
  ]);
  assert.deepEqual(locations('`literal `` then @2x'), []);
});

test('only successfully closed fences protect their contents', () => {
  assert.deepEqual(locations('```text\n@2x\n```'), []);
  assert.deepEqual(locations('```text\n@2x'), [
  ]);
  assert.deepEqual(locations('~~~\n[x](/workspace/file.md)\n~~~'), []);
  assert.deepEqual(locations('~~~\n[x](/workspace/file.md)'), [
    { kind: 'local-link', line: 2, column: 1, token: '/workspace/file.md' }
  ]);
});

test('does not protect content after an invalid backtick fence opener', () => {
  assert.deepEqual(locations('``` info ` bad\n@2x\n```'), [
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

test('leaves @ content inside valid URL contexts unchanged', () => {
  const content = [
    '[asset](https://example.com/@2x)',
    'https://example.com/@2x',
    '<a href="https://example.com/@2x">external</a>',
    '[https://example.com/@2x](#anchor)'
  ].join('\n');
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

test('does not hide tokens inside malformed HTML-like fragments', () => {
  assert.deepEqual(locations('<broken\n@2x>'), []);
  assert.deepEqual(locations('<@2x>'), []);
});

test('rejects macOS temporary directory destinations', () => {
  const content = '[private-temp](/private/tmp/secret.md)\n[mac-temp](/var/folders/zz/secret.md)';
  assert.deepEqual(locations(content), [
    { kind: 'local-link', line: 1, column: 1, token: '/private/tmp/secret.md' },
    { kind: 'local-link', line: 2, column: 1, token: '/var/folders/zz/secret.md' }
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
  assert.deepEqual(violations, []);
});
