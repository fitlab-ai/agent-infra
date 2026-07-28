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
  renderPlaceholders,
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

test("all skill doc nested numbered lists are consecutive", () => {
  skillDocFiles.forEach((relativePath) => {
    const activeLists = new Map<number, number>();

    read(relativePath).split("\n").forEach((line, lineIndex) => {
      const item = line.match(/^( +)(\d+)\. /);
      const indentation = line.match(/^ */)?.[0].length || 0;

      if (!item) {
        if (line.trim() !== "") {
          for (const indent of activeLists.keys()) {
            if (indentation <= indent) activeLists.delete(indent);
          }
        }
        return;
      }

      const indent = item[1]!.length;
      const number = Number(item[2]);
      const expected = (activeLists.get(indent) || 0) + 1;
      assert.equal(number, expected, `${relativePath}:${lineIndex + 1} nested list should continue with ${expected}`);
      activeLists.set(indent, number);
      for (const activeIndent of activeLists.keys()) {
        if (activeIndent > indent) activeLists.delete(activeIndent);
      }
    });
  });
});

test("Git and release consumers keep write commands behind typed workflow intents", () => {
  const consumers = ["commit", "create-pr", "watch-pr", "release", "post-release", "complete-task", "code-task"];
  const mutatingGit = /^\s*git\s+(?:add|commit|push|tag|checkout|switch|reset)\b/m;
  for (const skill of consumers) {
    for (const relativePath of skillDocPaths(skill)) {
      const blocks = [...read(relativePath).matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]!);
      for (const block of blocks) assert.doesNotMatch(block, mutatingGit, `${relativePath} must delegate Git writes`);
    }
  }
  for (const relativePath of skillDocPaths("release")) assert.match(read(relativePath), /release-workflow/);
  for (const relativePath of skillDocPaths("post-release")) assert.match(read(relativePath), /release-workflow/);
  for (const skill of ["commit", "create-pr", "watch-pr"]) {
    for (const relativePath of skillDocPaths(skill)) assert.match(read(relativePath), /git-workflow/);
  }
});

