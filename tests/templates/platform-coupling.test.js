import test from "node:test";
import assert from "node:assert/strict";

import { listFilesRecursive, read } from "../helpers.js";

const platformTokenPattern = /GitHub|\.github\/|\bgh\b/;

function assertPlatformAgnostic(relativePath) {
  assert.doesNotMatch(read(relativePath), platformTokenPattern, `${relativePath} should stay platform-agnostic`);
}

function assertNoPlatformReferenceVariants(relativePath) {
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
    ...listFilesRecursive("templates/.gemini/commands/_project_")
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
    const content = read(relativePath).replaceAll(".github/hooks", "");
    assert.doesNotMatch(content, platformTokenPattern, `${relativePath} should not contain platform tokens outside the hook path`);
    assert.doesNotMatch(content, /default GitHub setup|默认 GitHub 配置/, relativePath);
  });
});
