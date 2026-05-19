// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { loadFreshEsm } from "../helpers.ts";

function fakeSelinuxFs(flag) {
  return {
    reads: 0,
    readFileSync(pathname, encoding) {
      assert.equal(pathname, "/sys/fs/selinux/enforce");
      assert.equal(encoding, "utf8");
      this.reads += 1;
      return flag;
    }
  };
}

test("selinuxLabelForMount returns null outside native linux", async () => {
  const { selinuxLabelForMount } = await loadFreshEsm("lib/sandbox/engines/selinux.js");
  const fsImpl = fakeSelinuxFs("1\n");

  assert.equal(selinuxLabelForMount("wsl2", { platform: "linux", fs: fsImpl, env: {} }), null);
  assert.equal(selinuxLabelForMount("native", { platform: "darwin", fs: fsImpl, env: {} }), null);
  assert.equal(fsImpl.reads, 0);
});

test("selinuxLabelForMount returns null when enforcing flag is absent", async () => {
  const { selinuxLabelForMount } = await loadFreshEsm("lib/sandbox/engines/selinux.js");
  const fsImpl = {
    readFileSync() {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  };

  assert.equal(selinuxLabelForMount("native", { platform: "linux", fs: fsImpl, env: {} }), null);
});

test("selinuxLabelForMount reads enforcing flag once per injected filesystem", async () => {
  const { selinuxLabelForMount } = await loadFreshEsm("lib/sandbox/engines/selinux.js");
  const fsImpl = fakeSelinuxFs("1\n");
  const options = { platform: "linux", fs: fsImpl, env: {} };

  assert.equal(selinuxLabelForMount("native", options), "z");
  assert.equal(selinuxLabelForMount("native", options), "z");
  assert.equal(fsImpl.reads, 1);
});

test("selinuxLabelForMount supports disable environment controls", async () => {
  const { selinuxLabelForMount } = await loadFreshEsm("lib/sandbox/engines/selinux.js");

  assert.equal(selinuxLabelForMount("native", {
    platform: "linux",
    fs: fakeSelinuxFs("1\n"),
    env: {}
  }), "z");
  assert.equal(selinuxLabelForMount("native", {
    platform: "linux",
    fs: fakeSelinuxFs("1\n"),
    env: { AGENT_INFRA_SELINUX_DISABLE: "0" }
  }), "z");
  assert.equal(selinuxLabelForMount("native", {
    platform: "linux",
    fs: fakeSelinuxFs("1\n"),
    env: { AGENT_INFRA_SELINUX_DISABLE: "" }
  }), "z");
  assert.equal(selinuxLabelForMount("native", {
    platform: "linux",
    fs: fakeSelinuxFs("1\n"),
    env: { AGENT_INFRA_SELINUX_DISABLE: "1" }
  }), null);
});

test("validateSelinuxDisableEnv rejects invalid disable values", async () => {
  const { validateSelinuxDisableEnv } = await loadFreshEsm("lib/sandbox/engines/selinux.js");

  assert.doesNotThrow(() => validateSelinuxDisableEnv({}));
  assert.doesNotThrow(() => validateSelinuxDisableEnv({ AGENT_INFRA_SELINUX_DISABLE: "" }));
  assert.doesNotThrow(() => validateSelinuxDisableEnv({ AGENT_INFRA_SELINUX_DISABLE: "0" }));
  assert.doesNotThrow(() => validateSelinuxDisableEnv({ AGENT_INFRA_SELINUX_DISABLE: "1" }));
  assert.throws(
    () => validateSelinuxDisableEnv({ AGENT_INFRA_SELINUX_DISABLE: "invalid" }),
    /Invalid AGENT_INFRA_SELINUX_DISABLE/
  );
});
