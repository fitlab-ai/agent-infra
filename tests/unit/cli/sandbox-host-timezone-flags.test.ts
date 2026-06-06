import test from "node:test";
import assert from "node:assert/strict";

import { loadFreshEsm } from "../../helpers.ts";

type EnterModule = {
  hostTimezoneEnvFlags(detect?: () => string | null): string[];
};

test("hostTimezoneEnvFlags forwards the detected IANA timezone", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  assert.deepEqual(sandboxEnter.hostTimezoneEnvFlags(() => "Europe/Paris"), [
    "-e",
    "TZ=Europe/Paris"
  ]);
});

test("hostTimezoneEnvFlags omits TZ when detection fails", async () => {
  const sandboxEnter = await loadFreshEsm<EnterModule>("lib/sandbox/commands/enter.js");

  assert.deepEqual(sandboxEnter.hostTimezoneEnvFlags(() => null), []);
});
