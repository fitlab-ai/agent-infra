import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrSummaryContent, renderPrSummaryContent } from '../../../lib/platform/pr-summary-content.ts';

const content = {
  overview: 'Implemented structured summaries.',
  tests: { state: 'not-started', detail: 'CI has not started.' },
  review: { state: 'not-observed', detail: 'No remote review was observed.' },
  manualValidation: { state: 'pending', detail: 'Manual validation is pending.' },
  humanDecisions: { open: 0, resolved: 0, detail: 'No human decisions are recorded.' },
  risks: 'Risks are documented in the implementation report.'
};

test('PR summary structure accepts truthful not-yet-run states and zero counts', () => {
  assert.deepEqual(parsePrSummaryContent(content), content);
  const rendered = renderPrSummaryContent(content);
  assert.match(rendered, /not-started/);
  assert.match(rendered, /not-observed/);
  assert.match(rendered, /未解决：0；已解决：0/);
  assert.match(rendered, /canonical-pr-change-report/);
});

test('PR manual-validation renderer preserves none and unavailable states', () => {
  const none = renderPrSummaryContent({ ...content, manualValidation: { state: 'none', detail: 'The canonical task facts mark manual validation as not applicable.' } });
  const unavailable = renderPrSummaryContent({ ...content, manualValidation: { state: 'unavailable', detail: 'The existing validation source could not be read.' } });
  assert.match(none, /### ✅ 无需人工校验[\s\S]*?状态：none/u);
  assert.match(unavailable, /### ⚠️ 人工校验状态不可用[\s\S]*?状态：unavailable/u);
});

test('PR summary structure rejects missing or invalid fields', () => {
  assert.throws(() => parsePrSummaryContent({ ...content, risks: ' ' }), /risks/);
  assert.throws(() => parsePrSummaryContent({ ...content, humanDecisions: { open: -1, resolved: 0, detail: 'x' } }), /non-negative/);
});
