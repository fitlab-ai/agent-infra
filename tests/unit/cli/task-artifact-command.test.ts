import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifactCommand } from '../../../lib/task/artifact-command.ts';

const taskRef = '04';
const operations = ['inspect', 'init', 'preflight', 'finalize-local'] as const;

test('artifact parser preserves every returned key for all operations', () => {
  for (const operation of operations) {
    const args = [taskRef, operation, '--family', 'analysis'];
    if (operation !== 'inspect') args.push('--artifact', 'analysis.md');
    assert.deepEqual(parseArtifactCommand(args), {
      taskRef, operation, family: 'analysis',
      artifact: operation === 'inspect' ? '' : 'analysis.md',
      locale: undefined, reasonCode: undefined,
      sourceFinding: undefined, sourceArtifact: undefined, sourceSha256: undefined
    });
  }
});

test('artifact parser preserves locale, all reasons, and source values', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    assert.deepEqual(parseArtifactCommand([taskRef, 'init', '--artifact', 'a.md', '--locale', locale, '--family', 'custom']), {
      taskRef, operation: 'init', family: 'custom', artifact: 'a.md', locale,
      reasonCode: undefined, sourceFinding: undefined, sourceArtifact: undefined, sourceSha256: undefined
    });
  }
  for (const reasonCode of ['user-request', 'new-requirement', 'upstream-fact-doubt', 'review-finding', 'manual-review-supplement', 'retry', 'validation-rerun']) {
    assert.deepEqual(parseArtifactCommand([taskRef, 'inspect', '--source-finding', '-id', '--family', ' custom ',
      '--source-artifact', 'a.md', '--source-sha256', 'not-a-hash', '--reason-code', reasonCode]), {
      taskRef, operation: 'inspect', family: ' custom ', artifact: '', locale: undefined,
      reasonCode, sourceFinding: '-id', sourceArtifact: 'a.md', sourceSha256: 'not-a-hash'
    });
  }
});

test('artifact parser rejects options outside each operation whitelist', () => {
  const rejected = [
    ['inspect', '--artifact'], ['inspect', '--locale'],
    ['init', '--reason-code'], ['init', '--source-finding'], ['init', '--source-artifact'], ['init', '--source-sha256'],
    ['preflight', '--locale'], ['preflight', '--reason-code'], ['preflight', '--source-finding'],
    ['preflight', '--source-artifact'], ['preflight', '--source-sha256'],
    ['finalize-local', '--locale'], ['finalize-local', '--reason-code'], ['finalize-local', '--source-finding'],
    ['finalize-local', '--source-artifact'], ['finalize-local', '--source-sha256']
  ];
  for (const [operation, flag] of rejected) {
    assert.throws(() => parseArtifactCommand([taskRef, operation!, flag!, 'value']), {
      message: `unknown option '${flag}'`
    });
  }
});

test('artifact parser preserves operand and required-field error precedence', () => {
  const cases: [string[], string][] = [
    [[], 'task ref and a supported artifact operation are required'],
    [['', 'inspect'], 'task ref and a supported artifact operation are required'],
    [[taskRef], 'task ref and a supported artifact operation are required'],
    [[taskRef, 'invalid', '--unknown'], 'task ref and a supported artifact operation are required'],
    [[taskRef, 'inspect'], "option '--family' is required"],
    [[taskRef, 'init'], "option '--family' is required"],
    [[taskRef, 'init', '--family', 'analysis'], "option '--artifact' is required"],
    [[taskRef, 'preflight', '--family', 'analysis'], "option '--artifact' is required"],
    [[taskRef, 'finalize-local', '--family', 'analysis'], "option '--artifact' is required"],
    [[taskRef, 'init', '--locale', 'bad'], "option '--family' is required"],
    [[taskRef, 'init', '--family', 'analysis', '--locale', 'bad'], "option '--artifact' is required"],
    [[taskRef, 'inspect', '--reason-code', 'bad'], "option '--family' is required"],
    [[taskRef, 'init', '--locale', 'bad', '--unknown'], "unknown option '--unknown'"],
    [[taskRef, 'inspect', '--reason-code', 'bad', '--unknown'], "unknown option '--unknown'"],
    [[taskRef, 'init', '--family', 'a', '--artifact', 'a.md', '--locale', 'bad'], "option '--locale' must be 'zh-CN' or 'en'"],
    [[taskRef, 'inspect', '--family', 'a', '--reason-code', 'bad'], "option '--reason-code' is invalid"]
  ];
  for (const [args, message] of cases) assert.throws(() => parseArtifactCommand(args), { message });
});

test('artifact parser validates unknown, duplicate, and missing values in consumption order', () => {
  for (const operation of operations) {
    const prefix = [taskRef, operation];
    for (const suffix of [[], [''], ['--artifact']]) {
      assert.throws(() => parseArtifactCommand([...prefix, '--family', ...suffix]), {
        message: "option '--family' requires a value"
      });
      assert.throws(() => parseArtifactCommand([...prefix, '--family', 'a', '--family', ...suffix]), {
        message: "duplicate option '--family'"
      });
    }
    for (const flag of ['--unknown', '--family=a', 'positional', '-x']) {
      assert.throws(() => parseArtifactCommand([...prefix, flag]), { message: `unknown option '${flag}'` });
    }
  }
  const options = [
    ['inspect', '--reason-code', 'retry'], ['inspect', '--source-finding', 'F-1'],
    ['inspect', '--source-artifact', 'a.md'], ['inspect', '--source-sha256', 'hash'],
    ['init', '--artifact', 'a.md'], ['init', '--locale', 'en']
  ];
  for (const [operation, flag, value] of options) {
    assert.throws(() => parseArtifactCommand([taskRef, operation!, flag!]), { message: `option '${flag}' requires a value` });
    assert.throws(() => parseArtifactCommand([taskRef, operation!, flag!, value!, flag!]), { message: `duplicate option '${flag}'` });
  }
});
