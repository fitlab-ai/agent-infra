import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildQualificationAudit,
  constraintDigest,
  nonConstraintInputDigest,
  parseQualificationAudit,
  parseTaskQualification,
  renderQualificationAudit,
  upstreamArtifactDigest,
  validateQualificationAudit
} from '../../../lib/task/qualification-audit.ts';

function taskContent(): string {
  return `# Task

## 约束

| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Must keep the public command stable | derived | user | task input | task.md#facts |  |  |
| C-2 | Code must use the existing writer | derived | plan | C-1 | plan.md#method | C-1 | plan.md#method |

## 候选与否决方案

| candidate_id | statement | status | constraint_ids | impact | evidence |
| --- | --- | --- | --- | --- | --- |
| A | Use the existing writer | qualified | C-1,C-2 | Small change | plan.md#A |
| B | Add a second writer | rejected | C-1 | Larger change | plan.md#B |
`;
}

test('qualification selects visible inputs and retains H3 precedence with either EOL', () => {
  for (const eol of ['\n', '\r\n']) {
    const example = '````md\n' + taskContent().replaceAll('C-1', 'C-99') + '\n```\n## 约束\nstill fenced\n````\n';
    const visible = taskContent().replaceAll('## ', '### ');
    const content = (example + visible + taskContent().replaceAll('C-1', 'C-98')).replaceAll('\n', eol);
    const parsed = parseTaskQualification(content);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.qualification.constraints.map(row => row.constraintId), ['C-1', 'C-2']);
    const baseline = parseTaskQualification(taskContent());
    assert.ok(baseline.ok);
    assert.equal(parsed.qualification.taskInputDigest, baseline.qualification.taskInputDigest);
  }
});

test('qualification treats fenced-only inputs and tables as examples', () => {
  for (const content of [
    '```md\n' + taskContent() + '\n```\n',
    taskContent().replace(/(\| constraint_id[\s\S]*?)\n\n##/, '~~~md\n$1\n~~~\n\n##').replace(/(\| candidate_id[\s\S]*)$/, '~~~md\n$1\n~~~\n'),
    '## 约束\nprose\n```md\n' + taskContent() + '\n```\n'
  ]) {
    const parsed = parseTaskQualification(content);
    assert.ok(parsed.ok);
    assert.equal(parsed.qualification.present, false);
  }
});

test('qualification selects real H2 constraints after a fenced example', () => {
  const example = '```md\n' + taskContent().replaceAll('C-1', 'C-99') + '\n```\n';
  const parsed = parseTaskQualification(example + taskContent());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.qualification.constraints.map(row => row.constraintId), ['C-1', 'C-2']);
});

test('qualification projection preserves ordinary digests and fenced input bytes', () => {
  const expected = createHash('sha256').update(JSON.stringify('# Task')).digest('hex');
  assert.equal(nonConstraintInputDigest(taskContent()), expected);
  assert.equal(nonConstraintInputDigest(taskContent().replaceAll('\n', '\r\n')), expected);
  const example = '```md\n## Activity Log\nexample input\n```\n\n';
  const content = example + taskContent();
  assert.equal(nonConstraintInputDigest(content), createHash('sha256').update(JSON.stringify(example + '# Task')).digest('hex'));
  assert.notEqual(nonConstraintInputDigest(content), nonConstraintInputDigest(content.replace('example input', 'changed input')));
});

test('qualification audits ignore fenced siblings and reject changed real input', () => {
  const built = buildQualificationAudit(taskContent());
  assert.ok(built.ok);
  const real = '## Qualification Audit\n\n' + renderQualificationAudit(built.audit);
  const content = '~~~md\n' + real.replaceAll('C-1', 'C-99') + '\n~~~\n\n' + real;
  assert.deepEqual(parseQualificationAudit(content), parseQualificationAudit(real));
  assert.equal(validateQualificationAudit(taskContent(), content, { require: true }).ok, true);
  assert.equal(validateQualificationAudit(taskContent().replace('public command stable', 'new command stable'), content, { require: true }).ok, false);
  const outside = real.replace('### 约束依赖', '## Outside\n### 约束依赖');
  assert.equal(parseQualificationAudit(outside).ok, false);
});

test('qualification projection is canonical and binds confirmed evidence', () => {
  const parsed = parseTaskQualification(taskContent());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.qualification.constraints.length, 2);
  assert.equal(parsed.qualification.candidates[0]?.constraintIds.join(','), 'C-1,C-2');
  assert.match(parsed.qualification.constraintDigest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.qualification.constraints[0]?.digest, constraintDigest(parsed.qualification.constraints[0]!));
});

