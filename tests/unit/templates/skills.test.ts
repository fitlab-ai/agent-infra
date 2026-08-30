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

test("release skills keep staging, publishing, and versioned follow-up commands ordered", () => {
  for (const relativePath of skillDocPaths("release")) {
    const content = read(relativePath);
    const prepare = content.indexOf("release-workflow prepare {version}");
    const publish = content.indexOf("release-workflow publish {version}");
    const next = content.indexOf("--skill create-release-note");
    assert.ok(prepare >= 0 && publish > prepare && next > publish, relativePath);
    assert.match(content.slice(next), /--version \{version\}/, relativePath);
  }

  for (const relativePath of skillDocPaths("create-release-note")) {
    const content = read(relativePath);
    const firstStage = content.indexOf("platform-release-notes stage");
    const publish = content.indexOf("platform-release-notes publish");
    const next = content.indexOf("--skill post-release");
    assert.ok(firstStage >= 0 && publish > firstStage && next > publish, relativePath);
    assert.match(content.slice(publish), /--expected-sha256/, relativePath);
    assert.match(content.slice(next), /--version <version>/, relativePath);
  }

  for (const relativePath of skillDocPaths("post-release")) {
    const content = read(relativePath);
    const prepare = content.indexOf("release-workflow post-prepare {version}");
    const publish = content.indexOf("release-workflow post-publish {version}");
    assert.ok(prepare >= 0 && publish > prepare, relativePath);
    assert.match(content.slice(publish), /--expected-sha256/, relativePath);
  }
});

