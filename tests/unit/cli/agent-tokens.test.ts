import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_LONG_NAMES,
  AGENT_USAGE_HINT,
  classifyAgent,
  KNOWN_AI_AGENTS,
  normalizeAgentToken
} from '../../../lib/agent-clients/tokens.ts';

// --- normalizeAgentToken: strict write-side validation ---

test('normalizeAgentToken passes every standard short token through unchanged', () => {
  for (const token of ['claude', 'codex', 'antigravity', 'opencode', 'cursor']) {
    assert.equal(normalizeAgentToken(token), token, token);
  }
});

test('normalizeAgentToken maps long names to short tokens (HD-4)', () => {
  assert.equal(normalizeAgentToken('claude-code'), 'claude');
  assert.equal(normalizeAgentToken('antigravity-cli'), 'antigravity');
});

test('normalizeAgentToken rejects historical gemini tokens on the write side', () => {
  for (const token of ['gemini', 'gemini-cli']) {
    assert.equal(normalizeAgentToken(token), null, token);
  }
});

test('normalizeAgentToken keeps human as the single manual-executor token', () => {
  assert.equal(normalizeAgentToken('human'), 'human');
  assert.equal(normalizeAgentToken('  human  '), 'human');
});

test('normalizeAgentToken rejects OS / git usernames and empty values', () => {
  for (const invalid of ['devuser', '季聿阶', 'Alice', '张三 (executed on host)', '']) {
    assert.equal(normalizeAgentToken(invalid), null, invalid);
  }
});

test('normalizeAgentToken exposes the long-name mapping as the single source', () => {
  assert.deepEqual(Object.keys(AGENT_LONG_NAMES).sort(), ['antigravity-cli', 'claude-code']);
  assert.equal(AGENT_LONG_NAMES['claude-code'], 'claude');
  assert.equal(AGENT_LONG_NAMES['antigravity-cli'], 'antigravity');
});

// --- classifyAgent: loose rendering-side classification ---

test('classifyAgent treats every known AI short and long token as ai', () => {
  for (const token of [...KNOWN_AI_AGENTS, 'gemini', 'claude-code', 'gemini-cli', 'antigravity-cli']) {
    assert.equal(classifyAgent(token).status, 'ai', token);
  }
});

test('classifyAgent renders known long names to their short display token', () => {
  assert.deepEqual(classifyAgent('claude-code'), { status: 'ai', display: 'claude' });
  assert.deepEqual(classifyAgent('gemini-cli'), { status: 'ai', display: 'gemini' });
  assert.deepEqual(classifyAgent('antigravity-cli'), { status: 'ai', display: 'antigravity' });
});

test('classifyAgent renders human as human without a marker', () => {
  assert.deepEqual(classifyAgent('human'), { status: 'human', display: 'human' });
});

test('classifyAgent renders unknown tokens as human with a visible unknown display', () => {
  assert.deepEqual(classifyAgent('devuser'), { status: 'unknown', display: 'human' });
  assert.deepEqual(classifyAgent('季聿阶'), { status: 'unknown', display: 'human' });
  assert.deepEqual(classifyAgent('张三 (executed on host)'), { status: 'unknown', display: 'human' });
});

test('classifyAgent treats an empty token as unknown (visible signal)', () => {
  assert.deepEqual(classifyAgent(''), { status: 'unknown', display: 'human' });
  assert.deepEqual(classifyAgent('   '), { status: 'unknown', display: 'human' });
});

// --- AGENT_USAGE_HINT ---

test('AGENT_USAGE_HINT names the accepted token shapes', () => {
  assert.match(AGENT_USAGE_HINT, /claude-code/);
  assert.match(AGENT_USAGE_HINT, /antigravity-cli/);
  assert.match(AGENT_USAGE_HINT, /human/);
});
