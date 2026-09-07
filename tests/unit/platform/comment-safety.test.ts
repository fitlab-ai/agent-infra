import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_MARKER_PATTERN,
  escapeHtmlAttribute,
  escapeHtmlText,
  escapeMarkdownLiteral,
  renderSafeCodeFence,
  sanitizeMarkdownDocument,
  splitDocumentPlaceholder
} from '../../../lib/platform/comment-safety.ts';

test('sanitizes normal Markdown while preserving links and lists', () => {
  const result = sanitizeMarkdownDocument('- [link](https://example.test)\n\n<https://example.test>\n\n1. item\n');
  assert.deepEqual(result, { ok: true, value: '- [link](https://example.test)\n\n<https://example.test>\n\n1. item\n' });
});

test('encodes raw HTML and comments outside fenced code', () => {
  const result = sanitizeMarkdownDocument('<ScRiPt>alert(1)</ScRiPt>\n<!-- hidden -->\n');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, '&lt;ScRiPt&gt;alert(1)&lt;/ScRiPt&gt;\n&lt;!-- hidden --&gt;\n');
  }
});

test('preserves fenced examples but protects reserved control markers', () => {
  const input = '```html\n<!-- ordinary example -->\n<!-- sync-pr:TASK-1:summary -->\n<div>example</div>\n```\n';
  const result = sanitizeMarkdownDocument(input, { reservedMarkers: [CONTROL_MARKER_PATTERN] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.value, /<!-- ordinary example -->/);
    assert.match(result.value, /&lt;!-- sync-pr:TASK-1:summary --&gt;/);
    assert.match(result.value, /<div>example<\/div>/);
  }
});

test('fails closed for malformed HTML candidates and unclosed fences', () => {
  const malformedTag = sanitizeMarkdownDocument('<div\n');
  assert.equal(malformedTag.ok, false);
  if (!malformedTag.ok) assert.equal(malformedTag.error.code, 'COMMENT_DOCUMENT_INVALID');

  const unclosedFence = sanitizeMarkdownDocument('~~~\nexample\n');
  assert.equal(unclosedFence.ok, false);
  if (!unclosedFence.ok) assert.equal(unclosedFence.error.code, 'COMMENT_DOCUMENT_INVALID');
});

test('sanitization and safe fences are idempotent and UTF-8 safe', () => {
  const input = '中文🙂 &lt;!-- sync-pr:TASK-1:summary --&gt;\n';
  const first = sanitizeMarkdownDocument(input, { reservedMarkers: [CONTROL_MARKER_PATTERN] });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = sanitizeMarkdownDocument(first.value, { reservedMarkers: [CONTROL_MARKER_PATTERN] });
  assert.deepEqual(second, first);

  const fenced = renderSafeCodeFence('line ```\n<!-- sync-pr:TASK-1:summary -->\n', 'yaml', [CONTROL_MARKER_PATTERN]);
  assert.match(fenced, /````yaml/);
  assert.match(fenced, /&lt;!-- sync-pr:TASK-1:summary --&gt;/);
  assert.ok(Buffer.byteLength(fenced, 'utf8') > 0);
});

test('splits exactly one canonical placeholder only when it is outside fences and comments', () => {
  const placeholder = '<!-- canonical-pr-change-report -->';
  const split = splitDocumentPlaceholder(`Summary\n${placeholder}\n`, placeholder);
  assert.deepEqual(split, { ok: true, value: { prefix: 'Summary\n', suffix: '\n' } });

  for (const invalid of [
    `Summary\n${placeholder}\n${placeholder}`,
    `\`\`\`\n${placeholder}\n\`\`\``,
    `<!-- wrapper ${placeholder} -->`
  ]) {
    const result = splitDocumentPlaceholder(invalid, placeholder);
    assert.equal(result.ok, false);
  }
});

test('escapes HTML, attributes, and Markdown literal values', () => {
  assert.equal(escapeHtmlText(`<x a="b"> & 'q'`), '&lt;x a=&quot;b&quot;&gt; &amp; &#39;q&#39;');
  assert.equal(escapeHtmlAttribute(`a"b'&<>`), 'a&quot;b&#39;&amp;&lt;&gt;');
  assert.equal(escapeMarkdownLiteral('a *b* [c] <d>'), 'a \\*b\\* \\[c\\] \\<d\\>');
});