test("post-release command templates expose and forward one version argument", () => {
  assert.equal(commandSpecs["post-release"]?.usage, "<version>");
  for (const relativePath of [
    "templates/.claude/commands/post-release.en.md",
    "templates/.claude/commands/post-release.zh-CN.md"
  ]) {
    assert.match(read(relativePath), /^usage: "\/post-release <version>"$/m, relativePath);
  }
  for (const relativePath of [
    "templates/.opencode/commands/post-release.en.md",
    "templates/.opencode/commands/post-release.zh-CN.md"
  ]) assert.match(read(relativePath), /\$ARGUMENTS/, relativePath);
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

test("run-task verification configs expose the same ordered local checks", () => {
  const files = [
    ".agents/skills/run-task/config/verify.json",
    "templates/.agents/skills/run-task/config/verify.en.json",
    "templates/.agents/skills/run-task/config/verify.zh-CN.json"
  ];
  const checks = files.map((relativePath) => Object.keys(JSON.parse(read(relativePath)).checks));
  const baseline = checks[0]!;
  assert.deepEqual(checks[1], baseline);
  assert.deepEqual(checks[2], baseline);
  assert.equal(new Set(baseline).size, baseline.length);
});

test("run-task skill variants verify route completion before preparing delegation", () => {
  for (const relativePath of skillDocPaths("run-task")) {
    const content = read(relativePath);
    const route = content.indexOf("`route`");
    const verify = content.indexOf("task-verify {task-id} run-task.completed --format text");
    const prepare = content.indexOf("`prepare --client {client}");
    assert.ok(route >= 0 && verify > route && prepare > verify, relativePath);
  }
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
    "run-manual-validation",
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
    "run-manual-validation",
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

test("review skills finalize one summary snapshot before their completion event", () => {
  const stages = [
    { skill: "review-analysis", stage: "analysis" },
    { skill: "review-plan", stage: "plan" },
    { skill: "review-code", stage: "code" }
  ];

  for (const { skill, stage } of stages) {
    for (const relativePath of skillDocPaths(skill)) {
      const content = read(relativePath);
      const finalizer = `agent-infra-internal task-review {task-id} finalize-summary --stage ${stage} --artifact {review-artifact}`;
      const completion = `agent-infra-internal task-event {task-id} ${skill}.completed`;

      assert.equal(
        content.split(finalizer).length - 1,
        1,
        `${relativePath} should call its summary finalizer exactly once`
      );
      assert.equal(
        content.match(/agent-infra-internal task-ledger \{task-id\} stage-status/g)?.length ?? 0,
        0,
        `${relativePath} should not read a second ledger snapshot`
      );
      assert.ok(
        content.indexOf(finalizer) < content.indexOf(completion),
        `${relativePath} should finalize the summary before completion`
      );
    }
  }
});

test("orchestrated lifecycle handoffs forward the execution marker to sensitive commands", () => {
  for (const relativePath of skillDocPaths("run-task")) {
    assert.ok(read(relativePath).includes("--orchestrated"), `${relativePath} should mark orchestrated handoffs`);
  }

  for (const { skill, event } of [
    { skill: "analyze-task", event: "analyze.completed" },
    { skill: "plan-task", event: "plan.completed" },
    { skill: "code-task", event: "code.completed" }
  ]) {
    for (const relativePath of skillDocPaths(skill)) {
      const line = read(relativePath).split("\n").find((entry) => entry.includes(`task-event {task-id} ${event}`));
      assert.ok(line?.includes("{execution-flag}"), `${relativePath} should forward the execution marker`);
    }
  }

  for (const { skill, stage, event } of [
    { skill: "review-analysis", stage: "analysis", event: "review-analysis.completed" },
    { skill: "review-plan", stage: "plan", event: "review-plan.completed" },
    { skill: "review-code", stage: "code", event: "review-code.completed" }
  ]) {
    for (const relativePath of skillDocPaths(skill)) {
      const lines = read(relativePath).split("\n");
      const finalizer = lines.find((entry) => entry.includes(`finalize-summary --stage ${stage}`));
      const completion = lines.find((entry) => entry.includes(`task-event {task-id} ${event}`));
      assert.ok(finalizer?.includes("{execution-flag}"), `${relativePath} should mark summary finalization`);
      assert.ok(completion?.includes("{execution-flag}"), `${relativePath} should mark review completion`);
    }
  }
});

test("review skills reuse one finalized unresolved-count snapshot for completion events", () => {
  const reviewFamilies = [
    { name: "review-analysis", stage: "analysis", event: "review-analysis.completed" },
    { name: "review-plan", stage: "plan", event: "review-plan.completed" },
    { name: "review-code", stage: "code", event: "review-code.completed" }
  ];
  const countMappings = [
    { field: "blocker", placeholder: "{unresolved-blockers}", flag: "--blockers" },
    { field: "major", placeholder: "{unresolved-major}", flag: "--major" },
    { field: "minor", placeholder: "{unresolved-minor}", flag: "--minor" }
  ];

  reviewFamilies.forEach(({ name, stage, event }) => {
    skillDocPaths(name).forEach((relativePath) => {
      const content = read(relativePath);
      const stageCommand = `agent-infra-internal task-review {task-id} finalize-summary --stage ${stage} --artifact {review-artifact}`;
      const eventCommand = `agent-infra-internal task-event {task-id} ${event}`;
      const stageIndex = content.indexOf(stageCommand);
      const eventIndex = content.indexOf(eventCommand);

      assert.equal(
        [...content.matchAll(new RegExp(escapeRegExp(stageCommand), "g"))].length,
        1,
        `${relativePath} should finalize one stage status snapshot`
      );
      assert.notEqual(eventIndex, -1, `${relativePath} should declare its completion event`);

      countMappings.forEach(({ field, placeholder, flag }) => {
        const binding = `${placeholder} = stageStatus.unresolvedFindingCounts.${field}`;
        const bindingIndex = content.indexOf(binding);

        assert.ok(stageIndex < bindingIndex, `${relativePath} should bind ${placeholder} after finalization`);
        assert.ok(bindingIndex < eventIndex, `${relativePath} should bind counts before the completion event`);
        assert.ok(
          content.includes(`${flag} ${placeholder}`),
          `${relativePath} should reuse ${placeholder} for ${flag}`
        );
      });
    });
  });
});

test("review report templates expose unresolved-count placeholders exactly once", () => {
  const reportTemplates = [
    ...["review-analysis", "review-plan", "review-code"].map(
      (name) => `.agents/skills/${name}/reference/report-template.md`
    ),
    ...["review-analysis", "review-plan", "review-code"].flatMap((name) => [
      `templates/.agents/skills/${name}/reference/report-template.zh-CN.md`,
      `templates/.agents/skills/${name}/reference/report-template.en.md`
    ])
  ];

  reportTemplates.forEach((relativePath) => {
    const content = read(relativePath);

    ["{unresolved-blockers}", "{unresolved-major}", "{unresolved-minor}"].forEach((placeholder) => {
      assert.equal(
        [...content.matchAll(new RegExp(escapeRegExp(placeholder), "g"))].length,
        1,
        `${relativePath} should contain ${placeholder} exactly once`
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
    "run-manual-validation": ["validation-run.completed"],
    "block-task": ["block-task.completed"],
    "cancel-task": ["cancel-task.completed"],
    "commit": ["commit.completed"],
    "complete-task": ["complete-task.preflight", "complete-task.completed"],
    "create-pr": ["create-pr.completed"],
    "create-task": ["create-task.completed"],
    "import-codescan": ["import-codescan.completed"],
    "import-dependabot": ["import-dependabot.completed"],
    "import-issue": ["import-issue.completed"],
    "watch-pr": ["watch-pr.completed"],
    "review-pr": ["review-pr.completed"]
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
    "complete-task",
    "run-manual-validation"
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

test("review-code report templates expose implementation coverage structures", () => {
  const reportCases: Array<[string, string]> = [
    [".agents/skills/review-code/reference/report-template.md", "代码实现专项覆盖"],
    ["templates/.agents/skills/review-code/reference/report-template.zh-CN.md", "代码实现专项覆盖"],
    ["templates/.agents/skills/review-code/reference/report-template.en.md", "Code Implementation Coverage"]
  ];
  const expectedTables = [
    "| context_id | changed_lines | related_context | uncovered_area | result_or_gap |",
    "| quality_id | applicability | evidence | result_or_gap |",
    "| acceptance_id | plan_source | implementation_location | test_or_validation_evidence | status_or_gap |"
  ];
  const qualityIds = [
    "responsibility",
    "cohesion",
    "coupling",
    "dependency-direction",
    "abstraction-fit",
    "pattern-cost",
    "change-locality",
    "testability",
    "architecture-boundary"
  ];
  const evidenceTypes = [
    "test",
    "call-chain",
    "state-transition",
    "data-flow",
    "specification-conflict",
    "file-location"
  ];

  reportCases.forEach(([relativePath, heading]) => {
    const content = read(relativePath);
    const coverageSection = sectionContent(content, heading);
    const findingsSection = sectionContent(content, relativePath.includes(".en.") ? "Findings" : "问题清单");

    expectedTables.forEach((table) => {
      assert.ok(coverageSection.includes(table), `${relativePath} should define ${table}`);
    });
    qualityIds.forEach((qualityId) => {
      assert.ok(coverageSection.includes(`| ${qualityId} |`), `${relativePath} should include ${qualityId}`);
    });
    evidenceTypes.forEach((evidenceType) => {
      assert.ok(findingsSection.includes(evidenceType), `${relativePath} should include ${evidenceType} evidence`);
    });
  });
});

test("review-code templates separate reviewed commit from committed-range diff base", () => {
  for (const relativePath of [
    ".agents/skills/review-code/SKILL.md",
    "templates/.agents/skills/review-code/SKILL.zh-CN.md",
    "templates/.agents/skills/review-code/SKILL.en.md"
  ]) {
    const content = read(relativePath);
    assert.ok(content.includes("platform-pr inspect"), `${relativePath} should inspect a bound PR`);
    assert.ok(content.includes("git merge-base"), `${relativePath} should resolve a committed-range base`);
    assert.ok(content.includes("diffBase"), `${relativePath} should pass the independent diff base to snapshot`);
  }

  for (const [relativePath, field] of [
    [".agents/skills/review-code/reference/report-template.md", "**审查差异基线**"],
    ["templates/.agents/skills/review-code/reference/report-template.zh-CN.md", "**审查差异基线**"],
    ["templates/.agents/skills/review-code/reference/report-template.en.md", "**Reviewed Diff Base**"]
  ] as Array<[string, string]>) {
    assert.ok(read(relativePath).includes(field), `${relativePath} should record ${field}`);
  }
});

test("review-code risk lenses and cross-platform reference chain stay complete", () => {
  const methodFiles = [
    ".agents/rules/review-method.md",
    "templates/.agents/rules/review-method.en.md",
    "templates/.agents/rules/review-method.zh-CN.md"
  ];
  const lensReferences: Record<string, string> = {
    "documentation-antipatterns": ".agents/skills/review-code/reference/documentation-antipatterns.md",
    "testing-discipline": ".agents/rules/testing-discipline.md",
    "security-risks": ".agents/skills/review-code/reference/security-risks.md",
    "migration-risks": ".agents/skills/review-code/reference/migration-risks.md",
    "concurrency-risks": ".agents/skills/review-code/reference/concurrency-risks.md",
    "cross-platform-risks": ".agents/skills/review-code/reference/cross-platform-risks.md"
  };
  const crossPlatformFiles = [
    ".agents/skills/review-code/reference/cross-platform-risks.md",
    "templates/.agents/skills/review-code/reference/cross-platform-risks.en.md",
    "templates/.agents/skills/review-code/reference/cross-platform-risks.zh-CN.md"
  ];
  const firstLevelRiskFiles = [
    ...crossPlatformFiles,
    ".agents/skills/review-code/reference/security-risks.md",
    ".agents/skills/review-code/reference/migration-risks.md",
    ".agents/skills/review-code/reference/concurrency-risks.md",
    "templates/.agents/skills/review-code/reference/security-risks.en.md",
    "templates/.agents/skills/review-code/reference/security-risks.zh-CN.md",
    "templates/.agents/skills/review-code/reference/migration-risks.en.md",
    "templates/.agents/skills/review-code/reference/migration-risks.zh-CN.md",
    "templates/.agents/skills/review-code/reference/concurrency-risks.en.md",
    "templates/.agents/skills/review-code/reference/concurrency-risks.zh-CN.md"
  ];

  methodFiles.forEach((relativePath) => {
    const content = read(relativePath);
    Object.entries(lensReferences).forEach(([lensId, referencePath]) => {
      assert.ok(content.includes(`| ${lensId} | code |`), `${relativePath} should register ${lensId} for code`);
      assert.ok(content.includes(`\`${referencePath}\``), `${relativePath} should route ${lensId} to ${referencePath}`);
    });
  });

  crossPlatformFiles.forEach((relativePath) => {
    const content = read(relativePath);
    assert.ok(content.includes(".agents/rules/cross-platform-tests.md"));
    ["manual-validation", "finding", "gap"].forEach((classification) => {
      assert.ok(content.includes(classification), `${relativePath} should define the ${classification} fallback`);
    });
  });
  assert.equal(
    firstLevelRiskFiles.filter((relativePath) => read(relativePath).includes(".agents/rules/cross-platform-tests.md")).length,
    crossPlatformFiles.length,
    "only the cross-platform risk references should introduce the second-level test rule"
  );
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

test("review-code verify configs require implementation coverage", () => {
  for (const [relativePath, section] of [
    [".agents/skills/review-code/config/verify.json", "代码实现专项覆盖"],
    ["templates/.agents/skills/review-code/config/verify.zh-CN.json", "代码实现专项覆盖"],
    ["templates/.agents/skills/review-code/config/verify.en.json", "Code Implementation Coverage"]
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
  for (const skill of ["analyze-task", "review-analysis", "plan-task", "review-plan", "code-task", "review-code", "complete-manual-validation", "run-manual-validation"]) {
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
        content.includes(`agent-infra-internal task-review {task-id} finalize-summary --stage ${stage} --artifact {review-artifact}`),
        `${relativePath} should derive its verdict from the finalized shared stage status`
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
  const nextSkillByReview: Record<string, string> = {
    "review-analysis": "plan-task",
    "review-plan": "code-task"
  };
  for (const [skill, nextSkill] of Object.entries(nextSkillByReview)) {
    for (const locale of [null, "en", "zh-CN"] as const) {
      const relativePath = locale
        ? `templates/.agents/skills/${skill}/reference/output-templates.${locale}.md`
        : `.agents/skills/${skill}/reference/output-templates.md`;
      const command = `agent-infra-internal agent-client next-steps --skill ${nextSkill} --task-ref {task-ref}`;
      assert.equal(
        read(relativePath).split(command).length - 1,
        1,
        `${relativePath} should expose one helper-driven advance path`
      );
    }
  }

  const approvedRoutes = ["commit", "create-pr", "watch-pr", "complete-task"];
  for (const locale of [null, "en", "zh-CN"] as const) {
    const relativePath = locale
      ? `templates/.agents/skills/review-code/reference/output-templates.${locale}.md`
      : ".agents/skills/review-code/reference/output-templates.md";
    const content = read(relativePath);
    for (const route of approvedRoutes) {
      const command = `agent-infra-internal agent-client next-steps --skill ${route} --task-ref {task-ref}`;
      assert.equal(
        content.split(command).length - 1,
        1,
        `${relativePath} should expose one helper-driven ${route} route`
      );
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

test("run-manual-validation uses complete typed comment sync intents in order", () => {
  const taskSync = "platform-comment sync {task-id} --kind task --agent {standard-agent-token}";
  const artifactSync = "platform-comment sync {task-id} --kind artifact --artifact {artifact} --agent {standard-agent-token}";

  skillDocPaths("run-manual-validation").forEach((relativePath) => {
    const content = read(relativePath);
    const taskSyncIndex = content.indexOf(taskSync);
    const artifactSyncIndex = content.indexOf(artifactSync);

    assert.notEqual(taskSyncIndex, -1, `${relativePath} should invoke the complete task comment sync intent`);
    assert.notEqual(artifactSyncIndex, -1, `${relativePath} should invoke the complete artifact comment sync intent`);
    assert.ok(
      taskSyncIndex < artifactSyncIndex,
      `${relativePath} should sync the task comment before publishing the artifact comment`
    );
  });
});

test("run-manual-validation keeps discovery, reporting, and verification structures aligned", () => {
  const skillVariants = skillDocPaths("run-manual-validation");
  const referenceVariants = [
    ".agents/skills/run-manual-validation/reference/discovery-and-execution.md",
    "templates/.agents/skills/run-manual-validation/reference/discovery-and-execution.zh-CN.md",
    "templates/.agents/skills/run-manual-validation/reference/discovery-and-execution.en.md"
  ];
  const reportAndConfigVariants = [
    [
      ".agents/skills/run-manual-validation/reference/report-template.md",
      ".agents/skills/run-manual-validation/config/verify.json"
    ],
    [
      "templates/.agents/skills/run-manual-validation/reference/report-template.zh-CN.md",
      "templates/.agents/skills/run-manual-validation/config/verify.zh-CN.json"
    ],
    [
      "templates/.agents/skills/run-manual-validation/reference/report-template.en.md",
      "templates/.agents/skills/run-manual-validation/config/verify.en.json"
    ]
  ] as const;

  skillVariants.forEach((relativePath) => {
    const content = read(relativePath);
    assert.ok(content.includes("reference/discovery-and-execution.md"));
    assert.ok(content.includes("platform-pr inspect"));
    assert.ok(content.includes("agent-infra-internal task-validate"));
  });

  referenceVariants.forEach((relativePath) => {
    assert.ok(exists(relativePath), `${relativePath} should exist`);
    const workGates = [...read(relativePath).matchAll(
      /^\| `(explicit|automatic)` \| `(any|items|empty|unreadable-only)` \| `(continue|stop)` \|$/gm
    )].map((match) => match.slice(1));
    assert.deepEqual(workGates, [
      ["explicit", "any", "continue"],
      ["automatic", "items", "continue"],
      ["automatic", "empty", "stop"],
      ["automatic", "unreadable-only", "stop"]
    ]);
  });
  assert.equal(read(referenceVariants[0]!), read(referenceVariants[1]!));

  reportAndConfigVariants.forEach(([reportPath, configPath]) => {
    const report = read(reportPath);
    const config = JSON.parse(read(configPath));

    config.checks.artifact.required_sections.forEach((heading: string) => {
      assert.ok(report.includes(`## ${heading}\n`), `${reportPath} should define the configured ${heading} section`);
    });
    assert.equal(config.checks.artifact.required_sections.length, 11);
  });
});

test("review-pr keeps the sync -> write-back -> re-sync -> verify closed-loop order (PL-8)", () => {
  const variants = [
    ".agents/skills/review-pr/SKILL.md",
    "templates/.agents/skills/review-pr/SKILL.zh-CN.md",
    "templates/.agents/skills/review-pr/SKILL.en.md"
  ];
  const artifactSync = "platform-comment sync {task-id} --kind artifact --artifact {pr-review-artifact} --agent {agent}";
  const taskSync = "platform-comment sync {task-id} --kind task --agent {agent}";
  const activityStart = "task-activity {task-id} pr-review-start";
  const activityComplete = "task-activity {task-id} pr-review-complete";
  const activityTerminate = "task-activity {task-id} pr-review-terminate";
  const decide = "pr-review-grade decide";
  const verify = "agent-infra-internal task-verify {task-id} review-pr.completed";

  variants.forEach((relativePath) => {
    const content = read(relativePath);
    const startIndex = content.indexOf(activityStart);
    const decideIndex = content.indexOf(decide);
    const firstTaskSync = content.indexOf(taskSync);
    const firstArtifactSync = content.indexOf(artifactSync);
    const completeIndex = content.indexOf(activityComplete);
    const terminateIndex = content.indexOf(activityTerminate);
    const lastTaskSync = content.lastIndexOf(taskSync);
    const lastArtifactSync = content.lastIndexOf(artifactSync);
    const verifyIndex = content.indexOf(verify);

    assert.notEqual(startIndex, -1, `${relativePath} should start task activity after host resolution`);
    assert.notEqual(terminateIndex, -1, `${relativePath} should define non-success terminal activity`);
    assert.ok(startIndex < decideIndex, `${relativePath} should write started before evidence grading`);
    assert.notEqual(firstTaskSync, -1, `${relativePath} should sync the task comment (step 4)`);
    assert.notEqual(firstArtifactSync, -1, `${relativePath} should sync the artifact comment (step 4)`);
    assert.ok(firstTaskSync < firstArtifactSync, `${relativePath} should sync task before artifact (step 4)`);
    assert.ok(firstArtifactSync < completeIndex, `${relativePath} should complete after the first sync (step 6)`);
    assert.ok(completeIndex < lastTaskSync, `${relativePath} should re-sync the task comment after write-back (step 7)`);
    assert.ok(lastTaskSync < lastArtifactSync, `${relativePath} should re-sync the artifact comment after task (step 7)`);
    assert.ok(lastArtifactSync < verifyIndex, `${relativePath} should verify after the re-sync (step 8)`);
  });
});

test("platform workflow docs delegate comment mechanics to internal intents", () => {
  const requiredIntentBySkill: Record<string, string> = {
    "analyze-task": "platform-comment sync {task-id}",
    "block-task": "platform-comment sync {task-id}",
    "cancel-task": "platform-comment sync {task-id}",
    "code-task": "platform-comment sync {task-id}",
    "complete-manual-validation": "platform-comment sync {task-id}",
    "run-manual-validation": "platform-comment sync {task-id}",
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

test("create-pr change reports keep one structured publication contract", () => {
  for (const relativePath of skillDocPaths("create-pr")) {
    assert.ok(read(relativePath).includes("reference/change-report.md"), `${relativePath} should reference the change-report contract`);
  }

  for (const relativePath of [
    ".agents/skills/create-pr/reference/change-report.md",
    "templates/.agents/skills/create-pr/reference/change-report.en.md",
    "templates/.agents/skills/create-pr/reference/change-report.zh-CN.md"
  ]) {
    const match = read(relativePath).match(/<!-- pr-change-report-contract\n([^\n]+)\n-->/);
    assert.ok(match, `${relativePath} should expose the structured change-report contract`);
    assert.deepEqual(JSON.parse(match[1]!), {
      source: "platform-pr-inspect",
      diff: "three-dot-find-renames",
      metrics: ["numstat-lines", "git-blob-bytes"],
      publish: ["pr-summary", "user-response"]
    });
  }
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
    assert.deepEqual(checks["required-pr-delivery"], {});
  });
});

test("complete-task docs keep remote preflight before host finalization", () => {
  skillDocPaths("complete-task").forEach((relativePath) => {
    const content = read(relativePath);
    const externalResolve = content.indexOf("platform-pr resolve-external {task-id}");
    const artifactSync = content.indexOf("platform-comment backfill {task-id}");
    const preflight = content.indexOf("task-verify {task-id} complete-task.preflight");
    const finalization = content.indexOf("task-finalization {task-id} complete");

    assert.ok(externalResolve >= 0 && externalResolve < artifactSync, `${relativePath} should resolve external delivery before platform backfill`);
    assert.ok(artifactSync >= 0 && artifactSync < preflight, `${relativePath} should backfill completion artifacts before preflight`);
    assert.ok(preflight >= 0 && preflight < finalization, `${relativePath} should run preflight before host finalization`);
    assert.ok(content.includes("finalization-retry"), `${relativePath} should define the retry branch identifier`);
  });
});

test("complete-task external delivery references are present in runtime and bilingual templates", () => {
  for (const relativePath of [
    ".agents/skills/complete-task/reference/external-delivery.md",
    "templates/.agents/skills/complete-task/reference/external-delivery.zh-CN.md",
    "templates/.agents/skills/complete-task/reference/external-delivery.en.md"
  ]) assert.ok(read(relativePath).length > 0, `${relativePath} should exist`);
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
  assert.equal(
    read(".agents/skills/run-manual-validation/SKILL.md"),
    read("templates/.agents/skills/run-manual-validation/SKILL.zh-CN.md"),
    "deployed run-manual-validation SKILL should stay byte-identical to its zh-CN template variant"
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

test("create-task context capture exposes a structured observable-acceptance contract", () => {
  const variants = [
    ".agents/skills/create-task/reference/context-capture.md",
    "templates/.agents/skills/create-task/reference/context-capture.zh-CN.md",
    "templates/.agents/skills/create-task/reference/context-capture.en.md"
  ];
  const expectedEntries: Record<string, string> = {
    sources: "current-request,necessary-prior-discussion",
    "scan-entire-visible-context": "true",
    "recognize-without-acceptance-label": "true",
    components: "observable-input,action,expected-result",
    "combine-distributed-evidence": "true",
    "preserve-source-state": "true",
    "missing-components": "preserve-as-gaps",
    "agent-inference-as-confirmed": "false",
    destination: "task-input.acceptance-criteria",
    "scenario-explicit": "capture-supported-components",
    "scenario-distributed": "combine-supported-components",
    "scenario-insufficient": "preserve-supported-components-and-gaps"
  };
  const contracts: string[] = [];

  variants.forEach((relativePath) => {
    const content = read(relativePath);
    const block = content.match(/```[a-z]*\n# observable-acceptance-contract\n([\s\S]*?)\n```/m)?.[1];
    assert.ok(block, `${relativePath} should declare a fenced observable-acceptance contract`);

    const entries: Record<string, string> = {};
    block!.split("\n").forEach((line) => {
      const match = line.match(/^([a-z][a-z-]*):[ \t]*(.*)$/);
      if (match?.[1] !== undefined) entries[match[1]] = match[2] ?? "";
    });

    Object.entries(expectedEntries).forEach(([key, value]) => {
      assert.equal(entries[key], value, `${relativePath} contract should declare ${key}: ${value}`);
    });
    contracts.push(block!.trim());
  });

  contracts.forEach((block) => {
    assert.equal(block, contracts[0], "observable-acceptance contract should be byte-identical across variants");
  });
  assert.equal(
    read(".agents/skills/create-task/reference/context-capture.md"),
    read("templates/.agents/skills/create-task/reference/context-capture.zh-CN.md"),
    "deployed context-capture reference should match its zh-CN template"
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

test("commit skill single-core steps stay consecutively numbered", () => {
  // commit SKILL uses level-2 (`## N.`) step headings, which the generic
  // consecutive-numbering test (level-3 `### N.`) does not cover.
  const commitVariants = [
    ".agents/skills/commit/SKILL.md",
    "templates/.agents/skills/commit/SKILL.zh-CN.md",
    "templates/.agents/skills/commit/SKILL.en.md"
  ];

  commitVariants.forEach((relativePath) => {
    const stepNumbers = [...read(relativePath).matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(
      stepNumbers,
      [1, 2, 3, 4, 5, 6],
      `${relativePath} should keep level-2 steps consecutively numbered`
    );
  });
});

test("commit skill variants preserve the single commit-core structure", () => {
  const variants = [
    [".agents/skills/commit/SKILL.md", ".agents/skills/commit/reference/commit-orchestration.md"],
    ["templates/.agents/skills/commit/SKILL.zh-CN.md", "templates/.agents/skills/commit/reference/commit-orchestration.zh-CN.md"],
    ["templates/.agents/skills/commit/SKILL.en.md", "templates/.agents/skills/commit/reference/commit-orchestration.en.md"]
  ];

  variants.forEach(([skillPath, referencePath]) => {
    const skill = read(skillPath!);
    const reference = read(referencePath!);
    const exampleMatch = skill.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(exampleMatch, `${skillPath} should include a commit input JSON example`);
    const example = JSON.parse(exampleMatch[1]!) as { push?: { remote?: unknown; refs?: unknown } };
    const navigation = skill.indexOf("reference/commit-orchestration.md");
    const commit = skill.indexOf("agent-infra-internal git-workflow commit");
    const gate = skill.indexOf("agent-infra-internal task-verify {task-id} commit.completed");
    assert.ok(navigation >= 0 && navigation < commit, `${skillPath} should load the protocol before commit`);
    assert.ok(gate > commit, `${skillPath} should verify after the core call`);
    assert.match(skill, /mode=orchestrated/);
    assert.match(skill, /commit-operation\.json/);
    assert.match(skill, /--task <ref>/);
    assert.match(skill, /-t <ref>/);
    assert.match(skill, /reference\/issue-metadata-sync\.md/);
    assert.match(skill, /reference\/pr-summary-sync\.md/);
    assert.equal(typeof example.push?.remote, "string", `${skillPath} should declare the push remote`);
    assert.ok(
      Array.isArray(example.push?.refs) && example.push.refs.length === 1 && /^refs\/heads\//.test(String(example.push.refs[0])),
      `${skillPath} should declare one full heads ref`
    );
    assert.match(reference, /commit-operation\.execute/);
    assert.match(reference, /COMMIT_AUTOPUSH_PROTECTED_BRANCH/);
    assert.match(reference, /COMMIT_PUSH_FAILED/);
    assert.match(reference, /TASK_CONTEXT_NOT_FOUND/);
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
