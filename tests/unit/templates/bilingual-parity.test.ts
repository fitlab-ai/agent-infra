import test from "node:test";
import assert from "node:assert/strict";

import { exists, listTrackedFiles } from "../../helpers.ts";

// Repo-wide bilingual documentation parity guard.
//
// Two baseline conventions coexist:
//   1. Co-located `X.en.md` <-> `X.zh-CN.md` (used under .agents/ and templates/).
//   2. Top-level repo docs use `X.md` as the English baseline paired with
//      `X.zh-CN.md` (there is no `X.en.md` for these).
//
// The top-level baselines are an explicit allowlist rather than a heuristic, so
// the guard never demands a translation for the many `.md` files (source
// SKILL.md, rules, task fixtures, ...) that legitimately have no zh-CN variant.
const TOP_LEVEL_BASELINES = ["README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md"];

const tracked = new Set(
  listTrackedFiles("*.en.md", "*.zh-CN.md", ":!:node_modules/**", ":!:dist/**")
);

test("every .en.md has a sibling .zh-CN.md", () => {
  [...tracked]
    .filter((file) => file.endsWith(".en.md"))
    .forEach((file) => {
      const zh = file.replace(/\.en\.md$/, ".zh-CN.md");
      assert.ok(tracked.has(zh), `${file} is missing its translation ${zh}`);
    });
});

test("every .zh-CN.md has an English baseline", () => {
  [...tracked]
    .filter((file) => file.endsWith(".zh-CN.md"))
    .forEach((file) => {
      const enSibling = file.replace(/\.zh-CN\.md$/, ".en.md");
      const baseline = file.replace(/\.zh-CN\.md$/, ".md");
      const isTopLevelBaseline = !file.includes("/") && TOP_LEVEL_BASELINES.includes(baseline);
      assert.ok(
        tracked.has(enSibling) || (isTopLevelBaseline && exists(baseline)),
        `${file} has no English baseline (${enSibling} or top-level ${baseline})`
      );
    });
});

test("top-level baseline docs provide zh-CN translations", () => {
  TOP_LEVEL_BASELINES.filter((baseline) => exists(baseline)).forEach((baseline) => {
    const zh = baseline.replace(/\.md$/, ".zh-CN.md");
    assert.ok(exists(zh), `${baseline} is missing its translation ${zh}`);
  });
});
