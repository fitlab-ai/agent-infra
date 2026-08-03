import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  escapeRegExp,
  gitSafeEnv,
  initIsolatedGitRepo,
  listFilesRecursive,
  onPlatforms,
  read
} from "../../helpers.ts";
import { getAgentClientAdapter } from "../../../lib/agent-clients/registry.ts";

const milestoneScript = path.resolve(
  "templates/.agents/skills/init-milestones/scripts/init-milestones.github.sh"
);

function bashBlocks(content: string): string[] {
  return [...content.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1] ?? "");
}

function contractEntries(content: string, name: string): Record<string, string> {
  const normalized = content.replaceAll("\r\n", "\n");
  const prefix = `\`\`\`text\n# ${name}\n`;
  const start = normalized.indexOf(prefix);
  const end = start < 0 ? -1 : normalized.indexOf("\n```", start + prefix.length);
  assert.ok(start >= 0 && end >= 0, `expected ${name} contract`);
  const block = normalized.slice(start + prefix.length, end);

  return Object.fromEntries(
    block.split(/\r?\n/).map((line) => {
      const separator = line.indexOf(":");
      assert.ok(separator > 0, `invalid ${name} entry: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    })
  );
}

function writeFakeGh(binDir: string): void {
  const fakeGh = path.join(binDir, "gh");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(fakeGh, `#!/bin/sh
case "$1:$2" in
  auth:token) exit 0 ;;
  repo:view)
    case " $* " in
      *" --jq "*) printf '%s\\n' 'example/project' ;;
      *) printf '%s\\n' '{"nameWithOwner":"example/project"}' ;;
    esac
    exit 0
    ;;
  api:*)
    case "$2" in
      *"milestones?state=all"*) printf '%s' "\${MILESTONE_EXISTING_TSV:-}" ;;
    esac
    exit 0
    ;;
esac
exit 1
`, "utf8");
  fs.chmodSync(fakeGh, 0o755);
}

function runMilestoneScript(
  tags: string[],
  options: {
    arguments?: string[];
    existingMilestones?: { state?: "open" | "closed"; title: string }[];
    manifestVersion?: string;
  } = {}
) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-milestones-"));
  const binDir = path.join(repoDir, "bin");
  const env = gitSafeEnv({
    MILESTONE_EXISTING_TSV: (options.existingMilestones ?? [])
      .map(({ state = "open", title }) => `${title}\t${state}\n`)
      .join(""),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
  });

  try {
    initIsolatedGitRepo(repoDir);
    writeFakeGh(binDir);

    const ghProbe = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner"], {
      cwd: repoDir,
      encoding: "utf8",
      env
    });
    assert.equal(ghProbe.status, 0, ghProbe.stderr);

    for (const [key, value] of [
      ["user.email", "test@example.com"],
      ["user.name", "Template Test"],
      ["commit.gpgSign", "false"],
      ["tag.gpgSign", "false"]
    ] as const) {
      const config = spawnSync("git", ["config", key, value], { cwd: repoDir, encoding: "utf8", env });
      assert.equal(config.status, 0, config.stderr);
    }

    const commit = spawnSync("git", ["commit", "--allow-empty", "-qm", "fixture"], {
      cwd: repoDir,
      encoding: "utf8",
      env
    });
    assert.equal(commit.status, 0, commit.stderr);

    if (options.manifestVersion) {
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        `${JSON.stringify({ version: options.manifestVersion }, null, 2)}\n`,
        "utf8"
      );
    }

    for (const tag of tags) {
      const result = spawnSync("git", ["tag", tag], { cwd: repoDir, encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
    }

    return spawnSync("sh", [milestoneScript, ...(options.arguments ?? [])], {
      cwd: repoDir,
      encoding: "utf8",
      env
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

function milestoneActions(stdout: string): { created: string[]; skipped: string[] } {
  return {
    created: [...stdout.matchAll(/^Created milestone: (.+) \((?:open|closed)\)$/gm)]
      .map((match) => match[1] ?? ""),
    skipped: [...stdout.matchAll(/^Skip existing milestone: (.+)$/gm)]
      .map((match) => match[1] ?? "")
  };
}

test("Antigravity invocation uses its native workspace skill command", () => {
  assert.equal(
    getAgentClientAdapter("antigravity-cli").invocation,
    "/${skillName}"
  );
});

test("branch-management templates derive the branch prefix from the project placeholder", () => {
  for (const language of ["en", "zh-CN"]) {
    const content = read(`templates/.agents/skills/code-task/reference/branch-management.${language}.md`);
    const branchFormats = [...content.matchAll(/`([^`\n]+-\{type\}-\{slug\})`/g)].map((match) => match[1]);

    assert.ok(branchFormats.length > 0, `${language} branch management should declare branch formats`);
    assert.deepEqual([...new Set(branchFormats)], ["{{project}}-{type}-{slug}"]);
  }
});

