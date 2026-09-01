import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { KNOWN_AI_AGENTS, AGENT_LONG_NAMES } from '../../../lib/agent-clients/tokens.ts';

const root = process.cwd();
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');
const codeSpans = (content: string): string[] =>
  [...content.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);

const guidanceSources = [
  '.agents/rules/task-management.md',
  'templates/.agents/rules/task-management.en.md',
  'templates/.agents/rules/task-management.zh-CN.md'
];

const consumerFiles = [
  ...[
    'analyze-task', 'block-task', 'cancel-task', 'close-codescan', 'close-dependabot',
    'code-task', 'complete-manual-validation', 'complete-task', 'create-pr', 'create-task',
    'import-issue', 'plan-task', 'restore-task', 'review-analysis', 'review-code', 'review-plan'
  ].flatMap((skill) => [
    `.agents/skills/${skill}/SKILL.md`,
    `templates/.agents/skills/${skill}/SKILL.en.md`,
    `templates/.agents/skills/${skill}/SKILL.zh-CN.md`
  ]),
  ...[
    'create-issue', 'issue-fields', 'issue-pr-commands', 'issue-sync', 'milestone-inference', 'pr-sync'
  ].flatMap((rule) => [
    `.agents/rules/${rule}.md`,
    ...({
      'create-issue': ['templates/.agents/rules/create-issue.en.md', 'templates/.agents/rules/create-issue.zh-CN.md'],
      'issue-fields': ['templates/.agents/rules/issue-fields.en.md', 'templates/.agents/rules/issue-fields.zh-CN.md'],
      'issue-pr-commands': ['templates/.agents/rules/issue-pr-commands.en.md', 'templates/.agents/rules/issue-pr-commands.zh-CN.md'],
      'issue-sync': ['templates/.agents/rules/issue-sync.en.md', 'templates/.agents/rules/issue-sync.zh-CN.md'],
      'milestone-inference': ['templates/.agents/rules/milestone-inference.en.md', 'templates/.agents/rules/milestone-inference.zh-CN.md'],
      'pr-sync': ['templates/.agents/rules/pr-sync.en.md', 'templates/.agents/rules/pr-sync.zh-CN.md']
    } as Record<string, string[]>)[rule]!
  ])
];

test('token guidance sources mirror the current machine token contract', () => {
  const tokens = [...KNOWN_AI_AGENTS];
  for (const relativePath of guidanceSources) {
    const content = read(relativePath);
    for (const token of tokens) assert.match(content, new RegExp(`\\b${token}\\b`), relativePath);
    for (const [longName, shortName] of Object.entries(AGENT_LONG_NAMES)) {
      assert.match(content, new RegExp(`${longName}[^\\n]*${shortName}`), relativePath);
    }
    assert.match(content, /human/);
  }
});

test('token consumers retain a stable guidance reference and placeholder shape', () => {
  const tokens = [...KNOWN_AI_AGENTS];
  for (const relativePath of consumerFiles) {
    const content = read(relativePath);
    assert.match(content, /task-management(?:\.md|\.en\.md|\.zh-CN\.md)/, relativePath);
    if (content.includes('--agent')) assert.match(content, /\{standard-agent-token\}/, relativePath);
    const embeddedTokens = new Set(
      codeSpans(content).flatMap((span) => tokens.filter((token) => new RegExp(`\\b${token}\\b`).test(span)))
    );
    assert.equal(embeddedTokens.size === tokens.length, false, `${relativePath} embeds the complete current token set`);
  }
});
