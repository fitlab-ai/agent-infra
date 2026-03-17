import test from "node:test";
import assert from "node:assert/strict";

import {
  assertContainsPatterns,
  commandSpecs,
  escapeRegExp,
  listSkillNames,
  read,
  skillDocPaths
} from "./helpers.js";

test("update-agent-orchestrator instructions point to templates rendering", () => {
  const updateSkill = read(".agents/skills/update-agent-orchestrator/SKILL.md");
  const geminiUpdate = read(".gemini/commands/agent-orchestrator/update-agent-orchestrator.toml");

  assert.match(updateSkill, /templateSource/);
  assert.match(updateSkill, /templates\//);
  assert.match(updateSkill, /git.*pull/);
  assert.match(updateSkill, /ao update/);
  assert.match(geminiUpdate, /SKILL\.md/);
});

test("init-labels skill documents label bootstrap flow and command discovery", () => {
  const skillDocs = [
    ".agents/skills/init-labels/SKILL.md",
    "templates/.agents/skills/init-labels/SKILL.md",
    "templates/.agents/skills/init-labels/SKILL.zh-CN.md"
  ];
  const scriptPaths = [
    ".agents/skills/init-labels/scripts/init-labels.sh",
    "templates/.agents/skills/init-labels/scripts/init-labels.sh"
  ];

  skillDocs.forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /bash \.agents\/skills\/init-labels\/scripts\/init-labels\.sh/,
      /type:/,
      /status:/,
      /good first issue/,
      /dependencies/,
      /in: core/,
      /theme:/,
      /question/,
      /wontfix/,
      /gh auth status/
    ]);
  });

  scriptPaths.forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /gh label create .*--force/,
      /type: bug/,
      /status: waiting-for-triage/,
      /status: in-progress/,
      /status: waiting-for-internal-feedback/,
      /good first issue/,
      /dependencies/
    ]);
  });

  assert.match(read("templates/.claude/CLAUDE.md"), /\/init-labels\s+# Initialize GitHub Labels/);
  assert.match(read("templates/.claude/CLAUDE.zh-CN.md"), /\/init-labels\s+# 初始化 GitHub Labels/);
  assert.match(read(".claude/CLAUDE.md"), /\/init-labels\s+# 初始化 GitHub Labels/);
  assert.match(read("templates/.gemini/commands/_project_/init-labels.toml"), /\{\{project\}\}/);
  assert.match(read("templates/.gemini/commands/_project_/init-labels.zh-CN.toml"), /\{\{project\}\}/);
  assert.doesNotMatch(read(".gemini/commands/agent-orchestrator/init-labels.toml"), /\{\{project\}\}/);
  assert.match(read(".gemini/commands/agent-orchestrator/init-labels.toml"), /agent-orchestrator/);
});

test("init-milestones skill documents milestone bootstrap flow and command discovery", () => {
  const skillDocs = [
    ".agents/skills/init-milestones/SKILL.md",
    "templates/.agents/skills/init-milestones/SKILL.md",
    "templates/.agents/skills/init-milestones/SKILL.zh-CN.md"
  ];
  const scriptPaths = [
    ".agents/skills/init-milestones/scripts/init-milestones.sh",
    "templates/.agents/skills/init-milestones/scripts/init-milestones.sh"
  ];

  skillDocs.forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /General Backlog/,
      /--history/,
      /package\.json/,
      /0\.1\.0/,
      /Issues that we want to resolve in .* line/,
      /Issues that we want to release in v/,
      /state.*closed/,
      /bash \.agents\/skills\/init-milestones\/scripts\/init-milestones\.sh/,
      /gh api "repos\/\$repo\/milestones"/,
      /Milestone titles are treated as the idempotency key/
    ]);
  });

  scriptPaths.forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /git tag --list 'v\*' --sort=-v:refname \| head -1/,
      /git tag --list 'v\*' --sort=v:refname/,
      /package\.json/,
      /0\.1\.0/,
      /gh api "repos\/\$repo\/milestones"/
    ]);
  });

  assert.match(read("templates/.claude/CLAUDE.md"), /\/init-milestones\s+# Initialize GitHub Milestones/);
  assert.match(read("templates/.claude/CLAUDE.zh-CN.md"), /\/init-milestones\s+# 初始化 GitHub Milestones/);
  assert.match(read(".claude/CLAUDE.md"), /\/init-milestones\s+# 初始化 GitHub Milestones/);
  assert.match(read("templates/.gemini/commands/_project_/init-milestones.toml"), /\{\{project\}\}/);
  assert.match(read("templates/.gemini/commands/_project_/init-milestones.zh-CN.toml"), /\{\{project\}\}/);
  assert.doesNotMatch(read(".gemini/commands/agent-orchestrator/init-milestones.toml"), /\{\{project\}\}/);
  assert.match(read(".gemini/commands/agent-orchestrator/init-milestones.toml"), /agent-orchestrator/);
});

test("sync-issue skill documents label sync and development linking", () => {
  skillDocPaths("sync-issue").forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /gh label list --search "type:"/,
      /init-labels/,
      /--add-label/,
      /--remove-label/,
      /type: bug/,
      /type: feature/,
      /status: blocked/,
      /status: in-progress/,
      /status: pending-design-work/,
      /current_step` ∈ \{`implementation`, `code-review`, `refinement`\}/,
      /gh issue edit \{issue-number\} --add-label "in: \{module\}"/,
      /gh pr view \{pr-number\}/,
      /gh pr edit \{pr-number\}/,
      /gh issue view \{issue-number\} --json milestone/,
      /milestone` 字段|`milestone` field/,
      /git branch --show-current/,
      /git branch -a \| grep -oE '\[0-9\]\+\\\.\[0-9\]\+\\\.x'/,
      /General Backlog/,
      /Milestone[:：]/,
      /Closes #\{issue-number\}/,
      /Fixes #\{issue-number\}/,
      /Resolves #\{issue-number\}/
    ]);

    const stepNumbers = [...read(relativePath).matchAll(/^### (\d+)\. /gm)]
      .map((match) => Number(match[1]));

    assert.deepEqual(
      stepNumbers,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      `${relativePath} should number steps continuously from 0 to 11`
    );
  });
});

