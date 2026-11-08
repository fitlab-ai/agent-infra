import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifactCommand } from '../../../lib/task/artifact-command.ts';

const taskRef = '04';

test('artifact parser preserves parsed fields across option consumption', () => {
  assert.deepEqual(parseArtifactCommand([
    taskRef, 'init', '--artifact', 'a.md', '--locale', 'en', '--family', 'custom'
  ]), {
    taskRef, operation: 'init', family: 'custom', artifact: 'a.md', locale: 'en',
    reasonCode: undefined, sourceFinding: undefined, sourceArtifact: undefined, sourceSha256: undefined
  });
});

test('artifact parser preserves option errors and their precedence', () => {
  const cases: [string[], string][] = [
    [
      [taskRef, 'inspect', '--artifact', 'value'],
      "unknown option '--artifact'"
    ],
    [
      [taskRef, 'init', '--locale', 'bad', '--unknown'],
      "unknown option '--unknown'"
    ],
    [
      [taskRef, 'inspect', '--family'],
      "option '--family' requires a value"
    ],
    [
      [taskRef, 'inspect', '--family', ''],
      "option '--family' requires a value"
    ],
    [
      [taskRef, 'inspect', '--family', '--artifact'],
      "option '--family' requires a value"
    ],
    [
      [taskRef, 'inspect', '--family', 'a', '--family'],
      "duplicate option '--family'"
    ]
  ];
  for (const [args, message] of cases) assert.throws(() => parseArtifactCommand(args), { message });
});
