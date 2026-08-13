import test from "node:test";
import assert from "node:assert/strict";

import { listFilesRecursive, read } from "../../helpers.ts";

const platformTokenPattern = /GitHub|\.github\/|\bgh\b/;

function assertPlatformAgnostic(relativePath: string) {
  assert.doesNotMatch(read(relativePath), platformTokenPattern, `${relativePath} should stay platform-agnostic`);
}

function assertNoPlatformReferenceVariants(relativePath: string) {
  assert.doesNotMatch(relativePath, /\.github(?:\.(?:en|zh-CN))?\.md$/, `${relativePath} should not be a platform-specific skill reference`);
}

test("baseline skill docs and references stay platform-agnostic", () => {
  [
    ...listFilesRecursive("templates/.agents/skills")
      .filter((relativePath) => /\/SKILL\.(?:en|zh-CN)\.md$/.test(relativePath)),
    ...listFilesRecursive(".agents/skills")
      .filter((relativePath) => /\/SKILL\.md$/.test(relativePath)),
    ...listFilesRecursive("templates/.agents/skills")
      .filter((relativePath) => /\/reference\/.*\.(?:en|zh-CN)\.md$/.test(relativePath)),
    ...listFilesRecursive(".agents/skills")
      .filter((relativePath) => /\/reference\/.*\.md$/.test(relativePath))
  ].forEach(assertPlatformAgnostic);
});

test("skill references do not use platform-specific variants", () => {
  [
    ...listFilesRecursive("templates/.agents/skills")
      .filter((relativePath) => /\/reference\/.*\.md$/.test(relativePath)),
    ...listFilesRecursive(".agents/skills")
      .filter((relativePath) => /\/reference\/.*\.md$/.test(relativePath))
  ].forEach(assertNoPlatformReferenceVariants);
});

test("command descriptions stay platform-agnostic", () => {
  [
    ...listFilesRecursive("templates/.claude/commands"),
    ...listFilesRecursive("templates/.opencode/commands"),
  ]
    .filter((relativePath) => /\.(?:md|toml)$/.test(relativePath))
    .forEach((relativePath) => {
      const descriptionLine = read(relativePath)
        .split(/\r?\n/)
        .find((line) => /^description\s*[:=]/.test(line));

      assert.ok(descriptionLine, `${relativePath} should declare a description`);
      assert.doesNotMatch(descriptionLine, platformTokenPattern, `${relativePath} description should stay platform-agnostic`);
    });
});

test("agent quickstart and readme avoid hard-coded setup wording", () => {
  [
    "templates/.agents/QUICKSTART.en.md",
    "templates/.agents/QUICKSTART.zh-CN.md",
    "templates/.agents/README.en.md",
    "templates/.agents/README.zh-CN.md",
    ".agents/QUICKSTART.md",
    ".agents/README.md"
  ].forEach((relativePath) => {
    const content = read(relativePath);
    assert.doesNotMatch(content, platformTokenPattern, `${relativePath} should not contain platform tokens`);
    assert.doesNotMatch(content, /default GitHub setup|默认 GitHub 配置/, relativePath);
  });
});

test("Issue metadata workflow documents reference the internal Issue intent", () => {
  const runtime = [
    "import-issue", "analyze-task", "plan-task", "code-task",
    "review-code", "block-task", "cancel-task", "complete-task"
  ].map((skill) => `.agents/skills/${skill}/SKILL.md`);
  const templates = runtime.flatMap((relativePath) => {
    const base = relativePath.replace(/^\.agents\//, "templates/.agents/").replace(/SKILL\.md$/, "SKILL");
    return [`${base}.en.md`, `${base}.zh-CN.md`];
  });
  [
    ...runtime,
    ...templates,
    ".agents/skills/commit/reference/issue-metadata-sync.md",
    "templates/.agents/skills/commit/reference/issue-metadata-sync.en.md",
    "templates/.agents/skills/commit/reference/issue-metadata-sync.zh-CN.md"
  ].forEach((relativePath) => {
    assert.match(read(relativePath), /agent-infra-internal platform-issue (?:create|bind|sync)/, relativePath);
  });

  for (const relativePath of [
    ".agents/skills/create-task/SKILL.md",
    "templates/.agents/skills/create-task/SKILL.en.md",
    "templates/.agents/skills/create-task/SKILL.zh-CN.md"
  ]) {
    assert.match(read(relativePath), /agent-infra-internal task-create --input/, relativePath);
  }
});

test("PR workflow documents reference typed PR and required-check intents", () => {
  const prDocs = [
    ".agents/skills/create-pr/SKILL.md",
    ".agents/skills/create-pr/reference/comment-publish.md",
    ".agents/skills/commit/reference/pr-summary-sync.md",
    ".agents/skills/complete-manual-validation/reference/summary-update.md",
    "templates/.agents/skills/create-pr/SKILL.en.md",
    "templates/.agents/skills/create-pr/SKILL.zh-CN.md",
    "templates/.agents/skills/create-pr/reference/comment-publish.en.md",
    "templates/.agents/skills/create-pr/reference/comment-publish.zh-CN.md",
    "templates/.agents/skills/commit/reference/pr-summary-sync.en.md",
    "templates/.agents/skills/commit/reference/pr-summary-sync.zh-CN.md",
    "templates/.agents/skills/complete-manual-validation/reference/summary-update.en.md",
    "templates/.agents/skills/complete-manual-validation/reference/summary-update.zh-CN.md"
  ];
  prDocs.forEach((relativePath) => {
    assert.match(read(relativePath), /agent-infra-internal platform-pr (?:create|sync|summary-context|summary-sync)/, relativePath);
  });

  [
    ".agents/skills/watch-pr/SKILL.md",
    "templates/.agents/skills/watch-pr/SKILL.en.md",
    "templates/.agents/skills/watch-pr/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assert.match(read(relativePath), /agent-infra-internal platform-checks watch/, relativePath);
  });
});

test("release-note workflow documents reference the typed release-note intent", () => {
  [
    ".agents/skills/create-release-note/SKILL.md",
    "templates/.agents/skills/create-release-note/SKILL.en.md",
    "templates/.agents/skills/create-release-note/SKILL.zh-CN.md",
    ".agents/rules/release-commands.md",
    "templates/.agents/rules/release-commands.github.en.md",
    "templates/.agents/rules/release-commands.github.zh-CN.md"
  ].forEach((relativePath) => {
    assert.match(read(relativePath), /agent-infra-internal platform-release-notes context/, relativePath);
    assert.match(read(relativePath), /agent-infra-internal platform-release-notes publish/, relativePath);
  });
});
