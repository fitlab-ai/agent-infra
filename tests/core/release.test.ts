import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { CLI_PATH, cliArgs, filePath, read } from "../helpers.ts";

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
    "smol-toml"
  ]);
  assert.equal(
    pkg.scripts.prepublishOnly,
    "npm run build && node --experimental-strip-types --no-warnings --test tests/cli/*.test.ts tests/templates/*.test.ts tests/core/*.test.ts tests/scripts/*.test.ts"
  );
});

test("release workflow publishes to npm on tag push", () => {
  const workflow = read(".github/workflows/release.yml");

  assert.match(workflow, /npm-publish:/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /package\.json version \$PACKAGE_VERSION does not match tag \$GITHUB_REF_NAME/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /npm publish --provenance/);
});

test("update-homebrew workflow syncs the tap after a successful release run", () => {
  const workflow = read(".github/workflows/update-homebrew.yml");

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["Release"\]/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /name: Checkout repository at released commit/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /name: Setup Node\.js/);
  assert.match(workflow, /name: Read package version from released commit/);
  assert.match(workflow, /Detected version: \$VERSION/);
  assert.match(workflow, /name: Wait for npm registry propagation/);
  assert.match(workflow, /npm view "@fitlab-ai\/agent-infra@\${VERSION}" version/);
  assert.match(workflow, /name: Get tarball URL and SHA256/);
  assert.match(workflow, /sha256sum package\.tgz/);
  assert.match(workflow, /name: Checkout homebrew-tap/);
  assert.match(workflow, /repository: fitlab-ai\/homebrew-tap/);
  assert.match(workflow, /path: homebrew-tap/);
  assert.match(workflow, /HOMEBREW_TAP_TOKEN/);
  assert.match(workflow, /name: Update Formula/);
  assert.match(workflow, /class AgentInfra < Formula/);
  assert.match(workflow, /name: Commit and push/);
  assert.match(workflow, /git commit -m "agent-infra \$\{VERSION\}"/);
  assert.match(workflow, /workflow_dispatch:[\s\S]*inputs:[\s\S]*version:/);
  assert.match(workflow, /prepare-formula:/);
  assert.match(workflow, /bake-bottle:/);
  assert.match(workflow, /publish-bottle:/);
  assert.match(workflow, /outputs:[\s\S]*version: \$\{\{ steps\.version\.outputs\.version \}\}/);
  assert.equal(workflow.match(/license "MIT"\n[ ]*# __BOTTLE_BLOCK__/g)?.length, 1);
  assert.match(workflow, /os: macos-26[\s\S]*platform: arm64_tahoe/);
  assert.match(workflow, /os: macos-15[\s\S]*platform: arm64_sequoia/);
  assert.match(workflow, /os: macos-14[\s\S]*platform: arm64_sonoma/);
  assert.match(workflow, /os: macos-14-large[\s\S]*platform: sonoma/);
  assert.match(workflow, /brew install --build-bottle --formula --verbose agent-infra/);
  assert.match(workflow, /brew bottle --json --no-rebuild --root-url="\$ROOT_URL" agent-infra/);
  assert.match(workflow, /https:\/\/github\.com\/fitlab-ai\/agent-infra\/releases\/download\/v\$\{VERSION\}/);
  assert.match(workflow, /gh release upload "v\$\{VERSION\}"/);
  assert.match(workflow, /bake-bottle:[\s\S]*continue-on-error: true/);
  assert.match(workflow, /publish-bottle:[\s\S]*if: \$\{\{ always\(\)/);
  assert.match(workflow, /brew bottle --merge --write --no-commit "\$json"/);
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
  assert.match(workflow, /release:[\s\S]*types: \[published\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /inputs:[\s\S]*version:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress: true/);

  assert.match(workflow, /resolve-version:/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /DISPATCH_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
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
  assert.match(workflow, /name: brew install\s*\n\s*shell: bash/);
  assert.match(workflow, /brew install fitlab-ai\/tap\/agent-infra/);
  assert.match(workflow, /agent-infra version/);
});
