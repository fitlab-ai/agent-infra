import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTempDir, filePath } from "../../helpers.ts";

function runArchive(entries: Array<{ name: string; kind?: string; link?: string; content?: string }>) {
  const root = createTempDir("dependency-archive-");
  const archive = path.join(root, "deps.tar");
  const workspace = path.join(root, "checkout");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "sentinel"), "trusted");
  const create = spawnSync("python3", ["-c", `import io,json,sys,tarfile
with tarfile.open(sys.argv[1], 'w') as tar:
 for item in json.loads(sys.argv[2]):
  info=tarfile.TarInfo(item['name']); kind=item.get('kind','file')
  if kind=='symlink': info.type=tarfile.SYMTYPE; info.linkname=item['link']
  elif kind=='hardlink': info.type=tarfile.LNKTYPE; info.linkname=item['link']
  elif kind=='dir': info.type=tarfile.DIRTYPE
  else:
   data=item.get('content','').encode(); info.size=len(data)
  tar.addfile(info,io.BytesIO(data) if kind=='file' else None)
`, archive, JSON.stringify(entries)], { encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr);
  const result = spawnSync("python3", [filePath(".github/scripts/extract-locked-dependencies.py"), archive, workspace], { encoding: "utf8" });
  return { root, workspace, result };
}

test("dependency archive permits contained directories and regular files", () => {
  const { root, workspace, result } = runArchive([
    { name: "node_modules", kind: "dir" },
    { name: "node_modules/pkg/index.js", content: "module" }
  ]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, "node_modules/pkg/index.js"), "utf8"), "module");
    assert.equal(fs.readFileSync(path.join(workspace, "sentinel"), "utf8"), "trusted");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dependency archive rejects traversal, escaping links, link parents and non-dependency entries", () => {
  for (const entries of [
    [{ name: "node_modules", kind: "dir" }, { name: "node_modules/../sentinel", content: "bad" }],
    [{ name: "sentinel", content: "bad" }],
    [{ name: "node_modules", content: "bad" }],
    [{ name: "node_modules", kind: "dir" }, { name: "node_modules/pkg", content: "a" }, { name: "node_modules/pkg", content: "b" }],
    [{ name: "node_modules", kind: "dir" }, { name: "node_modules/link", kind: "symlink", link: "pkg" }],
    [{ name: "node_modules", kind: "dir" }, { name: "node_modules/link", kind: "symlink", link: "../../sentinel" }],
    [{ name: "node_modules/link", kind: "symlink", link: "pkg" }, { name: "node_modules/link/file", content: "bad" }],
    [{ name: "node_modules/link", kind: "hardlink", link: "sentinel" }],
    [{ name: "node_modules/x", kind: "symlink", link: "." }, { name: "node_modules/y", kind: "symlink", link: "x/.." }]
  ]) {
    const { root, workspace, result } = runArchive(entries);
    try {
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(path.join(workspace, "sentinel"), "utf8"), "trusted");
      assert.equal(fs.existsSync(path.join(workspace, "node_modules")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