test("sync-issue skill accepts issue numbers and keeps task-id compatibility", () => {
  skillDocPaths("sync-issue").forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /参数：task-id 或 issue-number|Argument: task-id or issue-number/,
      /纯数字（如 `123`）或 `#` \+ 数字（如 `#123`）|plain number \(`123`\) or `#` \+ number \(`#123`\)/,
      /`TASK-` 开头|Starts with `TASK-`/,
      /读取每个 `task\.md` 的 `issue_number` 字段|Read the `issue_number` field from each `task\.md`/,
      /No task found associated with Issue #\{issue-number\}/
    ]);
  });
});

test("complete-task skill uses issue_number sync hint with explicit guard", () => {
  skillDocPaths("complete-task").forEach((relativePath) => {
    const content = read(relativePath);

    assertContainsPatterns(relativePath, [
      /issue_number` (字段，且其值不为空也不为 `N\/A`|field whose value is neither empty nor `N\/A`)/,
      /跳过此步骤，不输出任何内容|skip this step and output nothing/,
      /sync-issue \{issue_number\}/
    ]);

    assert.doesNotMatch(content, /关联 Issue：#\{issue_number\}|Associated Issue: #\{issue_number\}/);
    assert.doesNotMatch(content, /sync-issue \{task-id\}/);
  });
});

test("block-task skill uses issue_number sync hint with explicit guard", () => {
  skillDocPaths("block-task").forEach((relativePath) => {
    const content = read(relativePath);

    assertContainsPatterns(relativePath, [
      /issue_number` (字段，且其值不为空也不为 `N\/A`|field whose value is neither empty nor `N\/A`)/,
      /跳过此步骤，不输出任何内容|skip this step and output nothing/,
      /sync-issue \{issue_number\}/
    ]);

    assert.doesNotMatch(content, /sync-issue \{task-id\}/);
  });
});