test("generic test skill command examples remain configurable", () => {
  for (const language of ["en", "zh-CN"]) {
    const blocks = bashBlocks(read(`templates/.agents/skills/test/SKILL.${language}.md`));

    assert.ok(blocks.length > 0, `${language} test skill should contain shell examples`);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).filter((line) => line.trim().length > 0);
      assert.ok(lines.length > 0, `${language} shell example should not be empty`);
      assert.ok(lines.every((line) => line.trimStart().startsWith("#")), `${language} commands must be opt-in examples`);
    }
  }
});

test("watch-pr templates declare a language-neutral self-heal test command contract", () => {
  const contracts = ["en", "zh-CN"].map((language) => contractEntries(
    read(`templates/.agents/skills/watch-pr/reference/monitor-and-heal.${language}.md`),
    "self-heal-test-command-contract"
  ));

  const expected = {
    primary: "failing-job-command",
    "fallback-source": "project-test-skill",
    unknown: "help"
  };
  assert.deepEqual(contracts, [expected, expected]);
});

test("milestone initialization follows SemVer precedence and preserves wide numeric fields", onPlatforms("linux", "darwin"), () => {
  const cases = [
    {
      tags: ["v1.2.3", "v1.2.3-alpha.1"],
      baseline: "1.2.3",
      source: "git tag v1.2.3",
      line: "1.2.x",
      next: "1.2.4"
    },
    {
      tags: ["v1.3.0-rc.1", "v1.2.9"],
      baseline: "1.3.0",
      source: "git tag v1.3.0-rc.1",
      line: "1.3.x",
      next: "1.3.1"
    },
    {
      tags: ["v1.2.3-alpha.2", "v1.2.3-alpha.10"],
      baseline: "1.2.3",
      source: "git tag v1.2.3-alpha.10",
      line: "1.2.x",
      next: "1.2.4"
    },
    {
      tags: ["v1.2.3-1", "v1.2.3-alpha"],
      baseline: "1.2.3",
      source: "git tag v1.2.3-alpha",
      line: "1.2.x",
      next: "1.2.4"
    },
    {
      tags: ["v1.2.3+build.10", "v1.2.3+build.2"],
      baseline: "1.2.3",
      source: "git tag v1.2.3+build.2",
      line: "1.2.x",
      next: "1.2.4"
    },
    {
      tags: ["v1.2.3", "v999.0.0-01"],
      baseline: "1.2.3",
      source: "git tag v1.2.3",
      line: "1.2.x",
      next: "1.2.4"
    },
    {
      tags: ["v1.0.0-01"],
      baseline: "0.1.0",
      source: "compatibility default",
      line: "0.1.x",
      next: "0.1.0",
      created: ["General Backlog", "0.1.x", "0.1.0"],
      manifestVersion: "9.8.7"
    },
    {
      tags: ["v1.2.999999999999999999999999999999"],
      baseline: "1.2.999999999999999999999999999999",
      source: "git tag v1.2.999999999999999999999999999999",
      line: "1.2.x",
      next: "1.2.1000000000000000000000000000000"
    }
  ];

  for (const fixture of cases) {
    const result = runMilestoneScript(fixture.tags, { manifestVersion: fixture.manifestVersion });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`^Detected version baseline: ${escapeRegExp(fixture.baseline)}$`, "m"));
    assert.match(result.stdout, new RegExp(`^Version baseline source: ${escapeRegExp(fixture.source)}$`, "m"));
    assert.match(result.stdout, new RegExp(`^Line milestone: ${escapeRegExp(fixture.line)}$`, "m"));
    assert.match(result.stdout, new RegExp(`^Next version milestone: ${escapeRegExp(fixture.next)}$`, "m"));
    if (fixture.created) {
      assert.deepEqual(milestoneActions(result.stdout).created, fixture.created);
    }
  }
});

test("milestone initialization skips an existing compatibility baseline by title", onPlatforms("linux", "darwin"), () => {
  const result = runMilestoneScript(["v1.0.0-01"], {
    existingMilestones: [{ title: "0.1.0" }]
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(milestoneActions(result.stdout), {
    created: ["General Backlog", "0.1.x"],
    skipped: ["0.1.0"]
  });
});

test("milestone history mode derives milestones only from valid SemVer tags", onPlatforms("linux", "darwin"), () => {
  const result = runMilestoneScript(["v1.2.3", "v9.0.0-01"], { arguments: ["--history"] });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^Created milestone: 1\.2\.3 \(closed\)$/m);
  assert.match(result.stdout, /^Skip existing milestone: 1\.2\.x$/m);
});
