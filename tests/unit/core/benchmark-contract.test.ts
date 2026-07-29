import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = process.cwd();
const SCHEMA_DIR = path.join(REPO_ROOT, 'lib', 'benchmark', 'schemas', 'v1.0.0');
const SCHEMA_FILES = [
  'common.schema.json',
  'subject.schema.json',
  'case-manifest.schema.json',
  'grader-result.schema.json',
  'run-manifest.schema.json'
] as const;
const TOP_LEVEL_SCHEMAS = SCHEMA_FILES.filter((file) => file !== 'common.schema.json');

type JsonObject = Record<string, any>;

function readJson(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRefs(entry, refs));
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') refs.push(entry);
    else collectRefs(entry, refs);
  }
  return refs;
}

function resolvePointer(document: unknown, fragment: string): unknown {
  if (fragment === '' || fragment === '#') return document;
  assert.ok(fragment.startsWith('#/'), `unsupported JSON pointer fragment: ${fragment}`);
  return fragment
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((value, part) => {
      assert.ok(value && typeof value === 'object' && part in value, `missing JSON pointer segment: ${part}`);
      return (value as JsonObject)[part];
    }, document);
}

test('benchmark schemas form a closed, versioned Draft-07 contract', () => {
  const documents = new Map<string, JsonObject>(
    SCHEMA_FILES.map((file) => [file, readJson(path.join(SCHEMA_DIR, file))])
  );
  const ids = new Set<string>();

  for (const [file, schema] of documents) {
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#', file);
    assert.equal(typeof schema.$id, 'string', file);
    assert.ok(schema.$id.endsWith(`/lib/benchmark/schemas/v1.0.0/${file}`), file);
    assert.equal(ids.has(schema.$id), false, `duplicate $id: ${schema.$id}`);
    ids.add(schema.$id);

    for (const ref of collectRefs(schema)) {
      const [relativeFile = '', rawFragment = ''] = ref.split('#', 2);
      assert.equal(/^[a-z][a-z0-9+.-]*:/i.test(relativeFile), false, `${file} uses non-local $ref ${ref}`);
      const targetName = relativeFile || file;
      const target = documents.get(targetName);
      assert.ok(target, `${file} references missing schema ${targetName}`);
      resolvePointer(target, rawFragment ? `#${rawFragment}` : '');
    }
  }

  const common = documents.get('common.schema.json')!;
  assert.deepEqual(
    Object.keys(common.definitions).sort(),
    [
      'caseIdentity',
      'checkSummary',
      'contractVersion',
      'datasetIdentity',
      'digest',
      'extensions',
      'semanticVersion'
    ]
  );

  for (const file of TOP_LEVEL_SCHEMAS) {
    const schema = documents.get(file)!;
    assert.equal(schema.type, 'object', file);
    assert.equal(schema.additionalProperties, false, file);
    assert.ok(schema.required.includes('contractVersion'), file);
    assert.equal(schema.properties.contractVersion.$ref, 'common.schema.json#/definitions/contractVersion', file);
    assert.equal(schema.properties.extensions.$ref, 'common.schema.json#/definitions/extensions', file);
  }
});

test('benchmark schemas encode result, repetition, and comparison invariants', () => {
  const subject = readJson(path.join(SCHEMA_DIR, 'subject.schema.json'));
  assert.deepEqual(subject.properties.executionMode.enum, [
    'direct-repair',
    'agent-infra-workflow',
    'custom'
  ]);
  assert.deepEqual(subject.properties.networkPolicy.properties.mode.enum, [
    'none',
    'allowlist',
    'unrestricted'
  ]);

  const grader = readJson(path.join(SCHEMA_DIR, 'grader-result.schema.json'));
  assert.deepEqual(grader.properties.status.enum, ['passed', 'failed', 'blocked']);
  assert.equal(grader.allOf.length, 3);

  const run = readJson(path.join(SCHEMA_DIR, 'run-manifest.schema.json'));
  assert.equal(run.properties.repetitionIndex.minimum, 1);
  assert.equal(run.properties.repetitionCount.minimum, 1);
  assert.ok(run.required.includes('comparisonGroupId'));
  assert.ok(run.required.includes('conditionsDigest'));
  assert.equal(run.oneOf.length, 2);
});

test('benchmark contract is published and linked from both documentation indexes', () => {
  const packageJson = readJson(path.join(REPO_ROOT, 'package.json'));
  assert.ok(packageJson.files.includes('lib/'));

  const links = [
    ['README.md', './docs/en/benchmark.md'],
    ['README.zh-CN.md', './docs/zh-CN/benchmark.md'],
    ['docs/en/README.md', './benchmark.md'],
    ['docs/zh-CN/README.md', './benchmark.md']
  ] as const;

  for (const [file, target] of links) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.ok(content.includes(`](${target})`), `${file} does not link ${target}`);
  }

  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'docs', 'en', 'benchmark.md')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'docs', 'zh-CN', 'benchmark.md')));
});
