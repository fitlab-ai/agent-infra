import test from "node:test";
import assert from "node:assert/strict";

import { read } from "../../helpers.ts";

type PolicySection = {
  numbers: number[];
  todoCounts: number[];
  hasDeeperContent: boolean;
};

function parseLastPolicySection(file: string): PolicySection {
  const lines = read(file).split(/\r?\n/);
  let lastLevelTwo = -1;
  for (const [index, line] of lines.entries()) {
    if (/^## /.test(line)) lastLevelTwo = index;
  }

  assert.notEqual(lastLevelTwo, -1, `${file} must contain a level-two section`);

  const policyLines = lines.slice(lastLevelTwo + 1);
  const headings = policyLines
    .map((line, index) => {
      const match = /^### (\d+)\.\s+\S/.exec(line);
      return match ? { index, number: Number(match[1]) } : null;
    })
    .filter((heading): heading is { index: number; number: number } => heading !== null);

  return {
    numbers: headings.map(({ number }) => number),
    todoCounts: headings.map(({ index }, headingIndex) => {
      const nextIndex = headings[headingIndex + 1]?.index ?? policyLines.length;
      return policyLines.slice(index + 1, nextIndex).filter((line) => /^> TODO:/.test(line)).length;
    }),
    hasDeeperContent: policyLines.some((line) => /^### /.test(line))
      && policyLines.some((line) => /^#### /.test(line))
  };
}

test("testing discipline templates expose the same five project-policy TODO sections", () => {
  const english = parseLastPolicySection("templates/.agents/rules/testing-discipline.en.md");
  const chinese = parseLastPolicySection("templates/.agents/rules/testing-discipline.zh-CN.md");
  const expectedStructure = {
    numbers: [1, 2, 3, 4, 5],
    todoCounts: [1, 1, 1, 1, 1]
  };

  assert.deepEqual(
    { numbers: english.numbers, todoCounts: english.todoCounts },
    expectedStructure
  );
  assert.deepEqual(
    { numbers: chinese.numbers, todoCounts: chinese.todoCounts },
    expectedStructure
  );
});

test("runtime testing discipline keeps a filled project-policy hierarchy", () => {
  const runtime = parseLastPolicySection(".agents/rules/testing-discipline.md");

  assert.equal(runtime.hasDeeperContent, true);
});
