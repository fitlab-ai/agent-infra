import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as semver from "semver";
import { parse } from "yaml";

import { CLI_PATH, cliArgs, filePath, read } from "../../helpers.ts";

type WorkflowStep = {
  uses?: string;
  with?: Record<string, unknown>;
};

type ReleaseWorkflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

type DependabotUpdate = {
  "package-ecosystem"?: string;
  directory?: string;
  ignore?: Array<{
    "dependency-name"?: string;
    "update-types"?: string[];
  }>;
};

type DependabotConfig = {
  updates?: DependabotUpdate[];
};

type LockPackage = {
  dev?: boolean;
  engines?: {
    node?: string;
  };
  version?: string;
};

type PackageLock = {
  packages: Record<string, LockPackage & {
    devDependencies?: Record<string, string>;
  }>;
};

function requireMinVersion(range: string, label: string) {
  const version = semver.minVersion(range);
  assert.ok(version, `${label} must be a valid semver range`);
  return version;
}

function requireVersion(versionText: string, label: string) {
  const version = semver.parse(versionText);
  assert.ok(version, `${label} must be a valid semver version`);
  return version;
}

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
    "@larksuiteoapi/node-sdk",
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

test("Node baseline stays aligned across metadata and automation", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json")) as PackageLock;

  const engineRange = pkg.engines.node;
  assert.equal(requireMinVersion(engineRange, "package engines.node").major, 22);
  assert.equal(semver.satisfies("21.999.0", engineRange), false);

  const typesNodeRange = pkg.devDependencies["@types/node"];
  assert.equal(requireMinVersion(typesNodeRange, "package @types/node range").major, 22);
  assert.equal(semver.intersects(typesNodeRange, ">=23.0.0"), false);

  const rootTypesNodeRange = lock.packages[""]?.devDependencies?.["@types/node"];
  assert.equal(requireMinVersion(rootTypesNodeRange ?? "", "lockfile root @types/node range").major, 22);

  const lockedTypesNodeVersion = lock.packages["node_modules/@types/node"]?.version;
  assert.equal(requireVersion(lockedTypesNodeVersion ?? "", "lockfile @types/node version").major, 22);

  const releaseWorkflow = parse(read(".github/workflows/release.yml")) as ReleaseWorkflow;
  const releaseSteps = releaseWorkflow.jobs?.["npm-publish"]?.steps ?? [];
  const setupNodeStep = releaseSteps.find((step) => step.uses === "actions/setup-node@v6");
  assert.ok(setupNodeStep, "actions/setup-node@v6 step not found in release workflow");
  assert.equal(String(setupNodeStep?.with?.["node-version"]), "22");

  const dependabot = parse(read(".github/dependabot.yml")) as DependabotConfig;
  const npmUpdates = dependabot.updates?.find(
    (update) => update["package-ecosystem"] === "npm" && update.directory === "/"
  );
  assert.ok(
    npmUpdates?.ignore?.some(
      (entry) =>
        entry["dependency-name"] === "@types/node" &&
        entry["update-types"]?.includes("version-update:semver-major")
    )
  );

  const runtimeEngineConflicts = Object.entries(lock.packages)
    .filter(([packagePath, meta]) => packagePath !== "" && !meta.dev && meta.engines?.node)
    .filter(([, meta]) => !semver.intersects(meta.engines?.node ?? "", ">=22 <23"))
    .map(([packagePath, meta]) => [packagePath, meta.engines?.node]);
  assert.deepEqual(runtimeEngineConflicts, []);
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
