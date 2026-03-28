import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  commandSpecs,
  escapeRegExp,
  exists,
  listFilesRecursive,
  listSkillNames,
  parseFrontmatter,
  read,
  skillDocPaths
} from "./helpers.js";

const skillDocFiles = [
  ...listFilesRecursive(".agents/skills"),
  ...listFilesRecursive("templates/.agents/skills")
]
  .filter((relativePath) => /\/SKILL(?:\.zh-CN)?\.md$/.test(relativePath))
  .sort();

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

test("skills with reference/ directory keep SKILL.md within size threshold", () => {
  listSkillNames().forEach((skill) => {
    const referenceDir = `.agents/skills/${skill}/reference`;
    if (!exists(referenceDir)) {
      return;
    }

    skillDocPaths(skill).forEach((relativePath) => {
      const lineCount = read(relativePath).split(/\r?\n/).length;
      assert.ok(lineCount <= 120, `${relativePath} should stay within 120 lines when using reference/`);
    });
  });
});

test("SKILL.md reference paths point to existing files", () => {
  skillDocFiles.forEach((relativePath) => {
    const content = read(relativePath);
    const references = [...content.matchAll(/reference\/[A-Za-z0-9./-]+\.md/g)]
      .map((match) => match[0]);

    [...new Set(references)].forEach((referencePath) => {
      const targetPath = path.join(path.dirname(relativePath), referencePath);
      assert.ok(exists(targetPath), `${relativePath} references missing file: ${targetPath}`);
    });
  });
});

test("template SKILL.md files provide zh-CN variants", () => {
  listFilesRecursive("templates/.agents/skills")
    .filter((relativePath) => /\/SKILL\.md$/.test(relativePath))
    .forEach((relativePath) => {
      const zhVariant = relativePath.replace(/SKILL\.md$/, "SKILL.zh-CN.md");
      assert.ok(exists(zhVariant), `Missing zh-CN skill variant: ${zhVariant}`);
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
