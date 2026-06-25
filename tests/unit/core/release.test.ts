import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { CLI_PATH, cliArgs, filePath, read } from "../../helpers.ts";

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
  assert.deepEqual(pkg.files, [
    "dist/",
    "!dist/**/*.map",
    "bin/cli.ts",
    "lib/",
    "templates/"
  ]);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "@clack/prompts",
    "cross-spawn",
    "picocolors",
    "semver",
    "smol-toml",
    "yaml"
  ]);
  assert.match(pkg.scripts.prepublishOnly, /npm run build/);
  assert.match(pkg.scripts.prepublishOnly, /--test/);
  assert.match(pkg.scripts.prepublishOnly, /tests\/\*\*\/\*\.test\.ts/);
});

test("CLI help advertises scoped npm install commands and Homebrew", () => {
  const output = execFileSync(process.execPath, cliArgs("help"), {
    encoding: "utf8"
  });

  assert.match(output, /npm install -g @fitlab-ai\/agent-infra/);
  assert.match(output, /npx @fitlab-ai\/agent-infra init/);
  assert.match(output, /brew install fitlab-ai\/tap\/agent-infra/);
});

test("release documentation reflects CI-driven npm publishing", () => {
  const releasing = read("RELEASING.md");
  const releaseSkill = read(".agents/skills/release/SKILL.md");
  const releaseTemplate = read("templates/.agents/skills/release/SKILL.en.md");
  const releaseTemplateZh = read("templates/.agents/skills/release/SKILL.zh-CN.md");
  const releaseScript = read(".agents/skills/release/scripts/manage-milestones.sh");
  const releaseTemplateScript = read("templates/.agents/skills/release/scripts/manage-milestones.github.sh");

  assert.match(releasing, /Trusted Publisher/);
  assert.match(releasing, /GitHub Actions OIDC/);
  assert.match(releasing, /npm publish --provenance/);
  assert.match(releasing, /@fitlab-ai\/agent-infra/);
  assert.match(releasing, /推送标签后由 CI 自动执行/);
  assert.match(releaseSkill, /推送后将自动触发 release 创建和 npm 发布/);
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

test("post-release-smoke workflow verifies npm and brew install channels", () => {
  const workflow = read(".github/workflows/post-release-smoke.yml");

  assert.match(workflow, /name: Post-Release Smoke/);
  assert.match(workflow, /workflow_run:[\s\S]*workflows: \["Update Homebrew Formula"\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /inputs:[\s\S]*version:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /post-release-smoke-\$\{\{ github\.event\.workflow_run\.id \|\| inputs\.version \}\}/);

  assert.match(workflow, /resolve-version:/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /name: release-version/);
  assert.match(workflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /DISPATCH_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /VERSION=\$\(cat release-version\.txt\)/);
  assert.match(workflow, /outputs:[\s\S]*version:/);

  assert.match(workflow, /npm-smoke:/);
  assert.match(workflow, /needs: resolve-version/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /matrix:[\s\S]*os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /npm view "@fitlab-ai\/agent-infra@\$\{VERSION\}" version/);
  assert.match(workflow, /npx -y "@fitlab-ai\/agent-infra@\$\{VERSION\}" version/);
  assert.match(workflow, /npx -y "@fitlab-ai\/agent-infra@\$\{VERSION\}" sandbox --help/);

  assert.match(workflow, /brew-smoke:/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /raw\.githubusercontent\.com\/fitlab-ai\/homebrew-tap\/main\/Formula\/agent-infra\.rb/);
  assert.match(workflow, /grep -q "bottle do"/);
  assert.match(workflow, /name: brew install \(must pour from bottle\)/);
  assert.match(workflow, /brew install --verbose fitlab-ai\/tap\/agent-infra/);
  assert.match(workflow, /grep -q "Pouring agent-infra-"/);
  assert.match(workflow, /agent-infra version/);
});
