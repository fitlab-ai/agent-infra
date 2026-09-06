import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";
import { getAgentClientAdapter } from "../../../lib/agent-clients/registry.ts";

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

test("watch-pr templates declare a language-neutral conflict-heal contract", () => {
  const contracts = ["en", "zh-CN"].map((language) => contractEntries(
    read(`templates/.agents/skills/watch-pr/reference/monitor-and-heal.${language}.md`),
    "conflict-heal-contract"
  ));

  const expected = {
    strategy: "rebase",
    "remote-update": "exact-lease",
    unsafe: "help"
  };
  assert.deepEqual(contracts, [expected, expected]);
});
