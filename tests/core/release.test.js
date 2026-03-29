import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { filePath, read } from "../helpers.js";

test("package metadata supports scoped npm publishing", () => {
  const pkg = JSON.parse(read("package.json"));

  assert.equal(pkg.name, "@fitlab-ai/agent-infra");
  assert.equal(pkg.author, "CodeCaster <codecaster365@outlook.com>");
  assert.equal(pkg.homepage, "https://github.com/fitlab-ai/agent-infra#readme");
  assert.deepEqual(pkg.bugs, {
    url: "https://github.com/fitlab-ai/agent-infra/issues"
  });
  assert.deepEqual(pkg.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/"
  });
  assert.equal(
    pkg.scripts.prepublishOnly,
    "node scripts/build-inline.js --check && node --test tests/cli/*.test.js tests/templates/*.test.js tests/core/*.test.js"
  );
});

test("release workflow publishes to npm on tag push", () => {
  const workflow = read(".github/workflows/release.yml");

  assert.match(workflow, /npm-publish:/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /package\.json version \$PACKAGE_VERSION does not match tag \$GITHUB_REF_NAME/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /npm publish --provenance/);
});

test("CLI help advertises scoped npm install commands", () => {
  const output = execFileSync(process.execPath, [filePath("bin/cli.js"), "help"], {
    encoding: "utf8"
  });

  assert.match(output, /npm install -g @fitlab-ai\/agent-infra/);
  assert.match(output, /npx @fitlab-ai\/agent-infra init/);
});

test("release documentation reflects CI-driven npm publishing", () => {
  const releasing = read("RELEASING.md");
  const releaseSkill = read(".agents/skills/release/SKILL.md");
  const releaseTemplate = read("templates/.agents/skills/release/SKILL.md");
  const releaseTemplateZh = read("templates/.agents/skills/release/SKILL.zh-CN.md");
  const releaseScript = read(".agents/skills/release/scripts/manage-milestones.sh");
  const releaseTemplateScript = read("templates/.agents/skills/release/scripts/manage-milestones.sh");

  assert.match(releasing, /NPM_TOKEN/);
  assert.match(releasing, /npm publish --provenance/);
  assert.match(releasing, /@fitlab-ai\/agent-infra/);
  assert.match(releasing, /推送标签后由 CI 自动执行/);
  assert.match(releaseSkill, /推送后将自动触发 GitHub Release 创建和 npm 发布/);
  assert.match(releaseSkill, /npm 自动发布/);
  assert.match(releaseSkill, /\.agents\/\.airc\.json.*templateVersion/);
  [releaseSkill, releaseTemplate, releaseTemplateZh].forEach((content) => {
    assert.match(content, /manage-milestones\.sh/);
    assert.match(content, /init-milestones/);
  });
  [releaseScript, releaseTemplateScript].forEach((content) => {
    assert.match(content, /milestones\?state=all/);
    assert.match(content, /Issues that we want to resolve in/);
    assert.match(content, /Issues that we want to release in v/);
  });
});
