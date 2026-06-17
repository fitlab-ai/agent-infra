import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFreshEsm } from "../../helpers.ts";

type ReadmeScaffoldModule = typeof import("../../../lib/sandbox/readme-scaffold.ts");
type ScaffoldFs = Pick<typeof fs, "mkdirSync" | "writeFileSync">;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

function githubHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (!match?.[1]) {
      continue;
    }
    const anchor = match[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\p{Mark}\s-]/gu, "")
      .replace(/\s+/g, "-");
    anchors.add(anchor);
  }
  return anchors;
}

function readmeFragments(markdown: string, filename: string): string[] {
  return [...markdown.matchAll(new RegExp(`${filename}#([^\\s)]+)`, "g"))]
    .map((match) => decodeURIComponent(match[1] ?? ""));
}

test("ensureDotfilesReadme creates dotfiles directory and README", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-dotfiles-readme-create-");
  const dotfilesDir = path.join(tmpDir, "dotfiles");

  try {
    const result = scaffold.ensureDotfilesReadme(dotfilesDir);

    assert.equal(result.created, true);
    assert.equal(result.path, path.join(dotfilesDir, "README.md"));
    assert.equal(fs.existsSync(dotfilesDir), true);
    assert.equal(fs.existsSync(result.path), true);
    assert.match(fs.readFileSync(result.path, "utf8"), /\n---\n/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDotfilesReadme preserves an existing README byte-for-byte", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-dotfiles-readme-existing-");
  const dotfilesDir = path.join(tmpDir, "dotfiles");
  const readmePath = path.join(dotfilesDir, "README.md");
  const userContent = "USER EDIT\n";

  try {
    fs.mkdirSync(dotfilesDir, { recursive: true });
    fs.writeFileSync(readmePath, userContent, "utf8");

    const result = scaffold.ensureDotfilesReadme(dotfilesDir);

    assert.equal(result.created, false);
    assert.equal(result.path, readmePath);
    assert.equal(fs.readFileSync(readmePath, "utf8"), userContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDotfilesReadme writes README when directory exists and README is missing", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-dotfiles-readme-missing-");
  const dotfilesDir = path.join(tmpDir, "dotfiles");

  try {
    fs.mkdirSync(dotfilesDir, { recursive: true });

    const result = scaffold.ensureDotfilesReadme(dotfilesDir);

    assert.equal(result.created, true);
    assert.equal(fs.existsSync(result.path), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDotfilesReadme warns and continues when writing fails", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const warnings: string[] = [];
  const fsModule: ScaffoldFs = {
    mkdirSync() {},
    writeFileSync() {
      throw makeError("EACCES");
    }
  };

  const result = scaffold.ensureDotfilesReadme("/tmp/dotfiles", {
    fsModule,
    writeStderr: (chunk) => warnings.push(chunk)
  });

  assert.equal(result.created, false);
  assert.equal(result.path, path.join("/tmp/dotfiles", "README.md"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /EACCES/);
});

test("ensureDotfilesReadme treats EEXIST during write as an idempotent skip", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const warnings: string[] = [];
  const fsModule: ScaffoldFs = {
    mkdirSync() {},
    writeFileSync() {
      throw makeError("EEXIST");
    }
  };

  const result = scaffold.ensureDotfilesReadme("/tmp/dotfiles", {
    fsModule,
    writeStderr: (chunk) => warnings.push(chunk)
  });

  assert.equal(result.created, false);
  assert.equal(warnings.length, 0);
});

test("ensureShareCommonReadme creates README under the common share directory", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-share-common-readme-create-");

  try {
    const result = scaffold.ensureShareCommonReadme({ shareBase: tmpDir });

    assert.equal(result.created, true);
    assert.equal(result.path, path.join(tmpDir, "common", "README.md"));
    assert.equal(fs.existsSync(result.path), true);
    assert.match(fs.readFileSync(result.path, "utf8"), /\n---\n/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureShareCommonReadme preserves an existing README byte-for-byte", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-share-common-readme-existing-");
  const readmePath = path.join(tmpDir, "common", "README.md");
  const userContent = "USER EDIT\n";

  try {
    fs.mkdirSync(path.dirname(readmePath), { recursive: true });
    fs.writeFileSync(readmePath, userContent, "utf8");

    const result = scaffold.ensureShareCommonReadme({ shareBase: tmpDir });

    assert.equal(result.created, false);
    assert.equal(result.path, readmePath);
    assert.equal(fs.readFileSync(readmePath, "utf8"), userContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureShareCommonReadme warns and skips writing when mkdir fails", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const warnings: string[] = [];
  let writeCalled = false;
  const fsModule: ScaffoldFs = {
    mkdirSync() {
      throw makeError("EACCES");
    },
    writeFileSync() {
      writeCalled = true;
    }
  };

  const result = scaffold.ensureShareCommonReadme({ shareBase: "/tmp/share" }, {
    fsModule,
    writeStderr: (chunk) => warnings.push(chunk)
  });

  assert.equal(result.created, false);
  assert.equal(writeCalled, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /EACCES/);
});

test("ensureShareBranchReadme uses the sanitized branch share directory", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-share-branch-readme-create-");

  try {
    const result = scaffold.ensureShareBranchReadme({ shareBase: tmpDir }, "feat/x");

    assert.equal(result.created, true);
    assert.equal(result.path, path.join(tmpDir, "branches", "feat..x", "README.md"));
    assert.equal(fs.existsSync(result.path), true);
    assert.match(fs.readFileSync(result.path, "utf8"), /\n---\n/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureShareBranchReadme preserves an existing README byte-for-byte", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-share-branch-readme-existing-");
  const readmePath = path.join(tmpDir, "branches", "feat..x", "README.md");
  const userContent = "USER EDIT\n";

  try {
    fs.mkdirSync(path.dirname(readmePath), { recursive: true });
    fs.writeFileSync(readmePath, userContent, "utf8");

    const result = scaffold.ensureShareBranchReadme({ shareBase: tmpDir }, "feat/x");

    assert.equal(result.created, false);
    assert.equal(result.path, readmePath);
    assert.equal(fs.readFileSync(readmePath, "utf8"), userContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureShareBranchReadme warns and continues when writing fails", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const warnings: string[] = [];
  const fsModule: ScaffoldFs = {
    mkdirSync() {},
    writeFileSync() {
      throw makeError("EACCES");
    }
  };

  const result = scaffold.ensureShareBranchReadme({ shareBase: "/tmp/share" }, "feat/x", {
    fsModule,
    writeStderr: (chunk) => warnings.push(chunk)
  });

  assert.equal(result.created, false);
  assert.equal(result.path, path.join("/tmp/share", "branches", "feat..x", "README.md"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /EACCES/);
});

test("ensureSandboxDiscoveryReadmes returns dotfiles common and branch results in order", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-discovery-readmes-order-");
  const dotfilesDir = path.join(tmpDir, "dotfiles");
  const shareBase = path.join(tmpDir, "share");

  try {
    const results = scaffold.ensureSandboxDiscoveryReadmes({ dotfilesDir, shareBase }, "feat/x");

    assert.deepEqual(results.map((result) => result.path), [
      path.join(dotfilesDir, "README.md"),
      path.join(shareBase, "common", "README.md"),
      path.join(shareBase, "branches", "feat..x", "README.md")
    ]);
    assert.deepEqual(results.map((result) => result.created), [true, true, true]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureSandboxDiscoveryReadmes continues after one scaffold write fails", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-discovery-readmes-failure-");
  const dotfilesDir = path.join(tmpDir, "dotfiles");
  const shareBase = path.join(tmpDir, "share");
  const warnings: string[] = [];
  const realWriteFileSync = fs.writeFileSync.bind(fs);
  const fsModule: ScaffoldFs = {
    mkdirSync: fs.mkdirSync.bind(fs),
    writeFileSync(targetPath, content, options) {
      if (targetPath === path.join(dotfilesDir, "README.md")) {
        throw makeError("EACCES");
      }
      realWriteFileSync(targetPath, content, options);
    }
  };

  try {
    const results = scaffold.ensureSandboxDiscoveryReadmes({ dotfilesDir, shareBase }, "feat/x", {
      fsModule,
      writeStderr: (chunk) => warnings.push(chunk)
    });

    assert.deepEqual(results.map((result) => result.created), [false, true, true]);
    assert.equal(warnings.length, 1);
    assert.equal(fs.existsSync(path.join(shareBase, "common", "README.md")), true);
    assert.equal(fs.existsSync(path.join(shareBase, "branches", "feat..x", "README.md")), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scaffold README links point to headings that exist in the docs sandbox pages", async () => {
  const scaffold = await loadFreshEsm<ReadmeScaffoldModule>("lib/sandbox/readme-scaffold.js");
  const tmpDir = makeTempDir("agent-infra-readme-anchor-check-");
  const dotfilesDir = path.join(tmpDir, "dotfiles");
  const shareBase = path.join(tmpDir, "share");

  try {
    const results = scaffold.ensureSandboxDiscoveryReadmes({ dotfilesDir, shareBase }, "feat/x");
    const generatedReadmes = results.map((result) => fs.readFileSync(result.path, "utf8"));
    const englishAnchors = githubHeadingAnchors(fs.readFileSync("docs/en/sandbox.md", "utf8"));
    const chineseAnchors = githubHeadingAnchors(fs.readFileSync("docs/zh-CN/sandbox.md", "utf8"));

    let englishChecked = 0;
    let chineseChecked = 0;
    for (const content of generatedReadmes) {
      for (const fragment of readmeFragments(content, "docs/en/sandbox.md")) {
        assert.equal(englishAnchors.has(fragment), true, `missing docs/en/sandbox.md anchor: ${fragment}`);
        englishChecked += 1;
      }
      for (const fragment of readmeFragments(content, "docs/zh-CN/sandbox.md")) {
        assert.equal(chineseAnchors.has(fragment), true, `missing docs/zh-CN/sandbox.md anchor: ${fragment}`);
        chineseChecked += 1;
      }
    }

    assert.ok(englishChecked > 0, "expected at least one docs/en/sandbox.md link fragment in scaffolded READMEs");
    assert.ok(chineseChecked > 0, "expected at least one docs/zh-CN/sandbox.md link fragment in scaffolded READMEs");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