test('qualification audit round-trips and rejects stale or unknown dependencies', () => {
  const parsed = parseTaskQualification(taskContent());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const built = buildQualificationAudit(taskContent(), {
    classifications: [{ decisionId: 'HD-1', classification: 'deterministic', evidence: 'plan.md#HD-1' }],
    upstreamRelations: [{
      upstreamFamily: 'review-plan', upstreamArtifact: 'review-plan.md', upstreamRound: 1,
      upstreamSha256: 'a'.repeat(64), relation: 'reviewed-input'
    }]
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const rendered = renderQualificationAudit(built.audit);
  const audit = parseQualificationAudit(`## Qualification Audit\n\n${rendered}`);
  assert.equal(audit.ok, true);
  if (!audit.ok) return;
  assert.equal(audit.audit.upstreamRelations[0]?.upstreamArtifact, 'review-plan.md');
  assert.equal(audit.audit.snapshot?.upstreamArtifactDigest, upstreamArtifactDigest(audit.audit.upstreamRelations));

  const valid = validateQualificationAudit(taskContent(), `## Qualification Audit\n\n${rendered}`, { family: 'code', artifact: 'code.md', require: true });
  assert.equal(valid.ok, true);

  const stale = rendered.replace(parsed.qualification.constraints[0]!.digest, 'b'.repeat(64));
  const invalid = validateQualificationAudit(taskContent(), `## Qualification Audit\n\n${stale}`, { require: true });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'QUALIFICATION_CONSTRAINT_DIGEST_MISMATCH');
});

test('qualification audit accepts review audit heading aliases', () => {
  const built = buildQualificationAudit(taskContent());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const rendered = renderQualificationAudit(built.audit);

  for (const heading of ['## 资格审计复核', '## Qualification Audit Review']) {
    const parsed = parseQualificationAudit(`${heading}\n\n${rendered}`);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.audit.present, true);
  }
});

test('qualification audit rejects candidate snapshots that diverge from task input', () => {
  const built = buildQualificationAudit(taskContent());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const rendered = renderQualificationAudit(built.audit);
  const changed = rendered.replace('| A | qualified | Small change |', '| A | rejected | Small change |');
  const result = validateQualificationAudit(taskContent(), `## Qualification Audit\n\n${changed}`, { require: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'QUALIFICATION_CANDIDATE_MISMATCH');
});

test('qualification audit requires the exact started upstream relations', () => {
  const expected = [{
    upstreamFamily: 'plan' as const, upstreamArtifact: 'plan.md', upstreamRound: 1,
    upstreamSha256: 'a'.repeat(64), relation: 'required-input' as const
  }];
  const built = buildQualificationAudit(taskContent());
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const result = validateQualificationAudit(
    taskContent(),
    `## Qualification Audit\n\n${renderQualificationAudit(built.audit)}`,
    { family: 'code', artifact: 'code.md', require: true, expectedUpstreamRelations: expected }
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'QUALIFICATION_UPSTREAM_RELATION_MISMATCH');
});

test('legacy task input remains explicitly unconfigured until migrated', () => {
  const parsed = parseTaskQualification('# Task\n\n## 约束\n\n- a legacy constraint\n');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.qualification.present, false);
});

test('prose in both task input sections remains unconfigured', () => {
  const content = '# Task\n\n## 任务输入\n\n### 约束\n\n- Keep host ownership.\n\n### 候选与否决方案\n\n- Use finalization receipts.\n';
  const parsed = parseTaskQualification(content);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.qualification.present, false);
  assert.equal(validateQualificationAudit(content, '# Review\n').ok, true);
});

test('partially configured qualification tables fail closed', () => {
  const content = taskContent().replace(/\| candidate_id[\s\S]*$/, '- Use the existing writer.\n');
  const parsed = parseTaskQualification(content);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, 'QUALIFICATION_TASK_CONTRACT_INVALID');
});

test('non-constraint projection ignores mutable task frontmatter', () => {
  const content = `---
id: TASK-20260101-000001
status: active
updated_at: old
checkpoint_commit:
---

${taskContent()}

## 活动日志

- old runtime entry`;
  const lifecycleUpdated = content
    .replace('updated_at: old', 'updated_at: new')
    .replace('checkpoint_commit:', 'checkpoint_commit: abc123')
    .replace('old runtime entry', 'new runtime entry');
  assert.equal(nonConstraintInputDigest(content), nonConstraintInputDigest(lifecycleUpdated));

  const taskContentUpdated = content.replace('# Task\n', '# Task\n\nA changed task description.\n');
  assert.notEqual(nonConstraintInputDigest(content), nonConstraintInputDigest(taskContentUpdated));
});