test("skill command templates use thin adapter bodies", () => {
  const skills = listSkillNames();

  skills.forEach((skill) => {
    const spec = commandSpecs[skill] || {};
    const markdownTargets = [
      `templates/.claude/commands/${skill}.md`,
      `templates/.claude/commands/${skill}.zh-CN.md`,
      `templates/.opencode/commands/${skill}.md`,
      `templates/.opencode/commands/${skill}.zh-CN.md`
    ];
    const tomlTargets = [
      `templates/.gemini/commands/_project_/${skill}.toml`,
      `templates/.gemini/commands/_project_/${skill}.zh-CN.toml`
    ];
    const skillPathPattern = new RegExp(escapeRegExp(`.agents/skills/${skill}/SKILL.md`));

    markdownTargets.forEach((target) => {
      const content = read(target);
      const isChinese = target.endsWith(".zh-CN.md");
      const contextLine = isChinese ? spec.zh : spec.en;

      assert.match(content, skillPathPattern, `${target} should reference the skill file`);
      assert.doesNotMatch(content, /^name:/m, `${target} should not declare a name field`);
      assert.doesNotMatch(content, /^argument-hint:/m, `${target} should not declare an argument hint`);

      if (target.includes("/.claude/")) {
        if (spec.usage) {
          assert.match(
            content,
            new RegExp(`^usage: "${escapeRegExp(`/${skill} ${spec.usage}`)}"$`, "m"),
            `${target} should declare the Claude usage`
          );
        } else {
          assert.doesNotMatch(content, /^usage:/m, `${target} should not declare usage`);
        }
      } else {
        assert.doesNotMatch(content, /^usage:/m, `${target} should not declare usage`);
      }

      if (target.includes("/.opencode/")) {
        assert.match(content, /^agent: general$/m, `${target} should declare the OpenCode agent`);
        assert.match(content, /^subtask: false$/m, `${target} should declare the OpenCode subtask flag`);
      }

      if (contextLine && !target.includes("/.claude/")) {
        assert.match(
          content,
          new RegExp(escapeRegExp(contextLine)),
          `${target} should include the command argument context`
        );
      } else if (!contextLine) {
        assert.doesNotMatch(content, /\$1|\$ARGUMENTS/, `${target} should not include argument placeholders`);
      }

      if (isChinese) {
        assert.match(content, /读取并执行/, `${target} should use the Chinese thin adapter body`);
        assert.match(content, /严格按照技能中定义的所有步骤执行/, `${target} should include the Chinese execution instruction`);
      } else {
        assert.match(content, /Read and execute the .* skill from/, `${target} should use the English thin adapter body`);
        assert.match(content, /Follow all steps defined in the skill exactly/, `${target} should include the English execution instruction`);
      }
    });

    tomlTargets.forEach((target) => {
      const content = read(target);
      const isChinese = target.endsWith(".zh-CN.toml");
      const contextLine = (isChinese ? spec.zh : spec.en)
        ?.replace(/\$1/g, "{{args}}")
        .replace(/\$ARGUMENTS/g, "{{args}}");

      assert.match(content, /^description = "/, `${target} should declare a TOML description`);
      assert.match(content, /^prompt = """$/m, `${target} should use a multiline TOML prompt`);
      assert.match(content, skillPathPattern, `${target} should reference the skill file`);

      if (contextLine) {
        assert.match(
          content,
          new RegExp(escapeRegExp(contextLine)),
          `${target} should include the Gemini argument context`
        );
      } else {
        assert.doesNotMatch(content, /\{\{args\}\}/, `${target} should not include Gemini arguments`);
      }

      if (isChinese) {
        assert.match(content, /读取并执行/, `${target} should use the Chinese thin adapter body`);
        assert.match(content, /严格按照技能中定义的所有步骤执行/, `${target} should include the Chinese execution instruction`);
      } else {
        assert.match(content, /Read and execute the .* skill from/, `${target} should use the English thin adapter body`);
        assert.match(content, /Follow all steps defined in the skill exactly/, `${target} should include the English execution instruction`);
      }
    });
  });
});

test("artifact versioning guidance exists in repeatable workflow skills", () => {
  [
    ".agents/skills/implement-task/SKILL.md",
    "templates/.agents/skills/implement-task/SKILL.md",
    "templates/.agents/skills/implement-task/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /implementation-r\{N\}\.md/,
      /Implementation \(Round \{N\}\)/,
      /\{implementation-artifact\}/
    ]);
  });

  [
    ".agents/skills/review-task/SKILL.md",
    "templates/.agents/skills/review-task/SKILL.md",
    "templates/.agents/skills/review-task/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /review-r\{N\}\.md/,
      /implementation-r\{N\}\.md/,
      /Code Review \(Round \{N\}\)/
    ]);
  });

  [
    ".agents/skills/refine-task/SKILL.md",
    "templates/.agents/skills/refine-task/SKILL.md",
    "templates/.agents/skills/refine-task/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /review-r\{N\}\.md/,
      /Review artifact mismatch:/,
      /\{implementation-artifact\}/
    ]);
  });

  [
    ".agents/skills/check-task/SKILL.md",
    "templates/.agents/skills/check-task/SKILL.md",
    "templates/.agents/skills/check-task/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /implementation-r2\.md/,
      /review-r2\.md/,
      /latest/
    ]);
  });

  [
    ".agents/skills/complete-task/SKILL.md",
    "templates/.agents/skills/complete-task/SKILL.md",
    "templates/.agents/skills/complete-task/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /review-r\{N\}\.md/,
      /Approved/
    ]);
  });
});

test("workflows document artifact versioning for implementation, review, and fix loops", () => {
  [
    ".agents/workflows/feature-development.yaml",
    ".agents/workflows/bug-fix.yaml",
    ".agents/workflows/refactoring.yaml",
    "templates/.agents/workflows/feature-development.yaml",
    "templates/.agents/workflows/bug-fix.yaml",
    "templates/.agents/workflows/refactoring.yaml",
    "templates/.agents/workflows/feature-development.zh-CN.yaml",
    "templates/.agents/workflows/bug-fix.zh-CN.yaml",
    "templates/.agents/workflows/refactoring.zh-CN.yaml"
  ].forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /artifact_versioning:/,
      /implementation-r\{N\}\.md/,
      /review-r\{N\}\.md/,
      /Activity Log/
    ]);
  });
});

test("skills that write timestamps require date command guidance", () => {
  const timestampSkills = [
    "analyze-codescan",
    "analyze-dependabot",
    "analyze-issue",
    "block-task",
    "close-codescan",
    "close-dependabot",
    "commit",
    "complete-task",
    "create-pr",
    "create-task",
    "implement-task",
    "plan-task",
    "refine-task",
    "review-task",
    "sync-issue",
    "sync-pr"
  ];

  timestampSkills.forEach((skill) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);

      assert.match(
        content,
        /date "\+%Y-%m-%d %H:%M:%S"/,
        `${relativePath} should require the date command for timestamp writes`
      );
    });
  });
});
