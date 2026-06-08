import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  commandSpecs,
  escapeRegExp,
  exists,
  langTemplate,
  listFilesRecursive,
  listSkillNames,
  parseFrontmatter,
  read,
  skillDocPaths
} from "../../helpers.ts";

const skillDocFiles = [
  ...listFilesRecursive(".agents/skills"),
  ...listFilesRecursive("templates/.agents/skills")
]
  .filter((relativePath) => /\/SKILL(?:\.(?:en|zh-CN))?\.md$/.test(relativePath))
  .sort();

function sectionContent(content: string, heading: string): string {
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\n`, "m");
  const match = content.match(headingPattern);

  assert.ok(match, `Missing section: ${heading}`);
  const start = (match.index || 0) + match[0].length;
  const nextHeading = content.slice(start).search(/^## /m);
  const end = nextHeading === -1 ? content.length : start + nextHeading;

  return content.slice(start, end).trim();
}

test("all SKILL.md files have valid frontmatter", () => {
  skillDocFiles.forEach((relativePath) => {
    const frontmatter = parseFrontmatter(relativePath);
    const skillName = path.basename(path.dirname(relativePath));

    assert.ok(frontmatter, `${relativePath} should define frontmatter`);
    assert.equal(frontmatter.name, skillName, `${relativePath} should use the directory name as frontmatter name`);
    assert.ok(frontmatter.description, `${relativePath} should provide a non-empty description`);
  });
});

test("all skill doc files have consecutive step numbering", () => {
  skillDocFiles.forEach((relativePath) => {
    const stepNumbers = [...read(relativePath).matchAll(/^### (\d+)\. /gm)]
      .map((match) => Number(match[1]));

    if (stepNumbers.length === 0) {
      return;
    }

    const expected = stepNumbers.map((_, index) => index + 1);
    assert.deepEqual(stepNumbers, expected, `${relativePath} steps should be consecutively numbered from 1`);
  });
});

test("SKILL.md reference paths point to existing files", () => {
  skillDocFiles.forEach((relativePath) => {
    const content = read(relativePath);
    const references = [...content.matchAll(/reference\/[A-Za-z0-9./-]+\.md/g)]
      .map((match) => match[0]);

    [...new Set(references)].forEach((referencePath) => {
      const targetPath = path.join(path.dirname(relativePath), referencePath);
      const resolvedTargetPath = relativePath.startsWith("templates/")
        ? langTemplate(targetPath, relativePath.includes(".zh-CN.") ? "zh-CN" : "en")
        : targetPath;
      assert.ok(exists(resolvedTargetPath), `${relativePath} references missing file: ${resolvedTargetPath}`);
    });
  });
});

test("template SKILL.md files provide zh-CN variants", () => {
  listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) => /\/SKILL\.en\.md$/.test(relativePath))
    .forEach((relativePath) => {
      const zhVariant = relativePath.replace(/SKILL\.en\.md$/, "SKILL.zh-CN.md");
      assert.ok(exists(zhVariant), `Missing zh-CN skill variant: ${zhVariant}`);
    });
});

test("template skill content does not reference deprecated lifecycle names", () => {
  const deprecatedPattern = /\b(?:implement-task|refine-task|review-task)\b|(?:implementation|refinement)(?:\.md|-r\{N\}\.md)|\{(?:implementation|refinement)-[A-Za-z]+}/;
  const templateFiles = listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) => /\.(?:md|toml|yaml|json)$/.test(relativePath));

  templateFiles.forEach((relativePath) => {
    assert.doesNotMatch(read(relativePath), deprecatedPattern, `${relativePath} should use the code/review-code lifecycle`);
  });
});

test("workflow skills document state check gates", () => {
  [
    "analyze-task",
    "review-analysis",
    "plan-task",
    "review-plan",
    "code-task",
    "review-code",
    "complete-task"
  ].forEach((skill) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);
      const expectedHeading = relativePath.includes(".en.")
        ? "## Step 0: State Check (pre-execution hard gate)"
        : "## 第 0 步：状态核对（执行前硬约束）";

      assert.match(
        content,
        new RegExp(escapeRegExp(expectedHeading)),
        `${relativePath} should document the pre-execution state check`
      );
    });
  });
});

test("workflow artifact gates require state check evidence", () => {
  const sectionExpectations: Record<string, { en: string[]; zh: string[] }> = {
    "analyze-task": { en: ["State Check"], zh: ["状态核对"] },
    "review-analysis": { en: ["State Check", "Evidence"], zh: ["状态核对", "证据原文"] },
    "plan-task": { en: ["State Check"], zh: ["状态核对"] },
    "review-plan": { en: ["State Check", "Evidence"], zh: ["状态核对", "证据原文"] },
    "code-task": { en: ["State Check", "Evidence"], zh: ["状态核对", "证据原文"] },
    "review-code": { en: ["State Check", "Evidence"], zh: ["状态核对", "证据原文"] },
    "complete-task": { en: ["State Check"], zh: ["状态核对"] }
  };

  Object.entries(sectionExpectations).forEach(([skill, sectionsByLanguage]) => {
    [
      { relativePath: `.agents/skills/${skill}/config/verify.json`, sections: sectionsByLanguage.zh },
      { relativePath: `templates/.agents/skills/${skill}/config/verify.en.json`, sections: sectionsByLanguage.en },
      { relativePath: `templates/.agents/skills/${skill}/config/verify.zh-CN.json`, sections: sectionsByLanguage.zh }
    ].forEach(({ relativePath, sections }) => {
      const config = JSON.parse(read(relativePath));
      const artifact = config.checks.artifact;

      assert.ok(artifact, `${relativePath} should declare an artifact check`);
      sections.forEach((section) => {
        assert.ok(
          artifact.required_sections.includes(section),
          `${relativePath} should require the ${section} section`
        );
      });
      assert.ok(
        artifact.required_patterns.includes("^\\$ "),
        `${relativePath} should require a shell prompt evidence line`
      );
    });
  });
});

test("workflow verify configs reject invalid multiline flag patterns", () => {
  listFilesRecursive(".agents/skills")
    .concat(listFilesRecursive("templates/.agents/skills"))
    .filter((relativePath) => /\/config\/verify(\.[\w-]+)?\.json$/.test(relativePath))
    .forEach((relativePath) => {
      const config = JSON.parse(read(relativePath));

      (Object.values(config.checks || {}) as Array<{ required_patterns?: string[] }>).forEach((check) => {
        for (const pattern of check?.required_patterns || []) {
          assert.equal(
            pattern.includes("(?m)"),
            false,
            `${relativePath} should not use unsupported inline multiline flags`
          );
        }
      });
    });
});

test("workflow verify config language variants keep only artifact language fields different", () => {
  const skills = [
    "analyze-task",
    "review-analysis",
    "plan-task",
    "review-plan",
    "code-task",
    "review-code",
    "complete-task"
  ];

  skills.forEach((skill) => {
    const enPath = `templates/.agents/skills/${skill}/config/verify.en.json`;
    const zhPath = `templates/.agents/skills/${skill}/config/verify.zh-CN.json`;

    assert.ok(exists(enPath), `${skill} should provide an English verify config variant`);
    assert.ok(exists(zhPath), `${skill} should provide a zh-CN verify config variant`);
    // Guard the variant-only layout: a plain template verify.json would be ignored by language selection.
    assert.equal(exists(`templates/.agents/skills/${skill}/config/verify.json`), false);

    const enConfig = JSON.parse(read(enPath));
    const zhConfig = JSON.parse(read(zhPath));
    const enComparable = structuredClone(enConfig);
    const zhComparable = structuredClone(zhConfig);

    enComparable.checks.artifact.required_sections = [];
    zhComparable.checks.artifact.required_sections = [];
    enComparable.checks.artifact.required_patterns = [];
    zhComparable.checks.artifact.required_patterns = [];

    assert.deepEqual(enComparable, zhComparable, `${skill} variants should differ only in artifact language fields`);
    assert.deepEqual(
      JSON.parse(read(`.agents/skills/${skill}/config/verify.json`)),
      zhConfig,
      `${skill} deployed verify config should match the zh-CN variant`
    );
  });

  const reviewEn = JSON.parse(read("templates/.agents/skills/review-code/config/verify.en.json"));
  const reviewZh = JSON.parse(read("templates/.agents/skills/review-code/config/verify.zh-CN.json"));

  assert.ok(reviewEn.checks.artifact.required_patterns.includes("^### Approval Decision$"));
  assert.ok(reviewZh.checks.artifact.required_patterns.includes("^### 审查决定$"));
});

test("workflow report templates include evidence sections", () => {
  const reportTemplateCases: Array<[string, string, string]> = [
    [".agents/skills/code-task/reference/report-template.md", "## 状态核对", "## 证据原文"],
    [".agents/skills/review-analysis/reference/report-template.md", "## 状态核对", "## 证据原文"],
    [".agents/skills/review-plan/reference/report-template.md", "## 状态核对", "## 证据原文"],
    [".agents/skills/review-code/reference/report-template.md", "## 状态核对", "## 证据原文"],
    ["templates/.agents/skills/code-task/reference/report-template.zh-CN.md", "## 状态核对", "## 证据原文"],
    ["templates/.agents/skills/review-analysis/reference/report-template.zh-CN.md", "## 状态核对", "## 证据原文"],
    ["templates/.agents/skills/review-plan/reference/report-template.zh-CN.md", "## 状态核对", "## 证据原文"],
    ["templates/.agents/skills/review-code/reference/report-template.zh-CN.md", "## 状态核对", "## 证据原文"],
    ["templates/.agents/skills/code-task/reference/report-template.en.md", "## State Check", "## Evidence"],
    ["templates/.agents/skills/review-analysis/reference/report-template.en.md", "## State Check", "## Evidence"],
    ["templates/.agents/skills/review-plan/reference/report-template.en.md", "## State Check", "## Evidence"],
    ["templates/.agents/skills/review-code/reference/report-template.en.md", "## State Check", "## Evidence"],
  ];

  reportTemplateCases.forEach(([relativePath, stateHeading, evidenceHeading]) => {
    const content = read(relativePath);

    assert.match(content, new RegExp(escapeRegExp(stateHeading)));
    assert.match(content, new RegExp(escapeRegExp(evidenceHeading)));
  });
});

test("review criteria keep common review principles consistent across review stages", () => {
  const localPrinciples = [
    ".agents/skills/review-analysis/reference/review-criteria.md",
    ".agents/skills/review-plan/reference/review-criteria.md",
    ".agents/skills/review-code/reference/review-criteria.md"
  ].map((relativePath) => sectionContent(read(relativePath), "通用审查原则"));

  assert.equal(localPrinciples[0], localPrinciples[1]);
  assert.equal(localPrinciples[0], localPrinciples[2]);

  const zhPrinciples = [
    "templates/.agents/skills/review-analysis/reference/review-criteria.zh-CN.md",
    "templates/.agents/skills/review-plan/reference/review-criteria.zh-CN.md",
    "templates/.agents/skills/review-code/reference/review-criteria.zh-CN.md"
  ].map((relativePath) => sectionContent(read(relativePath), "通用审查原则"));

  assert.equal(zhPrinciples[0], zhPrinciples[1]);
  assert.equal(zhPrinciples[0], zhPrinciples[2]);

  const enPrinciples = [
    "templates/.agents/skills/review-analysis/reference/review-criteria.en.md",
    "templates/.agents/skills/review-plan/reference/review-criteria.en.md",
    "templates/.agents/skills/review-code/reference/review-criteria.en.md"
  ].map((relativePath) => sectionContent(read(relativePath), "Common Review Principles"));

  assert.equal(enPrinciples[0], enPrinciples[1]);
  assert.equal(enPrinciples[0], enPrinciples[2]);
});

test("workflow skill output instructions align with state check artifact gates", () => {
  const analyzeTaskCases: Array<[string, string]> = [
    [".agents/skills/analyze-task/SKILL.md", "## 状态核对"],
    ["templates/.agents/skills/analyze-task/SKILL.zh-CN.md", "## 状态核对"],
    ["templates/.agents/skills/analyze-task/SKILL.en.md", "## State Check"]
  ];

  analyzeTaskCases.forEach(([relativePath, heading]) => {
    assert.match(
      read(relativePath),
      new RegExp(`^${escapeRegExp(heading)}$`, "m"),
      `${relativePath} output template should include the state check section required by the gate`
    );
  });

  const completeTaskCases: Array<[string, string]> = [
    [".agents/skills/complete-task/SKILL.md", "## 状态核对"],
    ["templates/.agents/skills/complete-task/SKILL.zh-CN.md", "## 状态核对"],
    ["templates/.agents/skills/complete-task/SKILL.en.md", "## State Check"]
  ];

  completeTaskCases.forEach(([relativePath, heading]) => {
    const content = read(relativePath);
    const updateSection = content.match(/^### 3\. .+?(?=^### 4\. )/ms)?.[0] || "";

    assert.match(
      updateSection,
      new RegExp(escapeRegExp(heading)),
      `${relativePath} task update step should write the state check section required by the gate`
    );
  });
});

test("local test skill documents smoke / core / full layered commands", () => {
  const content = read(".agents/skills/test/SKILL.md");
  assert.match(content, /npm run test:smoke/, "SKILL should document the smoke layer");
  assert.match(content, /npm run test:core/, "SKILL should document the core layer");
  assert.match(content, /npm test/, "SKILL should still document the full layer");
});

test("skill command templates use thin adapter bodies", () => {
  const skills = listSkillNames();

  skills.forEach((skill) => {
    const spec = commandSpecs[skill] || {};
    const markdownTargets = [
      `templates/.claude/commands/${skill}.en.md`,
      `templates/.claude/commands/${skill}.zh-CN.md`,
      `templates/.opencode/commands/${skill}.en.md`,
      `templates/.opencode/commands/${skill}.zh-CN.md`
    ];
    const tomlTargets = [
      `templates/.gemini/commands/_project_/${skill}.en.toml`,
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

test("skills that write timestamps require date command guidance", () => {
  const timestampSkills = [
    "analyze-task",
    "block-task",
    "cancel-task",
    "close-codescan",
    "close-dependabot",
    "commit",
    "complete-task",
    "create-pr",
    "create-task",
    "import-codescan",
    "import-dependabot",
    "import-issue",
    "code-task",
    "plan-task",
    "code-task",
    "review-code"
  ];

  timestampSkills.forEach((skill) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);

      assert.match(
        content,
        /date "\+%Y-%m-%d %H:%M:%S%:z"/,
        `${relativePath} should require the date command for timestamp writes`
      );
    });
  });
});

test("workflow skill docs update task comments before publishing artifact comments", () => {
  const orderedCommentSkills: Array<[string, string]> = [
    ["analyze-task", "{analysis-artifact}"],
    ["plan-task", "{plan-artifact}"],
    ["code-task", "{code-artifact}"],
    ["review-code", "{review-artifact}"],
    ["code-task", "{code-artifact}"]
  ];

  orderedCommentSkills.forEach(([skill, artifact]) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);
      const taskCommentIndex = content.indexOf(".agents/rules/issue-sync.md");
      const artifactCommentIndex = relativePath.includes(".en.")
        ? content.indexOf(`Publish the \`${artifact}\` comment`)
        : content.indexOf(`发布 \`${artifact}\` 评论`);

      assert.notEqual(taskCommentIndex, -1, `${relativePath} should reference the task comment sync rule`);
      assert.notEqual(artifactCommentIndex, -1, `${relativePath} should include the artifact comment publish step`);
      assert.ok(
        taskCommentIndex < artifactCommentIndex,
        `${relativePath} should sync the task comment before publishing the artifact comment`
      );
    });
  });
});