test("complete-manual-validation skill docs retain completion control structures", () => {
  skillDocPaths("complete-manual-validation").forEach((relativePath) => {
    const content = read(relativePath);
    const checklistHeading = relativePath.includes(".en.")
      ? "Completion Checklist"
      : "完成检查清单";
    const checklist = sectionContent(content, checklistHeading);
    const gateCommand = "agent-infra-internal task-verify {task-id} manual-validation.completed";
    const gateIndex = content.indexOf(gateCommand);

    assert.notEqual(gateIndex, -1, `${relativePath} should include the verification gate command`);

    const afterGate = content.slice(gateIndex + gateCommand.length);
    const nextStep = afterGate.search(/^### /m);
    const gateHandling = nextStep === -1 ? afterGate : afterGate.slice(0, nextStep);

    [0, 1, 2].forEach((exitCode) => {
      assert.match(
        gateHandling,
        new RegExp(`^- .*\\b${exitCode}\\b`, "m"),
        `${relativePath} should structurally handle exit code ${exitCode}`
      );
    });
    assert.equal(
      [...checklist.matchAll(/^- \[[ x]\] /gm)].length,
      5,
      `${relativePath} should retain five completion checklist items`
    );
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

test("local entropy-check defines review checklist and report template sections", () => {
  const skill = read(".agents/skills/entropy-check/SKILL.md");
  const checklist = read(".agents/skills/entropy-check/reference/checklist.md");
  const reportTemplate = read(".agents/skills/entropy-check/reference/report-template.md");

  [
    "reference/checklist.md",
    "reference/report-template.md"
  ].forEach((referencePath) => {
    assert.match(
      skill,
      new RegExp(escapeRegExp(referencePath)),
      `.agents/skills/entropy-check/SKILL.md should reference ${referencePath}`
    );
  });

  [
    "Issue/PR",
    "SKILL.md",
    "over-design",
    "bilingual",
    "version"
  ].forEach((topic) => {
    assert.match(checklist, new RegExp(escapeRegExp(topic)), `checklist should cover ${topic}`);
  });

  [
    "状态核对",
    "审查范围",
    "发现摘要",
    "发现详情",
    "人工裁决待办",
    "后续任务建议"
  ].forEach((section) => {
    assert.match(
      reportTemplate,
      new RegExp(`^## ${escapeRegExp(section)}$`, "m"),
      `report template should define ${section}`
    );
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
    "complete-manual-validation",
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

test("workflow state-check consumers use the typed task snapshot entrypoint", () => {
  [
    "analyze-task",
    "review-analysis",
    "plan-task",
    "review-plan",
    "code-task",
    "review-code",
    "complete-manual-validation",
    "complete-task"
  ].forEach((skill) => {
    skillDocPaths(skill).forEach((relativePath) => {
      assert.ok(
        read(relativePath).includes("agent-infra-internal task-snapshot {task-id} --format text"),
        `${relativePath} should use task-snapshot`
      );
    });
  });
});

test("workflow verification consumers declare their business verification events", () => {
  const expectations: Record<string, string[]> = {
    "analyze-task": ["analyze.awaiting-input", "analyze.completed"],
    "review-analysis": ["review-analysis.completed"],
    "plan-task": ["plan.completed"],
    "review-plan": ["review-plan.completed"],
    "code-task": ["code.completed"],
    "review-code": ["review-code.completed"],
    "complete-manual-validation": ["manual-validation.completed"],
    "block-task": ["block-task.completed"],
    "cancel-task": ["cancel-task.completed"],
    "commit": ["commit.completed"],
    "complete-task": ["complete-task.preflight", "complete-task.completed"],
    "create-pr": ["create-pr.completed"],
    "create-task": ["create-task.completed"],
    "import-codescan": ["import-codescan.completed"],
    "import-dependabot": ["import-dependabot.completed"],
    "import-issue": ["import-issue.completed"],
    "watch-pr": ["watch-pr.completed"]
  };

  Object.entries(expectations).forEach(([skill, events]) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);
      events.forEach((event) => {
        assert.ok(
          content.includes(`agent-infra-internal task-verify {task-id} ${event}`),
          `${relativePath} should declare ${event}`
        );
      });
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

test("code-task report and task templates expose implementation input identity", () => {
  for (const [relativePath, heading] of [
    [".agents/skills/code-task/reference/report-template.md", "## 实现输入"],
    ["templates/.agents/skills/code-task/reference/report-template.zh-CN.md", "## 实现输入"],
    ["templates/.agents/skills/code-task/reference/report-template.en.md", "## Implementation Input"]
  ] as Array<[string, string]>) {
    assert.match(read(relativePath), new RegExp(escapeRegExp(heading)));
  }
  for (const relativePath of [
    ".agents/templates/task.md",
    "templates/.agents/templates/task.en.md",
    "templates/.agents/templates/task.zh-CN.md"
  ]) {
    const content = read(relativePath);
    for (const column of ["id", "ledger_id", "decision_evidence", "stage", "needs_implementation", "decided_at", "status", "consumed_by"]) {
      assert.ok(content.includes(column), `${relativePath} should include ${column}`);
    }
  }
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

test("review skills and criteria reference the shared review method", () => {
  const reviewSkills = ["review-analysis", "review-plan", "review-code"];
  const relativePaths = reviewSkills.flatMap((skill) => [
    `.agents/skills/${skill}/SKILL.md`,
    `.agents/skills/${skill}/reference/review-criteria.md`,
    `templates/.agents/skills/${skill}/SKILL.en.md`,
    `templates/.agents/skills/${skill}/SKILL.zh-CN.md`,
    `templates/.agents/skills/${skill}/reference/review-criteria.en.md`,
    `templates/.agents/skills/${skill}/reference/review-criteria.zh-CN.md`
  ]);

  assert.ok(exists(".agents/rules/review-method.md"));
  assert.ok(exists("templates/.agents/rules/review-method.en.md"));
  assert.ok(exists("templates/.agents/rules/review-method.zh-CN.md"));
  relativePaths.forEach((relativePath) => {
    assert.ok(
      read(relativePath).includes(".agents/rules/review-method.md"),
      `${relativePath} should reference the shared review method`
    );
  });
});

test("review method risk-lens references resolve in every language variant", () => {
  const methodFiles = [
    ".agents/rules/review-method.md",
    "templates/.agents/rules/review-method.en.md",
    "templates/.agents/rules/review-method.zh-CN.md"
  ];

  methodFiles.forEach((relativePath) => {
    const references = [...read(relativePath).matchAll(/`(\.agents\/skills\/[^`]+\/reference\/[^`]+\.md)`/g)]
      .map((match) => match[1]!);

    assert.ok(references.length > 0, `${relativePath} should register at least one risk-lens reference`);
    references.forEach((referencePath) => {
      const resolvedPath = relativePath.startsWith("templates/")
        ? langTemplate(`templates/${referencePath}`, relativePath.includes(".zh-CN.") ? "zh-CN" : "en")
        : referencePath;
      assert.ok(exists(resolvedPath), `${relativePath} references missing risk lens: ${resolvedPath}`);
    });
  });
});

test("review report templates expose shared coverage, traceability, and finding structures", () => {
  const reportCases = ["review-analysis", "review-plan", "review-code"].flatMap((skill) => [
    { relativePath: `.agents/skills/${skill}/reference/report-template.md`, coverage: "检视覆盖声明", trace: "追踪矩阵" },
    { relativePath: `templates/.agents/skills/${skill}/reference/report-template.zh-CN.md`, coverage: "检视覆盖声明", trace: "追踪矩阵" },
    { relativePath: `templates/.agents/skills/${skill}/reference/report-template.en.md`, coverage: "Review Coverage Declaration", trace: "Traceability Matrix" }
  ]);

  reportCases.forEach(({ relativePath, coverage, trace }) => {
    const content = read(relativePath);
    const coverageSection = sectionContent(content, coverage);
    const findingsSection = sectionContent(content, relativePath.includes(".en.") ? "Findings" : "问题清单");

    assert.match(content, new RegExp(`^## ${escapeRegExp(trace)}$`, "m"));
    assert.ok(
      coverageSection.includes("| pass_id | scope | evidence | result | gaps_or_assumptions |"),
      `${relativePath} should define the pass coverage table`
    );
    assert.ok(
      coverageSection.includes("| lens_id | trigger_evidence | loaded | result |"),
      `${relativePath} should define the risk-lens table`
    );
    assert.ok(
      content.includes("| source_id | upstream | reviewed_target | verification | status_or_gap |"),
      `${relativePath} should define the traceability table`
    );

    const highSeverityExamples = findingsSection.split(/^### /m).slice(1, 3);
    assert.equal(highSeverityExamples.length, 2, `${relativePath} should retain blocker and major examples`);
    highSeverityExamples.forEach((example) => {
      assert.equal(
        [...example.matchAll(/^\*\*[^*]+\*\*[:：]/gm)].length,
        7,
        `${relativePath} blocker and major examples should expose file plus six evidence fields`
      );
    });
  });
});

test("review-analysis report templates expose stage-specific coverage structures", () => {
  const reportCases: Array<[string, string]> = [
    [".agents/skills/review-analysis/reference/report-template.md", "需求分析专项覆盖"],
    ["templates/.agents/skills/review-analysis/reference/report-template.zh-CN.md", "需求分析专项覆盖"],
    ["templates/.agents/skills/review-analysis/reference/report-template.en.md", "Requirement Analysis Coverage"]
  ];
  const expectedTables = [
    "| perspective_id | applicability | reviewed_scope | evidence | result_or_gap |",
    "| quality_id | source | stakeholder | priority_or_tradeoff | verification | result_or_gap |",
    "| evolution_id | source | confirmation_status | classification | boundary_evidence | result_or_gap |",
    "| acceptance_id | observable_input | action | expected_result | status_or_gap |"
  ];
  const minimumPerspectives = ["user", "maintainer", "operations", "security", "testing"];

  reportCases.forEach(([relativePath, heading]) => {
    const content = read(relativePath);
    const coverageSection = sectionContent(content, heading);

    expectedTables.forEach((table) => {
      assert.ok(coverageSection.includes(table), `${relativePath} should define ${table}`);
    });
    minimumPerspectives.forEach((perspective) => {
      assert.ok(
        coverageSection.includes(`| ${perspective} |`),
        `${relativePath} should include the ${perspective} perspective`
      );
    });
    assert.ok(
      content.includes("| source_id | upstream | reviewed_target | verification | status_or_gap |"),
      `${relativePath} should retain the shared traceability table`
    );
  });
});

test("review-plan report templates expose architecture coverage structures", () => {
  const reportCases: Array<[string, string]> = [
    [".agents/skills/review-plan/reference/report-template.md", "技术方案架构覆盖"],
    ["templates/.agents/skills/review-plan/reference/report-template.zh-CN.md", "技术方案架构覆盖"],
    ["templates/.agents/skills/review-plan/reference/report-template.en.md", "Technical Plan Architecture Coverage"]
  ];
  const expectedTables = [
    "| assessment_id | classification | trigger_evidence | review_depth | result_or_gap |",
    "| quality_scenario_id | source_id | business_driver | quality_attribute | priority | stimulus | context | expected_response | measure | result_or_gap |",
    "| decision_id | selected_option | alternative_option | benefit | cost | assumption | rejection_reason | result_or_gap |",
    "| risk_id | decision_id | risk_or_sensitivity | affected_quality_attributes | tradeoff | mitigation_or_validation | result_or_gap |",
    "| decision_id | door_type | reversal_cost | migration_or_rollback | decision_status | result_or_gap |",
    "| evolution_id | scenario_type | source_id | confirmation_status | change_scenario | affected_scope | verification | result_or_gap |"
  ];
  const stableTokens = [
    "ordinary",
    "architecture-significant",
    "proportional",
    "mini-atam",
    "not-applicable",
    "two-way",
    "one-way"
  ];
  const scenarioTypes = ["evolution", "migration", "rollback", "compatibility", "operations"];

  reportCases.forEach(([relativePath, heading]) => {
    const content = read(relativePath);
    const coverageSection = sectionContent(content, heading);

    expectedTables.forEach((table) => {
      assert.ok(coverageSection.includes(table), `${relativePath} should define ${table}`);
    });
    [...stableTokens, ...scenarioTypes].forEach((token) => {
      assert.ok(coverageSection.includes(token), `${relativePath} should include the stable token ${token}`);
    });
    assert.ok(
      content.includes("| source_id | upstream | reviewed_target | verification | status_or_gap |"),
      `${relativePath} should retain the shared traceability table`
    );
  });
});

test("review verify configs require shared review report sections", () => {
  for (const skill of ["review-analysis", "review-plan", "review-code"]) {
    for (const [relativePath, sections] of [
      [`.agents/skills/${skill}/config/verify.json`, ["检视覆盖声明", "追踪矩阵"]],
      [`templates/.agents/skills/${skill}/config/verify.zh-CN.json`, ["检视覆盖声明", "追踪矩阵"]],
      [`templates/.agents/skills/${skill}/config/verify.en.json`, ["Review Coverage Declaration", "Traceability Matrix"]]
    ] as Array<[string, string[]]>) {
      const requiredSections = JSON.parse(read(relativePath)).checks.artifact.required_sections;
      sections.forEach((section) => {
        assert.ok(requiredSections.includes(section), `${relativePath} should require ${section}`);
      });
    }
  }
});

test("review-analysis verify configs require stage-specific coverage", () => {
  for (const [relativePath, section] of [
    [".agents/skills/review-analysis/config/verify.json", "需求分析专项覆盖"],
    ["templates/.agents/skills/review-analysis/config/verify.zh-CN.json", "需求分析专项覆盖"],
    ["templates/.agents/skills/review-analysis/config/verify.en.json", "Requirement Analysis Coverage"]
  ] as Array<[string, string]>) {
    const requiredSections = JSON.parse(read(relativePath)).checks.artifact.required_sections;

    assert.ok(requiredSections.includes(section), `${relativePath} should require ${section}`);
  }
});

test("review-plan verify configs require architecture coverage", () => {
  for (const [relativePath, section] of [
    [".agents/skills/review-plan/config/verify.json", "技术方案架构覆盖"],
    ["templates/.agents/skills/review-plan/config/verify.zh-CN.json", "技术方案架构覆盖"],
    ["templates/.agents/skills/review-plan/config/verify.en.json", "Technical Plan Architecture Coverage"]
  ] as Array<[string, string]>) {
    const requiredSections = JSON.parse(read(relativePath)).checks.artifact.required_sections;

    assert.ok(requiredSections.includes(section), `${relativePath} should require ${section}`);
  }
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
  const skills = listSkillNames().filter((skill) =>
    exists(`templates/.agents/skills/${skill}/SKILL.en.md`) ||
    exists(`templates/.agents/skills/${skill}/SKILL.zh-CN.md`) ||
    exists(`templates/.agents/skills/${skill}/SKILL.md`)
  );

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
  const portableTimestampCommand =
    `date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\\([+-][0-9][0-9]\\)\\([0-9][0-9]\\)$/\\1:\\2/'`;
  const timestampSkills = [
    "commit",
    "create-task",
    "import-codescan",
    "import-dependabot",
    "import-issue",
    "watch-pr"
  ];

  timestampSkills.forEach((skill) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);

      assert.ok(
        content.includes(portableTimestampCommand),
        `${relativePath} should require the date command for timestamp writes`
      );
    });
  });
});

test("artifact lifecycle skills use core context and events in every language variant", () => {
  for (const skill of ["analyze-task", "review-analysis", "plan-task", "review-plan", "code-task", "review-code", "complete-manual-validation"]) {
    for (const relativePath of skillDocPaths(skill)) {
      const content = read(relativePath);
      assert.match(content, /agent-infra-internal task-artifact \{task-id\} inspect --family /, `${relativePath} should resolve artifact context through the core`);
      assert.match(content, /agent-infra-internal task-event \{task-id\}/, `${relativePath} should apply lifecycle events through the core`);
    }
  }
});

test("review handshake skills submit ledger changes through structured intents", () => {
  for (const skill of ["review-analysis", "review-plan", "review-code"]) {
    for (const relativePath of skillDocPaths(skill)) {
      const content = read(relativePath);
      assert.match(content, /agent-infra-internal task-ledger \{task-id\} finding-upsert /, `${relativePath} should submit findings through the ledger core`);
      assert.match(content, /finding-review --id \{ledger-id\}/, `${relativePath} should submit review dispositions through the ledger core`);
      const stage = skill.replace("review-", "");
      assert.ok(
        content.includes(`agent-infra-internal task-ledger {task-id} stage-status --stage ${stage}`),
        `${relativePath} should derive its verdict from the shared stage status`
      );
    }
  }
  for (const skill of ["analyze-task", "plan-task"]) {
    for (const relativePath of skillDocPaths(skill)) {
      const content = read(relativePath);
      assert.match(content, /agent-infra-internal task-ledger \{task-id\} finding-respond /, `${relativePath} should submit executor responses through the ledger core`);
      assert.match(content, /decision-next-id/, `${relativePath} should inspect decision ids through the ledger core`);
      assert.match(content, /decision-upsert/, `${relativePath} should submit decision rows through the ledger core`);
    }
  }
});

test("review skill reports keep advisories outside the finding ledger", () => {
  for (const skill of ["review-analysis", "review-plan", "review-code"]) {
    const localConfig = JSON.parse(read(`.agents/skills/${skill}/config/verify.json`));
    assert.ok(localConfig.checks.artifact.required_sections.includes("非阻塞建议"));

    for (const locale of ["en", "zh-CN"]) {
      const config = JSON.parse(read(`templates/.agents/skills/${skill}/config/verify.${locale}.json`));
      const section = locale === "en" ? "Non-blocking Advisories" : "非阻塞建议";
      assert.ok(config.checks.artifact.required_sections.includes(section));
      assert.match(
        read(`templates/.agents/skills/${skill}/reference/report-template.${locale}.md`),
        new RegExp(`^## ${section}$`, "m")
      );
    }
    assert.match(read(`.agents/skills/${skill}/reference/report-template.md`), /^## 非阻塞建议$/m);
  }
});

test("review output templates reserve cross-stage commands for an advanceable ledger", () => {
  const commandBySkill: Record<string, RegExp> = {
    "review-analysis": /\/plan-task |\/agent-infra:plan-task |\/\{\{project\}\}:plan-task |\$plan-task /g,
    "review-plan": /\/code-task |\/agent-infra:code-task |\/\{\{project\}\}:code-task |\$code-task /g
  };
  for (const [skill, pattern] of Object.entries(commandBySkill)) {
    for (const locale of [null, "en", "zh-CN"] as const) {
      const relativePath = locale
        ? `templates/.agents/skills/${skill}/reference/output-templates.${locale}.md`
        : `.agents/skills/${skill}/reference/output-templates.md`;
      assert.equal(read(relativePath).match(pattern)?.length, 3, `${relativePath} should expose one three-TUI advance path`);
    }
  }

  const approvedRoutes = ["commit", "create-pr", "watch-pr", "complete-task"];
  for (const locale of [null, "en", "zh-CN"] as const) {
    const relativePath = locale
      ? `templates/.agents/skills/review-code/reference/output-templates.${locale}.md`
      : ".agents/skills/review-code/reference/output-templates.md";
    const content = read(relativePath);
    for (const route of approvedRoutes) {
      const escaped = route.replace("-", "\\-");
      const commands = new RegExp(`/(?:agent-infra:|\\{\\{project\\}\\}:)?${escaped} |\\$${escaped} `, "g");
      assert.equal(content.match(commands)?.length, 3, `${relativePath} should expose one three-TUI ${route} route`);
    }
  }
});

test("workflow warning producers submit warnings through the internal CLI", () => {
  const producerDocs = [
    ".agents/rules/issue-sync.md",
    ".agents/rules/pr-sync.md",
    ".agents/skills/create-task/SKILL.md",
    ".agents/skills/create-pr/SKILL.md",
    "templates/.agents/rules/issue-sync.github.en.md",
    "templates/.agents/rules/issue-sync.github.zh-CN.md",
    "templates/.agents/rules/pr-sync.github.en.md",
    "templates/.agents/rules/pr-sync.github.zh-CN.md",
    "templates/.agents/skills/create-task/SKILL.en.md",
    "templates/.agents/skills/create-task/SKILL.zh-CN.md",
    "templates/.agents/skills/create-pr/SKILL.en.md",
    "templates/.agents/skills/create-pr/SKILL.zh-CN.md"
  ];

  producerDocs.forEach((relativePath) => {
    assert.match(
      read(relativePath),
      /agent-infra-internal task-warning \{task-id\} add /,
      `${relativePath} should submit warnings directly through the internal CLI`
    );
  });
});

test("workflow skill docs update task comments before publishing artifact comments", () => {
  const orderedCommentSkills: Array<[string, string]> = [
    ["analyze-task", "{analysis-artifact}"],
    ["plan-task", "{plan-artifact}"],
    ["code-task", "{code-artifact}"],
    ["review-code", "{review-artifact}"]
  ];

  orderedCommentSkills.forEach(([skill, artifact]) => {
    skillDocPaths(skill).forEach((relativePath) => {
      const content = read(relativePath);
      const taskCommentIndex = content.indexOf("platform-comment sync {task-id} --kind task");
      const artifactCommentIndex = content.indexOf(`platform-comment sync {task-id} --kind artifact --artifact ${artifact}`);

      assert.notEqual(taskCommentIndex, -1, `${relativePath} should invoke task comment sync`);
      assert.notEqual(artifactCommentIndex, -1, `${relativePath} should invoke artifact comment sync`);
      assert.ok(
        taskCommentIndex < artifactCommentIndex,
        `${relativePath} should sync the task comment before publishing the artifact comment`
      );
    });
  });
});

test("platform workflow docs delegate comment mechanics to internal intents", () => {
  const requiredIntentBySkill: Record<string, string> = {
    "analyze-task": "platform-comment sync {task-id}",
    "block-task": "platform-comment sync {task-id}",
    "cancel-task": "platform-comment sync {task-id}",
    "code-task": "platform-comment sync {task-id}",
    "complete-manual-validation": "platform-comment sync {task-id}",
    "complete-task": "platform-comment sync {task-id}",
    "create-task": "platform-comment sync {task-id}",
    "import-issue": "platform-comment list --issue {issue-number}",
    "plan-task": "platform-comment sync {task-id}",
    "refine-title": "platform-context resolve",
    "restore-task": "platform-comment list --issue {issue-number}",
    "review-analysis": "platform-comment sync {task-id}",
    "review-code": "platform-comment sync {task-id}",
    "review-plan": "platform-comment sync {task-id}"
  };

  for (const [skill, intent] of Object.entries(requiredIntentBySkill)) {
    for (const relativePath of skillDocPaths(skill)) {
      assert.ok(read(relativePath).includes(intent), `${relativePath} should delegate through ${intent}`);
    }
  }
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

test("complete-task splits active preflight checks from completed-state checks", () => {
  [
    ".agents/skills/complete-task/config/verify.json",
    "templates/.agents/skills/complete-task/config/verify.en.json",
    "templates/.agents/skills/complete-task/config/verify.zh-CN.json"
  ].forEach((relativePath) => {
    const checks = JSON.parse(read(relativePath)).checks;

    assert.deepEqual(checks["platform-sync-preflight"], {
      when: "issue_number_exists",
      expected_comment_marker: "<!-- sync-issue:{task-id}:summary -->",
      verify_task_comment_content: false,
      sync_checked_requirements: true,
      verify_issue_type: true,
      verify_issue_fields: false,
      verify_milestone: true,
      verify_closed_issue_has_no_status_labels: false,
      expected_comment_marker_key: "summary"
    });
    assert.deepEqual(checks["platform-sync"], {
      when: "issue_number_exists",
      verify_task_comment_content: true,
      verify_closed_issue_has_no_status_labels: true
    });
  });
});

test("complete-task docs keep remote preflight before lifecycle and terminal sync after it", () => {
  skillDocPaths("complete-task").forEach((relativePath) => {
    const content = read(relativePath);
    const artifactSync = content.indexOf("platform-comment sync {task-id} --kind artifact");
    const preflight = content.indexOf("task-verify {task-id} complete-task.preflight");
    const lifecycle = content.indexOf("task-lifecycle {task-id} complete");
    const taskSync = content.indexOf("platform-comment sync {task-id} --kind task");
    const completedGate = content.indexOf("task-verify {task-id} complete-task.completed");

    assert.ok(artifactSync >= 0 && artifactSync < preflight, `${relativePath} should backfill artifacts before preflight`);
    assert.ok(preflight < lifecycle, `${relativePath} should run preflight before lifecycle completion`);
    assert.ok(lifecycle < taskSync, `${relativePath} should sync the terminal task comment after lifecycle completion`);
    assert.ok(taskSync < completedGate, `${relativePath} should run the completed gate after terminal task sync`);
    assert.ok(content.includes("finalization-retry"), `${relativePath} should define the retry branch identifier`);
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

  // 与 artifact check 的配置正则同形（multiline, 无 case-insensitive）。
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
    renderPlaceholders(read("templates/.agents/skills/analyze-task/SKILL.zh-CN.md"), {
      project: "agent-infra",
      org: "fitlab-ai"
    }),
    "deployed analyze-task SKILL should match its rendered zh-CN template variant"
  );
  assert.equal(
    read(".agents/rules/no-mid-flow-questions.md"),
    read("templates/.agents/rules/no-mid-flow-questions.zh-CN.md"),
    "deployed no-mid-flow-questions rule should stay byte-identical to its zh-CN template variant"
  );
});

test("task templates expose the same structured task-input contract", () => {
  const variants = [
    [".agents/templates/task.md", "任务输入", ["来源", "已确认事实与证据", "约束", "已确认决策", "候选与否决方案", "验收标准", "未决事项"]],
    ["templates/.agents/templates/task.zh-CN.md", "任务输入", ["来源", "已确认事实与证据", "约束", "已确认决策", "候选与否决方案", "验收标准", "未决事项"]],
    ["templates/.agents/templates/task.en.md", "Task Input", ["Sources", "Confirmed Facts and Evidence", "Constraints", "Confirmed Decisions", "Candidate and Rejected Options", "Acceptance Criteria", "Open Questions"]]
  ] as const;

  for (const [relativePath, heading, childHeadings] of variants) {
    const content = read(relativePath);
    const descriptionIndex = content.indexOf(relativePath.endsWith(".en.md") ? "## Description" : "## 描述");
    const taskInputIndex = content.indexOf(`## ${heading}`);
    const contextIndex = content.indexOf(relativePath.endsWith(".en.md") ? "## Context" : "## 上下文");
    assert.ok(descriptionIndex < taskInputIndex && taskInputIndex < contextIndex);
    assert.deepEqual(
      [...content.slice(taskInputIndex, contextIndex).matchAll(/^### (.+)$/gm)].map((match) => match[1]),
      childHeadings
    );
  }

  assert.equal(
    read(".agents/templates/task.md"),
    renderPlaceholders(read("templates/.agents/templates/task.zh-CN.md"), {
      project: "agent-infra",
      org: "fitlab-ai"
    })
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
