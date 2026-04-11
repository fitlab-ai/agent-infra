import test from "node:test";
import assert from "node:assert/strict";

import { exists, parseFrontmatter, read } from "../helpers.js";

const localSkillPath = ".agents/skills/restore-task/SKILL.md";
const templateSkillPath = "templates/.agents/skills/restore-task/SKILL.en.md";
const templateSkillZhPath = "templates/.agents/skills/restore-task/SKILL.zh-CN.md";
const localVerifyPath = ".agents/skills/restore-task/config/verify.json";
const templateVerifyPath = "templates/.agents/skills/restore-task/config/verify.json";
const localClaudeCommandPath = ".claude/commands/restore-task.md";

test("restore-task skill files exist with valid frontmatter", () => {
  [localSkillPath, templateSkillPath, templateSkillZhPath].forEach((relativePath) => {
    assert.ok(exists(relativePath), `${relativePath} should exist`);
    const frontmatter = parseFrontmatter(relativePath);

    assert.ok(frontmatter, `${relativePath} should define frontmatter`);
    assert.equal(frontmatter.name, "restore-task");
    assert.ok(frontmatter.description);
  });
});

test("restore-task skill docs keep consecutive step numbering", () => {
  [localSkillPath, templateSkillPath, templateSkillZhPath].forEach((relativePath) => {
    const stepNumbers = [...read(relativePath).matchAll(/^### (\d+)\. /gm)]
      .map((match) => Number(match[1]));

    assert.deepEqual(stepNumbers, [1, 2, 3, 4, 5, 6, 7, 8], `${relativePath} should define steps 1 through 8`);
  });
});

test("restore-task verify configs declare the expected checks", () => {
  [localVerifyPath, templateVerifyPath].forEach((relativePath) => {
    assert.ok(exists(relativePath), `${relativePath} should exist`);
    const verify = JSON.parse(read(relativePath));

    assert.equal(verify.skill, "restore-task");
    assert.deepEqual(
      Object.keys(verify.checks),
      ["task-meta", "activity-log", "github-sync"],
      `${relativePath} should declare the restore-task checks`
    );
    assert.equal(verify.checks["task-meta"].require_issue_number, true);
    assert.equal(verify.checks["activity-log"].expected_action_pattern, "Restore Task");
    assert.equal(verify.checks["github-sync"], null);
  });
});

test("restore-task Claude command exists", () => {
  assert.ok(exists(localClaudeCommandPath), `${localClaudeCommandPath} should exist`);
  assert.match(read(localClaudeCommandPath), /\/restore-task <issue-number> \[task-id\]/);
});