test("import-issue requires task comment sync in local and template configs", () => {
  [
    ".agents/skills/import-issue/config/verify.json",
    "templates/.agents/skills/import-issue/config/verify.json"
  ].forEach((relativePath) => {
    const config = JSON.parse(read(relativePath));

    assert.equal(
      config.checks["platform-sync"]?.verify_task_comment_content,
      true,
      `${relativePath} should require task comment verification`
    );
  });
});

test("create-pr enables Issue field verification in local and template configs", () => {
  [
    ".agents/skills/create-pr/config/verify.json",
    "templates/.agents/skills/create-pr/config/verify.json"
  ].forEach((relativePath) => {
    const config = JSON.parse(read(relativePath));

    assert.equal(
      config.checks["platform-sync"]?.verify_issue_fields,
      true,
      `${relativePath} should require Issue field verification`
    );
  });
});

test("import-issue checklists include the task comment sync step", () => {
  skillDocPaths("import-issue").forEach((relativePath) => {
    const content = read(relativePath);
    const expectedChecklistItem = relativePath.includes(".en.")
      ? "- [ ] Synced the task comment to the Issue"
      : "- [ ] 同步了 task 评论到 Issue";

    assert.match(
      content,
      new RegExp(escapeRegExp(expectedChecklistItem)),
      `${relativePath} should include the task comment sync checklist item`
    );
  });
});

test("analyze-task and plan-task docs require field re-estimation in update step", () => {
  const targets: Array<[string, string]> = [
    [".agents/skills/analyze-task/SKILL.md", "重估"],
    [".agents/skills/plan-task/SKILL.md", "重估"],
    ["templates/.agents/skills/analyze-task/SKILL.en.md", "re-estimate"],
    ["templates/.agents/skills/plan-task/SKILL.en.md", "re-estimate"],
    ["templates/.agents/skills/analyze-task/SKILL.zh-CN.md", "重估"],
    ["templates/.agents/skills/plan-task/SKILL.zh-CN.md", "重估"]
  ];

  targets.forEach(([relativePath, reEstimateToken]) => {
    const content = read(relativePath);

    assert.match(
      content,
      new RegExp(escapeRegExp(reEstimateToken), "i"),
      `${relativePath} should reference the re-estimation vocabulary token`
    );
  });
});
