import test from "node:test";
import assert from "node:assert/strict";

import {
  assertContainsPatterns,
  commandSpecs,
  escapeRegExp,
  listSkillNames,
  read,
  skillContentPaths,
  skillDocPaths
} from "./helpers.js";

test("update-agent-infra instructions point to templates rendering", () => {
  const updateSkill = read(".agents/skills/update-agent-infra/SKILL.md");
  const geminiUpdate = read(".gemini/commands/agent-infra/update-agent-infra.toml");

  assert.match(updateSkill, /templateSource/);
  assert.match(updateSkill, /templates\//);
  assert.match(updateSkill, /模板源版本/);
  assert.match(updateSkill, /ai update/);
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
      /gh auth token/
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

  assert.match(read("templates/.claude/CLAUDE.md"), /Available commands are auto-discovered from `\.claude\/commands\/`/);
  assert.match(read("templates/.claude/CLAUDE.zh-CN.md"), /可用命令从 `\.claude\/commands\/` 自动发现/);
  assert.match(read(".claude/CLAUDE.md"), /可用命令从 `\.claude\/commands\/` 自动发现/);
  assert.match(read("templates/.gemini/commands/_project_/init-labels.toml"), /\{\{project\}\}/);
  assert.match(read("templates/.gemini/commands/_project_/init-labels.zh-CN.toml"), /\{\{project\}\}/);
  assert.doesNotMatch(read(".gemini/commands/agent-infra/init-labels.toml"), /\{\{project\}\}/);
  assert.match(read(".gemini/commands/agent-infra/init-labels.toml"), /agent-infra/);
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

  assert.match(read("templates/.claude/CLAUDE.md"), /Type `\/` in the prompt to see the full list with descriptions/);
  assert.match(read("templates/.claude/CLAUDE.zh-CN.md"), /输入 `\/` 查看完整列表和描述/);
  assert.match(read(".claude/CLAUDE.md"), /输入 `\/` 查看完整列表和描述/);
  assert.match(read("templates/.gemini/commands/_project_/init-milestones.toml"), /\{\{project\}\}/);
  assert.match(read("templates/.gemini/commands/_project_/init-milestones.zh-CN.toml"), /\{\{project\}\}/);
  assert.doesNotMatch(read(".gemini/commands/agent-infra/init-milestones.toml"), /\{\{project\}\}/);
  assert.match(read(".gemini/commands/agent-infra/init-milestones.toml"), /agent-infra/);
});

test("sync-issue skill documents label sync and development linking", () => {
  const corpus = skillContentPaths("sync-issue").map(read).join("\n");

  [
    /gh label list --search "type:"/,
    /init-labels/,
    /--add-label/,
    /--remove-label/,
    /status: blocked/,
    /status: in-progress/,
    /status: pending-design-work/,
    /current_step` ∈ \{`implementation`, `code-review`, `refinement`\}/,
    /gh issue edit \{issue-number\} --add-label "in: \{module\}"/,
    /gh pr view \{pr-number\}/,
    /gh issue view \{issue-number\} --json milestone/,
    /milestone` 字段|`milestone` field/,
    /git branch --show-current/,
    /git branch -a \| grep -oE '\[0-9\]\+\\\.\[0-9\]\+\\\.x'/,
    /General Backlog/,
    /Milestone[:：]|milestone 继承|Milestone Sync/,
    /Closes #\{issue-number\}/,
    /Fixes #\{issue-number\}/,
    /Resolves #\{issue-number\}/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });

  skillDocPaths("sync-issue").forEach((relativePath) => {
    const content = read(relativePath);
    const stepNumbers = [...content.matchAll(/^### (\d+)\. /gm)]
      .map((match) => Number(match[1]));
    const expected = stepNumbers.map((_, index) => index + 1);

    assert.deepEqual(stepNumbers, expected, `${relativePath} steps should be consecutively numbered from 1`);
  });

  assert.doesNotMatch(corpus, /gh issue edit \{issue-number\} --add-label "\{type-label\}"/);
  assert.doesNotMatch(corpus, /\| bug(?:、|, )bugfix \| `type: bug` \|/);
});

test("sync-issue skill accepts issue numbers and keeps task-id compatibility", () => {
  const corpus = skillContentPaths("sync-issue").map(read).join("\n");

  [
    /Accept either `task-id` or issue number input|同时接受 `task-id` 和 issue number/,
    /grep -rl "\^issue_number: \{issue-number\}\$"/,
    /No task found associated with Issue #\{issue-number\}/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("sync-issue skill documents issue type sync, timeline comments, and absolute links", () => {
  const corpus = skillContentPaths("sync-issue").map(read).join("\n");

  [
    /gh api "orgs\/\$owner\/issue-types"/,
    /Issue Type workflow|issue-types/,
    /\| `bug`, `bugfix` \| `Bug` \|/,
    /\| `feature`, `enhancement` \| `Feature` \|/,
    /<!-- sync-issue:\{task-id\}:\{file-stem\} -->/,
    /\/→\\s\+\(\\S\+\\\.md\)\\s\*\$\//,
    /按 Activity Log 顺序构建|Activity Log order/,
    /Only include files that still exist in the task directory|artifacts whose files still exist/,
    /\| task lives under `blocked\/` \| add `status: blocked` \|/,
    /\| Scenario A: completed \| add no new `status:` label \|/,
    /\| Scenario B: PR is `OPEN` \| add `status: in-progress` \|/,
    /\| commit is already on a protected branch \| Scenario A: Completed \|/,
    /\| PR exists and its state is `OPEN` or `MERGED` \| Scenario B: PR stage \|/,
    /main` or `master`|protected release line/,
    /Inference scenarios when `task\.md` does not set `milestone` explicitly/,
    /Scenario A: if the current branch matches `\{major\}\.\{minor\}\.x`/,
    /Scenario B: if the current branch is `main` or `master`/,
    /Scenario C fallback: if no branch or tag rule yields a version line, fall back to `General Backlog`/,
    /\(X\+1\)\.0\.x/,
    /latest `vX\.Y\.Z` tag and fall back to `X\.Y\.x`/,
    /\| `summary` \| `交付摘要` \|/,
    /summary 评论顺序|Keep `summary` last|`summary` is always last/,
    /has_unpublished_artifacts=true/,
    /delete the old `summary` and recreate it at the end/,
    /content is unchanged, do nothing/,
    /Do not fall back to a fixed .*summary order|fixed `analysis -> plan -> implementation -> review -> summary` order/,
    /gh api "repos\/\$repo\/issues\/comments\/\{summary_comment_id\}" -X PATCH|Issue comments/,
    /https:\/\/github\.com\/\{owner\}\/\{repo\}\/commit\/\{commit-hash\}/,
    /https:\/\/github\.com\/\{owner\}\/\{repo\}\/pull\/\{pr-number\}/,
    /implementation-r\*\.md/,
    /review-r\*\.md/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });

  assert.doesNotMatch(corpus, /<!-- sync-issue:\{task-id\}:\{step\} -->/);
  assert.doesNotMatch(corpus, /类型优先级：`analysis` = 1，`plan` = 2，`implementation\*` = 3，`review\*` = 4，`summary` = 5|Type priority: `analysis` = 1, `plan` = 2, `implementation\*` = 3, `review\*` = 4, `summary` = 5/);
  assert.doesNotMatch(corpus, /按 `analysis → plan → implementation → review → summary` 的固定顺序处理|Process steps strictly in the fixed order `analysis → plan → implementation → review → summary`\./);
  assert.doesNotMatch(corpus, /\.\.\/\.\.\/commit\/\{commit-hash\}/);
  assert.doesNotMatch(corpus, /\.\.\/\.\.\/pull\/\{pr-number\}/);
});

test("sync-pr skill documents metadata sync and idempotent summary", () => {
  const corpus = skillContentPaths("sync-pr").map(read).join("\n");

  [
    /repo="\$\(gh repo view --json nameWithOwner --jq '\.nameWithOwner'\)"/,
    /<!-- sync-pr:\{task-id\}:summary -->/,
    /gh pr edit \{pr-number\} --add-label|type label/,
    /gh label list --search "type:"/,
    /init-labels|type label/,
    /type: bug|review summary/,
    /in: \{module\}/,
    /--milestone/,
    /Closes #\{issue-number\}/,
    /gh api "repos\/\$repo\/issues\/comments\/\{comment-id\}" -X PATCH|Issues comments API/,
    /PR #\{number\} is closed\/merged, metadata sync skipped/,
    /date "\+%Y-%m-%d %H:%M:%S"/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });

  skillDocPaths("sync-pr").forEach((relativePath) => {
    const content = read(relativePath);
    const stepNumbers = [...content.matchAll(/^### (\d+)\. /gm)]
      .map((match) => Number(match[1]));
    const expected = stepNumbers.map((_, index) => index + 1);

    assert.deepEqual(stepNumbers, expected, `${relativePath} steps should be consecutively numbered from 1`);
  });
});

test("create-pr skill documents metadata sync step", () => {
  const corpus = skillContentPaths("create-pr").map(read).join("\n");

  [
    /--add-label/,
    /--milestone/,
    /\| bug(?:、|, )bugfix \| `type: bug` \||type label/,
    /Closes #\{issue-number\}/,
    /sync-pr/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });

  assert.doesNotMatch(corpus, /复用 `sync-pr` 的 type label 映射|Reuse the same type-label mapping as `sync-pr`/);
});

test("commit skill preserves status branching, co-author mapping, and copyright examples", () => {
  const corpus = skillContentPaths("commit").map(read).join("\n");

  [
    /reference\/task-status-update\.md/,
    /Decision Basis|判断依据/,
    /Case 1: final commit|情况 1：最终提交/,
    /Case 2: more work remains|情况 2：还有后续工作/,
    /Case 3: ready for review|情况 3：准备审查/,
    /Case 4: ready for PR|情况 4：准备创建 PR/,
    /\/complete-task \{task-id\}/,
    /\/agent-infra:review-task \{task-id\}/,
    /\$create-pr/,
    /Co-Authored-By: Claude <noreply@anthropic\.com>/,
    /Co-Authored-By: Codex <noreply@openai\.com>/,
    /Co-Authored-By: Gemini <noreply@google\.com>/,
    /Co-Authored-By: OpenCode <noreply@opencode\.ai>/,
    /Co-Authored-By: \{Agent\} <noreply@unknown>/,
    /Copyright \(C\) 2024-2025.*2024-\{CURRENT_YEAR\}/,
    /Copyright \(C\) 2024.*2024-\{CURRENT_YEAR\}/,
    /Copyright \(C\) 2025.*Copyright \(C\) \{CURRENT_YEAR\}/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
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
    "analyze-task",
    "block-task",
    "close-codescan",
    "close-dependabot",
    "commit",
    "complete-task",
    "create-pr",
    "create-task",
    "import-codescan",
    "import-dependabot",
    "import-issue",
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

test("implement-task skill resolves the latest versioned plan artifact", () => {
  skillDocPaths("implement-task").forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /plan\.md` or `plan-r\{N\}\.md|`plan\.md` 或 `plan-r\{N\}\.md`/,
      /highest-round plan file|最高轮次的方案文件/,
      /\{plan-artifact\}/,
      /Attempt to fix the issue and re-run tests first|先尝试修复并重新运行测试/,
      /external blocker, missing environment, or unclear requirement|外部阻塞、环境缺失或需求不明确/
    ]);
  });
});

test("import alert skills define boundaries and completion checklists", () => {
  ["import-codescan", "import-dependabot"].forEach((skill) => {
    skillDocPaths(skill).forEach((relativePath) => {
      assertContainsPatterns(relativePath, [
        /行为边界 \/ 关键规则|Boundary \/ Critical Rules/,
        /完成检查清单|Completion Checklist/
      ]);
    });
  });
});

test("review-task activity log guidance uses English summary fields", () => {
  skillDocPaths("review-task").forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(
      content,
      /Verdict: \{Approved\/Changes Requested\/Rejected\}, blockers: \{n\}, major: \{n\}, minor: \{n\}/,
      `${relativePath} should use English Activity Log summary fields`
    );
    assert.doesNotMatch(
      content,
      /结论：\{已批准\/需要修改\/拒绝\}，阻塞项：\{n\}，主要问题：\{n\}，次要问题：\{n\}/,
      `${relativePath} should not use mixed-language Activity Log summary fields`
    );
  });
});

test("import-issue skill uses the shared boundary section format", () => {
  skillDocPaths("import-issue").forEach((relativePath) => {
    const content = read(relativePath);

    assertContainsPatterns(relativePath, [
      /行为边界 \/ 关键规则|Boundary \/ Critical Rules/,
      /唯一产出是 `task\.md`|only output is `task\.md`/,
      /执行本技能后，你\*\*必须\*\*立即更新任务状态|After executing this skill, you \*\*must\*\* immediately update task status/
    ]);

    assert.doesNotMatch(content, /## 关键：行为边界/);
    assert.doesNotMatch(content, /## 关键：状态更新要求/);
  });
});

test("create-issue skill limits issue content to task.md and writes back issue_number", () => {
  const corpus = skillContentPaths("create-issue").map(read).join("\n");

  [
    /行为边界 \/ 关键规则|Boundary \/ Critical Rules/,
    /仅从 `task\.md` 创建|from `task\.md` only/,
    /不要读取 `analysis\.md`、`plan\.md`、`implementation\.md`|Do not read `analysis\.md`, `plan\.md`, `implementation\.md`/,
    /gh auth status/,
    /ISSUE_TEMPLATE/,
    /fallback|兜底/,
    /`labels:`/,
    /`milestone`/,
    /--milestone/,
    /issue-types/,
    /-X PATCH -f type="\{issue-type\}"/,
    /textarea/,
    /dropdown/,
    /checkboxes/,
    /gh issue create --title/,
    /`issue_number`/,
    /sync-issue/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("create-issue skill keeps template candidates, fallback mappings, and sync-issue next steps", () => {
  const corpus = skillContentPaths("create-issue").map(read).join("\n");

  [
    /bug_report\.yml/,
    /feature_request\.yml/,
    /\| `bug`, `bugfix` \| `type: bug` \|/,
    /\| `feature` \| `type: feature` \|/,
    /\| `bug`, `bugfix` \| `Bug` \|/,
    /General Backlog/,
    /Do not remove existing `in:` labels|Do not fail Issue creation/,
    /\/agent-infra:sync-issue \{task-id\}/,
    /\$sync-issue \{task-id\}/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("refine-task records the implementation artifact during prerequisite discovery", () => {
  skillDocPaths("refine-task").forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /记录 `\{implementation-artifact\}`|Record `\{implementation-artifact\}`/
    ]);
  });
});

test("refine-task skill keeps re-review decision rules and output template", () => {
  const corpus = skillContentPaths("refine-task").map(read).join("\n");

  [
    /if this round fixed any `Blocker` or `Major`, recommend re-review by default/,
    /never present direct commit as the only next step/,
    /\/agent-infra:review-task \{task-id\}/,
    /\$commit/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("review-task skill keeps verdict branch templates and prohibitions", () => {
  const corpus = skillContentPaths("review-task").map(read).join("\n");

  [
    /reference\/output-templates\.md/,
    /if `Blocker > 0`, never output an approval template/,
    /\/agent-infra:refine-task \{task-id\}/,
    /\/agent-infra:implement-task \{task-id\}/,
    /\$commit/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("create-pr skill keeps metadata sync order and ordered next steps", () => {
  const corpus = skillContentPaths("create-pr").map(read).join("\n");

  [
    /gh issue view \{issue-number\} --json labels,milestone/,
    /\| `refactor`, `refactoring` \| `type: enhancement` \|/,
    /resolve milestone in order: PR -> task\.md -> Issue -> branch\/tag inference -> `General Backlog`/,
    /never present `complete-task` as the only next step/,
    /\/agent-infra:sync-pr \{task-id\}/,
    /\$complete-task \{task-id\}/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("sync-pr skill keeps milestone inference and reviewer-summary content rules", () => {
  const corpus = skillContentPaths("sync-pr").map(read).join("\n");

  [
    /\(X\+1\)\.0\.x/,
    /inherit the Issue milestone/,
    /self-contained technical decisions/,
    /avoid internal shorthand such as `Plan A\/B`|避免使用 `方案 A\/B`/,
    /review-history table/,
    /\| 轮次 \| 结论 \| 问题统计 \| 修复状态 \||\| Round \| Verdict \| Finding Counts \| Fix Status \|/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("implement-task reference keeps the two-way test-failure handling", () => {
  const corpus = skillContentPaths("implement-task").map(read).join("\n");

  [
    /Two-way failure handling/,
    /implementation-caused failures/,
    /external blockers/,
    /do not mark implementation complete in `task\.md`/,
    /do not output the normal success\/next-step template/
  ].forEach((pattern) => {
    assert.match(corpus, pattern);
  });
});

test("plan-task clarifies how to choose the latest analysis artifact", () => {
  skillDocPaths("plan-task").forEach((relativePath) => {
    assertContainsPatterns(relativePath, [
      /如果存在 `analysis-r\{N\}\.md`，读取最高 N 的文件|If any `analysis-r\{N\}\.md` exists, read the highest N file/,
      /否则读取 `analysis\.md`|otherwise read `analysis\.md`/
    ]);
  });
});

test("analyze-task activity log uses the analysis artifact placeholder", () => {
  skillDocPaths("analyze-task").forEach((relativePath) => {
    const content = read(relativePath);

    assert.match(
      content,
      /Analysis completed → \{analysis-artifact\}/,
      `${relativePath} should use the analysis-artifact placeholder`
    );
    assert.doesNotMatch(
      content,
      /\{artifact-filename\}/,
      `${relativePath} should not use the generic artifact-filename placeholder`
    );
  });
});
