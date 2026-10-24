import test from 'node:test';
import assert from 'node:assert/strict';
import { runSummaryContentPipeline } from '../../../lib/platform/summary-content-pipeline.ts';

test('content pipeline validates, always corrects, revalidates, then renders', () => {
  const steps: string[] = [];
  let validations = 0;
  const result = runSummaryContentPipeline({ missing: true }, {
    validate: (value) => {
      validations += 1;
      steps.push(`validate:${validations}`);
      const input = value as { required?: string };
      if (typeof input.required !== 'string') throw new Error('required is missing');
      return { required: input.required };
    },
    correct: (value) => {
      steps.push('correct');
      return { ...(value as object), required: 'from source' };
    },
    render: (value) => { steps.push('render'); return value.required; }
  });

  assert.deepEqual(steps, ['validate:1', 'correct', 'validate:2', 'render']);
  assert.deepEqual(result, { content: { required: 'from source' }, rendered: 'from source' });
});

test('content pipeline does not render when source correction cannot satisfy structure', () => {
  assert.throws(() => runSummaryContentPipeline({}, {
    validate: () => { throw new Error('required is missing'); },
    correct: (value) => value,
    render: () => assert.fail('invalid content must not render')
  }), /required is missing/u);
});
