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

// Soft size guard: SKILL.md bodies should stay lean (long rules/templates/scripts
// belong in reference/ or scripts/). Per the design decision this is a visibility
// signal, not a red light — oversize files emit a diagnostic but never fail.
const SKILL_SOFT_LINE_LIMIT = 300;

test("source SKILL.md files stay within the soft size limit", (t) => {
  listSkillNames().forEach((name) => {
    const relativePath = `.agents/skills/${name}/SKILL.md`;
    const lineCount = read(relativePath).split("\n").length;
    if (lineCount > SKILL_SOFT_LINE_LIMIT) {
      t.diagnostic(
        `${relativePath} is ${lineCount} lines (> ${SKILL_SOFT_LINE_LIMIT} soft limit); ` +
        "consider splitting detail into reference/."
      );
    }
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
    "review-analysis": { en: ["State Check", "Evidence", "Self-Doubt"], zh: ["状态核对", "证据原文", "自我质疑"] },
    "plan-task": { en: ["State Check"], zh: ["状态核对"] },
    "review-plan": { en: ["State Check", "Evidence", "Self-Doubt"], zh: ["状态核对", "证据原文", "自我质疑"] },
    "code-task": { en: ["State Check", "Evidence"], zh: ["状态核对", "证据原文"] },
    "review-code": { en: ["State Check", "Evidence", "Self-Doubt"], zh: ["状态核对", "证据原文", "自我质疑"] },
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

test("review report templates include the self-doubt section", () => {
  const selfDoubtCases: Array<[string, string]> = [
    [".agents/skills/review-analysis/reference/report-template.md", "## 自我质疑"],
    [".agents/skills/review-plan/reference/report-template.md", "## 自我质疑"],
    [".agents/skills/review-code/reference/report-template.md", "## 自我质疑"],
    ["templates/.agents/skills/review-analysis/reference/report-template.zh-CN.md", "## 自我质疑"],
    ["templates/.agents/skills/review-plan/reference/report-template.zh-CN.md", "## 自我质疑"],
    ["templates/.agents/skills/review-code/reference/report-template.zh-CN.md", "## 自我质疑"],
    ["templates/.agents/skills/review-analysis/reference/report-template.en.md", "## Self-Doubt"],
    ["templates/.agents/skills/review-plan/reference/report-template.en.md", "## Self-Doubt"],
    ["templates/.agents/skills/review-code/reference/report-template.en.md", "## Self-Doubt"],
  ];

  selfDoubtCases.forEach(([relativePath, heading]) => {
    assert.match(read(relativePath), new RegExp(escapeRegExp(heading)));
  });
});

test("review report templates record the reviewed artifact", () => {
  // Each review stage's report template must demonstrate the actually reviewed
  // upstream artifact as a backtick-wrapped filename in the Review Input field,
  // not only the `{...-artifact}` placeholder, so the recorded-artifact contract
  // cannot silently regress. Structural check only (field block + filename shape).
  const ANALYSIS = /`analysis(?:-r\d+)?\.md`/;
  const PLAN = /`plan(?:-r\d+)?\.md`/;
  const CODE = /`code(?:-r\d+)?\.md`/;
  const reviewInputCases: Array<[string, string, RegExp]> = [
    [".agents/skills/review-analysis/reference/report-template.md", "审查输入", ANALYSIS],
    ["templates/.agents/skills/review-analysis/reference/report-template.zh-CN.md", "审查输入", ANALYSIS],
    ["templates/.agents/skills/review-analysis/reference/report-template.en.md", "Review Input", ANALYSIS],
    [".agents/skills/review-plan/reference/report-template.md", "审查输入", PLAN],
    ["templates/.agents/skills/review-plan/reference/report-template.zh-CN.md", "审查输入", PLAN],
    ["templates/.agents/skills/review-plan/reference/report-template.en.md", "Review Input", PLAN],
    [".agents/skills/review-code/reference/report-template.md", "审查输入", CODE],
    ["templates/.agents/skills/review-code/reference/report-template.zh-CN.md", "审查输入", CODE],
    ["templates/.agents/skills/review-code/reference/report-template.en.md", "Review Input", CODE],
  ];

  // Collect the Review Input field header line plus its indented sub-bullets.
  const extractReviewInputBlock = (content: string, field: string): string => {
    const headerPattern = new RegExp(`\\*\\*${escapeRegExp(field)}\\*\\*`);
    const block: string[] = [];
    let inBlock = false;
    for (const line of content.split(/\r?\n/)) {
      if (headerPattern.test(line)) {
        inBlock = true;
        block.push(line);
        continue;
      }
      if (!inBlock) continue;
      if (/^\s+[-*]\s/.test(line)) {
        block.push(line);
        continue;
      }
      break;
    }
    return block.join("\n");
  };

  reviewInputCases.forEach(([relativePath, field, artifactPattern]) => {
    const content = read(relativePath);
    assert.match(content, new RegExp(`\\*\\*${escapeRegExp(field)}\\*\\*`));

    const block = extractReviewInputBlock(content, field);
    assert.match(block, artifactPattern);
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

test("review criteria require checking missed human-decision markings", () => {
  const criteriaFiles = [
    ".agents/skills/review-analysis/reference/review-criteria.md",
    ".agents/skills/review-plan/reference/review-criteria.md",
    ".agents/skills/review-code/reference/review-criteria.md",
    "templates/.agents/skills/review-analysis/reference/review-criteria.en.md",
    "templates/.agents/skills/review-plan/reference/review-criteria.en.md",
    "templates/.agents/skills/review-code/reference/review-criteria.en.md",
    "templates/.agents/skills/review-analysis/reference/review-criteria.zh-CN.md",
    "templates/.agents/skills/review-plan/reference/review-criteria.zh-CN.md",
    "templates/.agents/skills/review-code/reference/review-criteria.zh-CN.md"
  ];

  criteriaFiles.forEach((relativePath) => {
    const checklistItems = [...read(relativePath).matchAll(/^- \[ \] .+$/gm)]
      .map((match) => match[0]);

    assert.ok(
      checklistItems.some((item) => item.includes("[needs-human-decision]")),
      `${relativePath} should include a checklist item for missed human-decision markings`
    );
  });
});

test("review output guidance defines a pending human-decision pre-block", () => {
  // The shared block is defined once in next-step-output.md (source + both mirrors).
  const ruleSources: Array<[string, string]> = [
    [".agents/rules/next-step-output.md", "## 人工裁决待办前置块"],
    ["templates/.agents/rules/next-step-output.zh-CN.md", "## 人工裁决待办前置块"],
    ["templates/.agents/rules/next-step-output.en.md", "## Pending human-decision pre-block"]
  ];
  ruleSources.forEach(([relativePath, heading]) => {
    assert.match(
      read(relativePath),
      new RegExp(`^${escapeRegExp(heading)}`, "m"),
      `${relativePath} should define the pending human-decision pre-block section`
    );
  });

  // Each review output template (source + both mirrors) points at the shared block.
  const reviewSkills = ["review-analysis", "review-plan", "review-code"];
  const templatePointers: Array<[string, string]> = [];
  reviewSkills.forEach((skill) => {
    templatePointers.push([`.agents/skills/${skill}/reference/output-templates.md`, "人工裁决待办前置块"]);
    templatePointers.push([`templates/.agents/skills/${skill}/reference/output-templates.zh-CN.md`, "人工裁决待办前置块"]);
    templatePointers.push([`templates/.agents/skills/${skill}/reference/output-templates.en.md`, "Pending human-decision pre-block"]);
  });
  templatePointers.forEach(([relativePath, token]) => {
    assert.ok(
      read(relativePath).includes(token),
      `${relativePath} should reference the pending human-decision pre-block ("${token}")`
    );
  });
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
    [".agents/skills/analyze-task/SKILL.md", "优先级重估"],
    [".agents/skills/plan-task/SKILL.md", "工作量重估"],
    ["templates/.agents/skills/analyze-task/SKILL.en.md", "Priority Re-estimate"],
    ["templates/.agents/skills/plan-task/SKILL.en.md", "Effort Re-estimate"],
    ["templates/.agents/skills/analyze-task/SKILL.zh-CN.md", "优先级重估"],
    ["templates/.agents/skills/plan-task/SKILL.zh-CN.md", "工作量重估"]
  ];

  targets.forEach(([relativePath, reEstimateSectionHeading]) => {
    const content = read(relativePath);

    assert.match(
      content,
      new RegExp(escapeRegExp(reEstimateSectionHeading), "i"),
      `${relativePath} should name its re-estimate artifact section heading`
    );
  });
});

test("review-code EN verify config locks down Overall Verdict value range", () => {
  const enConfig = JSON.parse(read("templates/.agents/skills/review-code/config/verify.en.json"));
  const verdictPattern = (enConfig.checks.artifact.required_patterns as string[])
    .find((p) => p.includes("Overall Verdict"));
  assert.ok(verdictPattern, "EN verify config should include an Overall Verdict pattern");

  // 与 validate-artifact.js:366 同形（multiline, 无 case-insensitive）。
  const re = new RegExp(verdictPattern, "m");

  // (A-a-en) 非规范组合短语：fail
  const badEn = "## Review Summary\n\n- **Overall Verdict**: Approved with issues\n";
  assert.ok(!re.test(badEn), "combined phrase 'Approved with issues' must not match EN verdict regex");

  // (A-b-en) 规范 token（含全角冒号、尾随空格变体）：pass
  for (const sample of [
    "## Review Summary\n\n- **Overall Verdict**: Approved\n",
    "## Review Summary\n\n- **Overall Verdict**: Changes Requested\n",
    "## Review Summary\n\n- **Overall Verdict**: Rejected\n",
    "## Review Summary\n\n- **Overall Verdict**：Approved\n",
    "## Review Summary\n\n- **Overall Verdict**: Approved   \n"
  ]) {
    assert.ok(re.test(sample), `canonical EN sample should match: ${sample.trim()}`);
  }
});

test("analyze-task brainstorming gate adds step 4 and whitelists analyze-task in no-mid-flow rule", () => {
  const analyzeVariants = [
    ".agents/skills/analyze-task/SKILL.md",
    "templates/.agents/skills/analyze-task/SKILL.zh-CN.md",
    "templates/.agents/skills/analyze-task/SKILL.en.md"
  ];

  analyzeVariants.forEach((relativePath) => {
    const stepNumbers = [...read(relativePath).matchAll(/^### (\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(
      stepNumbers,
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      `${relativePath} should expose the requirement-sufficiency gate as a new step 4 with steps numbered 1..9`
    );
  });

  const ruleVariants = [
    ".agents/rules/no-mid-flow-questions.md",
    "templates/.agents/rules/no-mid-flow-questions.zh-CN.md",
    "templates/.agents/rules/no-mid-flow-questions.en.md"
  ];

  ruleVariants.forEach((relativePath) => {
    assert.match(
      read(relativePath),
      /`analyze-task`/,
      `${relativePath} should whitelist analyze-task for entry-point sufficiency clarification`
    );
  });

  assert.equal(
    read(".agents/skills/analyze-task/SKILL.md"),
    read("templates/.agents/skills/analyze-task/SKILL.zh-CN.md"),
    "deployed analyze-task SKILL should stay byte-identical to its zh-CN template variant"
  );
  assert.equal(
    read(".agents/rules/no-mid-flow-questions.md"),
    read("templates/.agents/rules/no-mid-flow-questions.zh-CN.md"),
    "deployed no-mid-flow-questions rule should stay byte-identical to its zh-CN template variant"
  );
});

test("import-issue step 1 declares a structured title-derivation contract", () => {
  // Structural guard for the CC-prefix stripping rule (Issue #494). The assertable
  // object is a fenced, language-neutral contract block parsed by key (not prose
  // tokens), so it verifies the strip *direction* and the boundary semantics rather
  // than just word presence — per .agents/rules/testing-discipline.md (structural
  // checks, no keyword-semantic assertions). A doc reading "do not strip ..." cannot
  // satisfy strip-prefix + the removal examples below.
  const REQUIRED_KEYS = [
    "strip-prefix",
    "prefix-types",
    "single-layer-only",
    "preserve-body-colon",
    "keep-when-no-prefix"
  ];
  const contracts: string[] = [];

  skillDocPaths("import-issue").forEach((relativePath) => {
    const content = read(relativePath);
    const step1 = content.match(/^### 1\. [\s\S]*?(?=^### \d+\. )/m)?.[0] || "";
    assert.ok(step1, `${relativePath} should expose a step 1 section`);

    const block = step1.match(/```[a-z]*\n# title-derivation-contract\n([\s\S]*?)\n```/m)?.[1];
    assert.ok(block, `${relativePath} step 1 should declare a fenced "# title-derivation-contract" block`);

    const entries: Record<string, string> = {};
    const examples: string[] = [];
    block!.split("\n").forEach((line) => {
      const match = line.match(/^([a-z][a-z-]*):[ \t]*(.*)$/);
      if (!match) return;
      const key = match[1];
      if (key === undefined) return;
      const value = match[2] ?? "";
      if (key.startsWith("example")) examples.push(value);
      else entries[key] = value;
    });

    REQUIRED_KEYS.forEach((key) => {
      assert.ok(key in entries, `${relativePath} contract should declare "${key}"`);
    });
    assert.match(entries["strip-prefix"] ?? "", /type\(scope\)/, `${relativePath} strip-prefix should target the type(scope) prefix`);
    assert.equal(entries["single-layer-only"], "true", `${relativePath} should strip only one prefix layer`);
    assert.equal(entries["preserve-body-colon"], "true", `${relativePath} should preserve description colons`);
    assert.equal(entries["keep-when-no-prefix"], "true", `${relativePath} should keep titles that have no prefix`);
    assert.ok(
      examples.filter((example) => example.includes("=>")).length >= 3,
      `${relativePath} contract should include >=3 transform examples (strip / keep / single-layer)`
    );

    contracts.push(block!.trim());
  });

  assert.ok(contracts.length >= 1, "import-issue should expose at least one skill doc variant");
  // Language-neutral contract: identical across deployed + EN + zh-CN variants (no drift).
  contracts.forEach((block) => {
    assert.equal(block, contracts[0], "title-derivation contract should be byte-identical across all import-issue variants");
  });
});

test("commit skill push-to-existing-PR step keeps level-2 steps numbered 1..9", () => {
  // commit SKILL uses level-2 (`## N.`) step headings, which the generic
  // consecutive-numbering test (level-3 `### N.`) does not cover. After
  // inserting "Push to the Existing PR" as step 5, guard that all three
  // variants stay consecutively numbered 1..9. Structural check only — no
  // step-title/prose matching (see .agents/rules/testing-discipline.md).
  const commitVariants = [
    ".agents/skills/commit/SKILL.md",
    "templates/.agents/skills/commit/SKILL.zh-CN.md",
    "templates/.agents/skills/commit/SKILL.en.md"
  ];

  commitVariants.forEach((relativePath) => {
    const stepNumbers = [...read(relativePath).matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(
      stepNumbers,
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      `${relativePath} should keep level-2 steps consecutively numbered 1..9 after adding the push step`
    );
  });
});

test("deployed create-issue rule stays byte-identical to its github zh-CN template", () => {
  // create-issue body construction delegates to `ai task issue-body`; the
  // deployed copy is the rendered github zh-CN variant. Guard against drift the
  // same way analyze-task / no-mid-flow-questions are guarded above.
  assert.equal(
    read(".agents/rules/create-issue.md"),
    read("templates/.agents/rules/create-issue.github.zh-CN.md"),
    "deployed create-issue rule should stay byte-identical to its github zh-CN template variant"
  );
});
