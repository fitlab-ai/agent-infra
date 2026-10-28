import fs from 'node:fs';
import path from 'node:path';

import { canonicalSemanticDigest } from '../../lib/task/artifact-operations.ts';
import { parseArtifactName } from '../../lib/task/artifact-name.ts';
import { parseArtifactReceipts, sha256File, upsertArtifactReceipts } from '../../lib/task/artifact-receipts.ts';
import { upsertSection } from '../../lib/task/sections.ts';

const ACTIONS = {
  analysis: 'Analyze Task',
  'review-analysis': 'Review Analysis',
  plan: 'Plan Task',
  'review-plan': 'Review Plan',
  code: 'Code Task',
  'review-code': 'Review Code'
} as const;

type LifecycleFamily = keyof typeof ACTIONS;
type CompletionSpec = {
  name: string;
  lifecycleInputs?: readonly string[];
};

function formatTimestamp(second: number): string {
  const value = new Date(Date.UTC(2026, 0, 1, 0, 0, second));
  return `${value.toISOString().slice(0, 19).replace('T', ' ')}+00:00`;
}

function setFrontmatterField(content: string, field: string, value: string): string {
  const line = `${field}: '${value}'`;
  if (new RegExp(`^${field}:.*$`, 'mu').test(content)) {
    return content.replace(new RegExp(`^${field}:.*$`, 'mu'), line);
  }
  const frontmatterEnd = content.indexOf('\n---', 4);
  if (frontmatterEnd < 0) throw new Error('task fixture has no closing frontmatter delimiter');
  return `${content.slice(0, frontmatterEnd)}\n${line}${content.slice(frontmatterEnd)}`;
}

function replaceActivityLog(content: string, rows: readonly string[]): string {
  const heading = /^## (Activity Log|活动日志)\s*$/mu.exec(content);
  const body = `## ${heading?.[1] ?? 'Activity Log'}\n\n${rows.join('\n')}\n`;
  if (!heading) return `${content.trimEnd()}\n\n${body}`;

  const nextHeadingOffset = /^## /mu.exec(content.slice(heading.index + heading[0].length))?.index;
  const end = nextHeadingOffset === undefined
    ? content.length
    : heading.index + heading[0].length + nextHeadingOffset;
  return `${content.slice(0, heading.index)}${body}${content.slice(end).replace(/^\n+/, '\n')}`;
}

/** Write completion facts and paired Activity Log rows for explicitly completed fixture artifacts. */
export function recordArtifactCompletions(taskDir: string, artifacts: readonly CompletionSpec[]): void {
  const taskPath = path.join(taskDir, 'task.md');
  const task = fs.readFileSync(taskPath, 'utf8');
  const rewritten = new Set(artifacts.map(({ name }) => name));
  const existingReceipts = parseArtifactReceipts(task).rows;
  let receiptBase = task;
  if (existingReceipts.some((receipt) => rewritten.has(receipt.output))) {
    receiptBase = task.split('\n').filter((line) => {
      if (!line.startsWith('| ')) return true;
      const cells = line.split('|').map((cell) => cell.trim());
      return !rewritten.has(cells[2] ?? '');
    }).join('\n');
  }
  const inputsFor = (name: string, inputs: readonly string[] | undefined) => inputs ?? existingReceipts
    .filter((receipt) => receipt.output === name)
    .map((receipt) => receipt.input);
  const receipts = artifacts.flatMap(({ name, lifecycleInputs }) => {
    const identity = parseArtifactName(name);
    if (!identity) throw new Error(`unsupported fixture artifact '${name}'`);
    const event = (identity.family === 'analysis' ? 'analysis.completed' : `${identity.family}.completed`) as
      'analysis.completed' | 'plan.completed' | 'review-analysis.completed' | 'review-plan.completed' | 'code.completed' | 'review-code.completed';
    return inputsFor(name, lifecycleInputs).map((input) => ({
      event,
      output: name,
      input,
      inputSha256: sha256File(path.join(taskDir, input)),
      completedAt: formatTimestamp(0)
    }));
  });
  const facts = artifacts.map(({ name, lifecycleInputs }) => {
    const identity = parseArtifactName(name);
    if (!identity || !(identity.family in ACTIONS)) throw new Error(`unsupported fixture artifact '${name}'`);
    const outputPath = path.join(taskDir, name);
    const content = fs.readFileSync(outputPath, 'utf8');
    return {
      event: identity.family === 'analysis' ? 'analyze.completed' : `${identity.family}.completed`,
      output: name,
      outputSha256: sha256File(outputPath),
      semanticDigest: canonicalSemanticDigest(content),
      requestId: `fixture-${name}`,
      result: 'completed',
      lifecycleInputs: inputsFor(name, lifecycleInputs).map((input) => ({
        name: input,
        sha256: sha256File(path.join(taskDir, input))
      }))
    };
  });
  const rows = artifacts.flatMap(({ name }, index) => {
    const identity = parseArtifactName(name)!;
    const step = `${ACTIONS[identity.family as LifecycleFamily]} (Round ${identity.round})`;
    const start = formatTimestamp(index * 2);
    const done = formatTimestamp(index * 2 + 1);
    return [
      `- ${start} — **${step} [started]** by codex — started`,
      `- ${done} — **${step}** by codex — completed → ${name}`
    ];
  });

  let withEvidence = setFrontmatterField(receiptBase, 'completion_facts', JSON.stringify(facts));
  if (receipts.length > 0) {
    const mutation = upsertArtifactReceipts(withEvidence, receipts);
    withEvidence = upsertSection(withEvidence, mutation).content;
  }
  fs.writeFileSync(taskPath, replaceActivityLog(withEvidence, rows));
}
