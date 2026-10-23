import test from 'node:test';
import assert from 'node:assert/strict';
import { runSummaryContentPipeline } from '../../../lib/platform/summary-content-pipeline.ts';

test('content pipeline corrects validated structure, revalidates, then renders', () => {
  const steps: string[] = [];
  const result = runSummaryContentPipeline({ missing: true }, {
    prepare: (value) => { steps.push('prepare'); return value; },
    validate: (value) => {
      steps.push('validate');
      const input = value as { required?: string };
      return typeof input.required === 'string'
        ? { ok: true as const, value: { required: input.required } }
        : { ok: false as const, error: new Error('required is missing') };
    },
    correct: (value, validation) => {
      steps.push(`correct:${validation.ok ? 'valid' : 'invalid'}`);
      return { ...(value as object), required: 'from source' };
    },
    render: (value) => { steps.push('render'); return value.required; }
  });

  assert.deepEqual(steps, ['prepare', 'validate', 'correct:invalid', 'validate', 'render']);
  assert.deepEqual(result, { content: { required: 'from source' }, rendered: 'from source' });
});

test('content pipeline does not render when source correction cannot satisfy structure', () => {
  assert.throws(() => runSummaryContentPipeline({}, {
    prepare: (value) => value,
    validate: () => ({ ok: false as const, error: new Error('required is missing') }),
    correct: (value) => value,
    render: () => assert.fail('invalid content must not render')
  }), /required is missing/u);
});
