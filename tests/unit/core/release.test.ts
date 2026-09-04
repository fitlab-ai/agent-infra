import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as semver from "semver";
import { parse } from "yaml";

import { CLI_PATH, cliArgs, filePath, listFilesRecursive, read } from "../../helpers.ts";

type WorkflowStep = {
  uses?: string;
  with?: Record<string, unknown>;
};

type ReleaseWorkflow = {
  "run-name"?: string;
  on?: Record<string, unknown>;
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

function requireActionStep(steps: WorkflowStep[], action: string, label: string) {
  const prefix = `${action}@`;
  const step = steps.find((candidate) => candidate.uses?.startsWith(prefix));
  assert.ok(step, `${label} must use ${action}`);
  return step;
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
  assert.deepEqual(pkg.bin, {
    "agent-infra": "./dist/bin/cli.js",
    "ai": "./dist/bin/cli.js",
    "agent-infra-internal": "./dist/bin/internal-cli.js"
  });
  assert.deepEqual(pkg.files, [
    "dist/",
    "!dist/**/*.map",
    "bin/cli.ts",
    "lib/",
    "runtime/",
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
  assert.match(pkg.scripts.prepublishOnly, /^node scripts\/run-tests\.js/);
  assert.match(pkg.scripts.prepublishOnly, /tests\/\*\*\/\*\.test\.ts/);
  assert.match(read("lib/platform/verification-sync.ts"), /resolvePlatformProviderContext/);
});

test("Node runtime baseline stays aligned across metadata and automation", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json")) as PackageLock;

  const engineRange = pkg.engines.node;
  const engineMinimum = requireMinVersion(engineRange, "package engines.node");
  assert.equal(lock.packages[""]?.engines?.node, engineRange);

  const typesNodeRange = pkg.devDependencies["@types/node"];
  assert.equal(requireMinVersion(typesNodeRange, "package @types/node range").major, engineMinimum.major);
  assert.equal(semver.intersects(typesNodeRange, `>=${engineMinimum.major + 1}.0.0`), false);

  const rootTypesNodeRange = lock.packages[""]?.devDependencies?.["@types/node"];
  assert.equal(rootTypesNodeRange, typesNodeRange);

  const lockedTypesNodeVersion = lock.packages["node_modules/@types/node"]?.version;
  assert.equal(
    semver.satisfies(requireVersion(lockedTypesNodeVersion ?? "", "lockfile @types/node version"), typesNodeRange),
    true
  );

  const releaseWorkflow = parse(read(".github/workflows/release.yml")) as ReleaseWorkflow;
  const releaseSteps = releaseWorkflow.jobs?.["npm-publish"]?.steps ?? [];
  const setupNodeStep = requireActionStep(releaseSteps, "actions/setup-node", "release workflow");
  const releaseNodeVersion = requireMinVersion(
    String(setupNodeStep.with?.["node-version"] ?? ""),
    "release workflow node-version"
  );
  assert.equal(semver.satisfies(releaseNodeVersion, engineRange), true);

  const unitTestsWorkflow = parse(read(".github/workflows/unit-tests.yml")) as ReleaseWorkflow;
  const minimumBaselineSteps = unitTestsWorkflow.jobs?.["minimum-node-baseline"]?.steps ?? [];
  const minimumSetupNodeStep = requireActionStep(
    minimumBaselineSteps,
    "actions/setup-node",
    "minimum Node baseline job"
  );
  assert.equal(String(minimumSetupNodeStep.with?.["node-version"]), engineMinimum.version);

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
    .filter(
      ([, meta]) =>
        !semver.intersects(
          meta.engines?.node ?? "",
          `>=${engineMinimum.version} <${engineMinimum.major + 1}.0.0`
        )
    )
    .map(([packagePath, meta]) => [packagePath, meta.engines?.node]);
  assert.deepEqual(runtimeEngineConflicts, []);
});

test("reused GitHub Actions keep consistent refs across workflows", () => {
  const refsByAction = new Map<string, Map<string, string[]>>();

  listFilesRecursive(".github/workflows")
    .filter((relativePath) => /\.ya?ml$/.test(relativePath))
    .forEach((relativePath) => {
      const workflow = parse(read(relativePath)) as ReleaseWorkflow;

      Object.values(workflow.jobs ?? {}).forEach((job) => {
        (job.steps ?? []).forEach((step) => {
          const uses = step.uses;
          const separator = uses?.lastIndexOf("@") ?? -1;
          if (!uses || uses.startsWith("./") || separator < 1 || separator === uses.length - 1) {
            return;
          }

          const action = uses.slice(0, separator);
          const ref = uses.slice(separator + 1);
          const refs = refsByAction.get(action) ?? new Map<string, string[]>();
          refs.set(ref, [...(refs.get(ref) ?? []), relativePath]);
          refsByAction.set(action, refs);
        });
      });
    });

  refsByAction.forEach((refs, action) => {
    assert.equal(
      refs.size,
      1,
      `${action} must use one ref across workflows: ${[...refs.entries()]
        .map(([ref, paths]) => `${ref} in ${paths.join(", ")}`)
        .join("; ")}`
    );
  });
});

test("test sources do not pin GitHub Action refs", () => {
  const pinnedRefs = listFilesRecursive("tests")
    .filter((relativePath) => relativePath.endsWith(".ts"))
    .flatMap((relativePath) =>
      [...read(relativePath).matchAll(/["'`]([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[A-Za-z0-9_.-]+)/g)]
        .map((match) => `${relativePath}: ${match[1]}`)
    );

  assert.deepEqual(pinnedRefs, []);
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

  assert.match(releasing, /Trusted Publisher/);
  assert.match(releasing, /GitHub Actions OIDC/);
  assert.match(releasing, /npm publish --provenance/);
  assert.match(releasing, /@fitlab-ai\/agent-infra/);
  assert.match(releasing, /推送标签后由 CI 自动执行/);
  [releaseSkill, releaseTemplate, releaseTemplateZh].forEach((content) => {
    assert.match(content, /release-workflow/);
  });
});

test("project release skill runs local entropy-check without distributing it", () => {
  const releaseSkill = read(".agents/skills/release/SKILL.md");

  assert.match(releaseSkill, /entropy/);
  [
    "templates/.agents/skills/release/SKILL.en.md",
    "templates/.agents/skills/release/SKILL.zh-CN.md"
  ].forEach((relativePath) => {
    assert.doesNotMatch(
      read(relativePath),
      /entropy-check/,
      `${relativePath} should not require the project-local entropy-check skill`
    );
  });
});

test("post-release-smoke workflow verifies npm and brew install channels", () => {
  const workflow = parse(read(".github/workflows/post-release-smoke.yml")) as ReleaseWorkflow & {
    name?: string;
    permissions?: Record<string, unknown>;
    concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  };

  assert.equal(workflow.name, "Post-Release Smoke");
  assert.equal(
    workflow["run-name"],
    "${{ github.event_name == 'workflow_dispatch' && format('Post-Release Smoke v{0}', inputs.version) || 'Post-Release Smoke (automatic)' }}"
  );
  assert.deepEqual(workflow.on?.workflow_run, {
    workflows: ["Update Homebrew Formula"],
    types: ["completed"]
  });
  assert.deepEqual(workflow.on?.workflow_dispatch, {
    inputs: {
      version: {
        description: "Version to smoke-test (without leading v), e.g. 0.5.10",
        required: true,
        type: "string"
      }
    }
  });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: "post-release-smoke-${{ github.event.workflow_run.id || inputs.version }}",
    "cancel-in-progress": true
  });

  const workflowText = read(".github/workflows/post-release-smoke.yml");

  assert.match(workflowText, /resolve-version:/);
  assert.match(workflowText, /timeout-minutes: 5/);
  assert.match(workflowText, /actions: read/);
  assert.match(workflowText, /name: release-version/);
  assert.match(workflowText, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(workflowText, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflowText, /DISPATCH_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(workflowText, /VERSION=\$\(cat release-version\.txt\)/);
  assert.match(workflowText, /outputs:[\s\S]*version:/);

  assert.match(workflowText, /npm-smoke:/);
  assert.match(workflowText, /needs: resolve-version/);
  assert.match(workflowText, /timeout-minutes: 15/);
  assert.match(workflowText, /matrix:[\s\S]*os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflowText, /fail-fast: false/);
  assert.match(workflowText, /npm view "@fitlab-ai\/agent-infra@\$\{VERSION\}" version/);
  assert.match(workflowText, /npx -y "@fitlab-ai\/agent-infra@\$\{VERSION\}" version/);
  assert.match(workflowText, /npx -y "@fitlab-ai\/agent-infra@\$\{VERSION\}" sandbox --help/);

  assert.match(workflowText, /brew-smoke:/);
  assert.match(workflowText, /runs-on: macos-latest/);
  assert.match(workflowText, /timeout-minutes: 20/);
  assert.match(workflowText, /raw\.githubusercontent\.com\/fitlab-ai\/homebrew-tap\/main\/Formula\/agent-infra\.rb/);
  assert.match(workflowText, /grep -q "bottle do"/);
  assert.match(workflowText, /name: brew install \(must pour from bottle\)/);
  assert.match(workflowText, /brew install --verbose fitlab-ai\/tap\/agent-infra/);
  assert.match(workflowText, /grep -q "Pouring agent-infra-"/);
  assert.match(workflowText, /agent-infra version/);
});
