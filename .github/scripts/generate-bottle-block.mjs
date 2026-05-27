import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_TAGS = ["arm64_tahoe", "arm64_sequoia", "arm64_sonoma", "sonoma"];
const SYMBOL_CELLARS = new Set(["any", "any_skip_relocation"]);

export function generateBottleBlock(jsonObjects, { expectedTags = EXPECTED_TAGS } = {}) {
  let rootUrl;
  let rebuild;
  const tags = {};

  for (const obj of jsonObjects) {
    const entry = Object.values(obj)[0];
    const bottle = entry?.bottle;
    if (!bottle) {
      throw new Error("bottle json missing .bottle");
    }

    if (rootUrl === undefined) {
      rootUrl = bottle.root_url;
    } else if (rootUrl !== bottle.root_url) {
      throw new Error(`root_url mismatch: ${rootUrl} vs ${bottle.root_url}`);
    }

    if (rebuild === undefined) {
      rebuild = bottle.rebuild ?? 0;
    }

    for (const [tag, info] of Object.entries(bottle.tags ?? {})) {
      tags[tag] = {
        sha256: info.sha256,
        cellar: info.cellar ?? bottle.cellar ?? "any_skip_relocation",
      };
    }
  }

  if (!rootUrl) {
    throw new Error("no root_url found in bottle json");
  }

  for (const tag of expectedTags) {
    if (!tags[tag]) {
      throw new Error(`missing bottle for platform: ${tag}`);
    }
  }

  const cellarToken = (cellar) => (
    SYMBOL_CELLARS.has(cellar) ? `:${cellar}` : JSON.stringify(cellar)
  );
  const width = Math.max(...expectedTags.map((tag) => tag.length));
  const lines = [
    "  bottle do",
    `    root_url "${rootUrl}"`,
  ];

  if (rebuild > 0) {
    lines.push(`    rebuild ${rebuild}`);
  }

  for (const tag of expectedTags) {
    const { sha256, cellar } = tags[tag];
    const pad = " ".repeat(width - tag.length);
    lines.push(`    sha256 cellar: ${cellarToken(cellar)}, ${tag}:${pad} "${sha256}"`);
  }

  lines.push("  end");
  return lines.join("\n");
}

function getArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const bottlesDir = getArg(args, "--bottles");
  const formulaPath = getArg(args, "--formula");

  if (!bottlesDir) {
    throw new Error("usage: --bottles <dir> [--formula <path>]");
  }

  const jsonObjects = readdirSync(bottlesDir)
    .filter((file) => file.endsWith(".bottle.json"))
    .map((file) => JSON.parse(readFileSync(join(bottlesDir, file), "utf8")));
  const block = generateBottleBlock(jsonObjects);

  if (formulaPath) {
    const formula = readFileSync(formulaPath, "utf8");
    const placeholder = /^[ \t]*# __BOTTLE_BLOCK__[ \t]*$/m;
    if (!placeholder.test(formula)) {
      throw new Error("placeholder # __BOTTLE_BLOCK__ not found in formula");
    }
    writeFileSync(formulaPath, formula.replace(placeholder, block));
  }

  console.log(block);
}
