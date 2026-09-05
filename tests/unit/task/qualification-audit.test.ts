import test from 'node:test';
import assert from 'node:assert/strict';

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

test('legacy task input remains explicitly unconfigured until migrated', () => {
  const parsed = parseTaskQualification('# Task\n\n## 约束\n\n- a legacy constraint\n');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.qualification.present, false);
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
