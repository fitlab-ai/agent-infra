#!/usr/bin/env node

import path from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';

const EVENT_NAMES = ['test:complete', 'test:fail', 'test:pass', 'test:start', 'test:summary'];

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function normalizeFile(value, cwd) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const withoutScheme = value.startsWith('file://') ? fileURLToPath(value) : value;
  return path.resolve(cwd, withoutScheme);
}

function displayPath(file, cwd, mode) {
  let relative = normalizeSlashes(path.relative(cwd, file));
  if (mode === 'compiled' && relative.startsWith('dist/')) {
    relative = relative.slice('dist/'.length);
    if (relative.endsWith('.js')) relative = `${relative.slice(0, -3)}.ts`;
  }
  return relative;
}

function identityKey(file, nesting, name) {
  return `${file}\u0000${nesting}\u0000${name}`;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function eventKind(data) {
  if (!data.details || typeof data.details !== 'object') return null;
  return data.details.type === 'suite' ? 'suite' : 'test';
}

function eventFlags(data) {
  return {
    skip: hasOwn(data, 'skip') ? data.skip : undefined,
    todo: hasOwn(data, 'todo') ? data.todo : undefined
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFileWrapper(file, name, cwd) {
  if (typeof name !== 'string' || !name) return false;
  const display = name.startsWith('file://') ? fileURLToPath(name) : name;
  return path.resolve(cwd, display) === file;
}

function createCollector(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const mode = options.mode ?? 'compiled';
  const errors = [];
  const states = new Map();
  let aggregateSummary;

  function fail(message) {
    errors.push(message);
  }

  function stateFor(file) {
    let state = states.get(file);
    if (!state) {
      state = { file, roots: [], nodes: [], pending: new Map(), stack: [], summaries: [] };
      states.set(file, state);
    }
    return state;
  }

  function locate(data, label) {
    const file = normalizeFile(data?.file, cwd);
    if (!file) {
      fail(`${label} is missing file`);
      return null;
    }
    const nesting = data?.nesting;
    const name = data?.name;
    if (!Number.isInteger(nesting) || nesting < 0) fail(`${label} has invalid nesting`);
    if (typeof name !== 'string') fail(`${label} is missing name`);
    return { file, nesting, name: String(name) };
  }

  function checkIdentity(node, located, label) {
    if (node.file !== located.file || node.nesting !== located.nesting || node.name !== located.name) {
      fail(`${label} identity conflicts with ${node.name}`);
    }
  }

  function bindKind(node, data, label) {
    const kind = eventKind(data);
    if (!kind) {
      fail(`${label} is missing details`);
      return;
    }
    if (node.kind && node.kind !== kind) fail(`${label} kind conflicts with ${node.kind}`);
    node.kind = kind;
  }

  function bindMetadata(node, data, label) {
    const flags = eventFlags(data);
    if (!node.flags) node.flags = flags;
    else if (!sameValue(node.flags, flags)) fail(`${label} skip/todo metadata conflicts`);
    if (node.testNumber !== undefined && node.testNumber !== data.testNumber) {
      fail(`${label} testNumber conflicts`);
    }
    if (node.testNumber === undefined) node.testNumber = data.testNumber;
  }

  function attachComplete(node, data, located) {
    if (node.complete) {
      fail(`duplicate test:complete for ${node.name}`);
      return;
    }
    checkIdentity(node, located, 'test:complete');
    if (!data.details || typeof data.details.passed !== 'boolean') fail(`test:complete for ${node.name} is missing passed`);
    bindKind(node, data, 'test:complete');
    bindMetadata(node, data, 'test:complete');
    if (node.result && node.result.passed !== data.details?.passed) {
      fail(`test:complete result conflicts for ${node.name}`);
    }
    node.complete = data;
  }

  function candidates(state, located, includeCompleted = true) {
    return state.nodes.filter((node) => node.nesting === located.nesting
      && node.name === located.name
      && (includeCompleted || !node.complete));
  }

  function handleStart(data) {
    const located = locate(data, 'test:start');
    if (!located) return;
    const state = stateFor(located.file);
    if (located.nesting === 0 && isFileWrapper(located.file, located.name, cwd)) return;
    const parent = located.nesting === 0 ? undefined : state.stack[located.nesting - 1];
    if (located.nesting > 0 && !parent) fail(`test:start parent is missing for ${located.name}`);
    state.stack = state.stack.slice(0, located.nesting);
    const siblings = parent ? parent.children : state.roots;
    const node = {
      file: located.file,
      nesting: located.nesting,
      name: located.name,
      kind: null,
      siblingOrdinal: siblings.length + 1,
      parent,
      children: [],
      complete: null,
      result: null,
      testNumber: undefined,
      flags: undefined
    };
    siblings.push(node);
    state.nodes.push(node);
    state.stack[located.nesting] = node;

    const key = identityKey(located.file, located.nesting, located.name);
    const pending = state.pending.get(key) ?? [];
    if (pending.length > 1) {
      fail(`ambiguous early test:complete for ${located.name}`);
    } else if (pending.length === 1) {
      attachComplete(node, pending[0], located);
      state.pending.delete(key);
    }
  }

  function handleComplete(data) {
    const located = locate(data, 'test:complete');
    if (!located) return;
    const state = stateFor(located.file);
    const matches = candidates(state, located, false);
    if (matches.length === 1) {
      attachComplete(matches[0], data, located);
      return;
    }
    if (matches.length > 1) {
      fail(`ambiguous test:complete for ${located.name}`);
      return;
    }
    if (located.nesting === 0 && isFileWrapper(located.file, located.name, cwd)) {
      state.summaries.push({ wrapper: data });
      return;
    }
    const key = identityKey(located.file, located.nesting, located.name);
    const pending = state.pending.get(key) ?? [];
    pending.push(data);
    state.pending.set(key, pending);
  }

  function handleResult(data, resultName) {
    const located = locate(data, resultName);
    if (!located) return;
    const state = stateFor(located.file);
    const matches = candidates(state, located, true).filter((node) => !node.result);
    if (matches.length === 0) {
      if (located.nesting === 0 && isFileWrapper(located.file, located.name, cwd)) {
        state.summaries.push({ wrapper: data });
        return;
      }
      fail(`${resultName} has no started test for ${located.name}`);
      return;
    }
    if (matches.length > 1) {
      fail(`ambiguous ${resultName} for ${located.name}`);
      return;
    }
    if (located.nesting === 0 && isFileWrapper(located.file, located.name, cwd)) {
      state.summaries.push({ wrapper: data });
      return;
    }
    const node = matches[0];
    checkIdentity(node, located, resultName);
    bindKind(node, data, resultName);
    bindMetadata(node, data, resultName);
    const passed = resultName === 'test:pass';
    if (node.complete && node.complete.details?.passed !== passed) {
      fail(`${resultName} result conflicts for ${node.name}`);
    }
    node.result = { name: resultName, passed, data };
  }

  function handleSummary(data) {
    if (data.file === undefined) {
      aggregateSummary = data;
      return;
    }
    const file = normalizeFile(data.file, cwd);
    if (!file) {
      fail('test:summary is missing file');
      return;
    }
    stateFor(file).summaries.push({ summary: data });
  }

  function handle(name, data) {
    if (!EVENT_NAMES.includes(name)) return;
    if (name === 'test:start') handleStart(data);
    else if (name === 'test:complete') handleComplete(data);
    else if (name === 'test:pass' || name === 'test:fail') handleResult(data, name);
    else handleSummary(data);
  }

  function validateSummary(state, summary) {
    const counts = summary?.counts;
    if (!counts || typeof counts !== 'object') return;
    const tests = state.nodes.filter((node) => node.kind === 'test');
    const suites = state.nodes.filter((node) => node.kind === 'suite');
    if (state.nodes.length === 0 && counts.tests > 0) {
      fail(`test:summary has no logical test events for ${state.file}`);
      return;
    }
    const skipped = tests.filter((node) => node.flags?.skip !== undefined).length;
    const todo = tests.filter((node) => node.flags?.todo !== undefined).length;
    const passed = tests.filter((node) => node.result?.passed && node.flags?.skip === undefined && node.flags?.todo === undefined).length;
    if (counts.tests !== tests.length) fail(`test:summary tests count conflicts for ${state.file}`);
    if (counts.suites !== suites.length) fail(`test:summary suites count conflicts for ${state.file}`);
    if (counts.topLevel !== state.nodes.filter((node) => node.nesting === 0).length) fail(`test:summary topLevel count conflicts for ${state.file}`);
    if (counts.skipped !== skipped) fail(`test:summary skipped count conflicts for ${state.file}`);
    if (counts.todo !== todo) fail(`test:summary todo count conflicts for ${state.file}`);
    if (counts.passed !== passed) fail(`test:summary passed count conflicts for ${state.file}`);
    const failed = tests.filter((node) => node.result && !node.result.passed).length;
    if (counts.failed !== failed) fail(`test:summary failed count conflicts for ${state.file}`);
  }

  function finish() {
    for (const state of states.values()) {
      for (const pending of state.pending.values()) {
        if (pending.length > 0) fail(`unmatched early test:complete in ${state.file}`);
      }
      for (const node of state.nodes) {
        if (!node.kind) fail(`test kind is missing for ${node.name}`);
        if (!node.complete) fail(`test:complete is missing for ${node.name}`);
        if (!node.result) fail(`test result is missing for ${node.name}`);
      }
      for (const entry of state.summaries) {
        if (entry.summary) validateSummary(state, entry.summary);
      }
    }
    const files = [...states.values()].sort((left, right) => left.file.localeCompare(right.file)).map((state) => ({
      file: displayPath(state.file, cwd, mode),
      tests: state.nodes.map((node) => ({
        path: [...ancestors(node)].map((item) => ({
          kind: item.kind,
          name: item.name,
          siblingOrdinal: item.siblingOrdinal
        })),
        kind: node.kind,
        name: node.name,
        status: node.flags?.skip !== undefined ? 'skip' : node.flags?.todo !== undefined ? 'todo' : node.result?.passed ? 'pass' : 'fail',
        skip: node.flags?.skip,
        todo: node.flags?.todo,
        testNumber: node.testNumber
      })).sort((left, right) => JSON.stringify(left.path).localeCompare(JSON.stringify(right.path))),
      summaries: state.summaries.map((entry) => entry.summary ?? entry.wrapper).filter(Boolean)
    }));
    return {
      schemaVersion: 1,
      valid: errors.length === 0,
      errors: [...errors],
      aggregateSummary,
      files
    };
  }

  return { finish, handle };
}

function ancestors(node) {
  const result = [];
  let current = node;
  while (current) {
    result.unshift(current);
    current = current.parent;
  }
  return result;
}

function isGlob(value) {
  return /[*?{}[\]]/.test(value);
}

async function collectTestEvents(options = {}) {
  if (options.mode === 'source' && !String(process.env.NODE_OPTIONS ?? '').includes('--experimental-strip-types')) {
    throw new Error('source collector requires --experimental-strip-types in NODE_OPTIONS');
  }
  const collector = createCollector(options);
  /** @type {import('node:test').RunOptions} */
  const runOptions = {
    concurrency: options.concurrency ?? false,
    isolation: 'process',
    setup: (stream) => {
      for (const name of EVENT_NAMES) stream.on(name, (data) => collector.handle(name, data));
    }
  };
  const selections = options.selections ?? [];
  if (selections.some(isGlob)) runOptions.globPatterns = selections;
  else runOptions.files = selections;
  const stream = run(runOptions);
  return await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('close', () => {
      const result = collector.finish();
      result.success = result.valid && (result.aggregateSummary?.success ?? true);
      resolve(result);
    });
    stream.resume();
  });
}

function parseCliArgs(args) {
  const options = { mode: 'compiled', selections: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--mode') options.mode = args[++index];
    else if (value === '--test-concurrency') options.concurrency = Number(args[++index]);
    else if (value === '--cwd') options.cwd = args[++index];
    else options.selections.push(value);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await collectTestEvents(parseCliArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { collectTestEvents, createCollector, displayPath, isGlob };
