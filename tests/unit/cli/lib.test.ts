import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";

import { filePath, loadFreshEsm, renderPlaceholders } from "../../helpers.ts";
import * as paths from "../../../lib/paths.ts";

test("resolveTemplateDir returns the bundled templates directory", () => {
  assert.equal(paths.resolveTemplateDir(), filePath("templates"));
});

test("renderPlaceholders only replaces double-brace placeholders", () => {
  const rendered = renderPlaceholders(
    "literal {project} {{project}} {org} {{org}}",
    { project: "demo", org: "acme" }
  );

  assert.equal(rendered, "literal {project} demo {org} acme");
});

type PromptModule = typeof import("../../../lib/prompt.ts");

type ReadlineHandlers = Record<string, (arg?: unknown) => void>;

async function withMockedReadline<T>(line: string | null, fn: (mod: PromptModule) => Promise<T>): Promise<T> {
  const originalCreateInterface = readline.createInterface;
  const originalStdoutWrite = process.stdout.write;

  readline.createInterface = (() => {
    const handlers: ReadlineHandlers = {};
    setTimeout(() => {
      if (line === null) {
        handlers.close?.();
      } else {
        handlers.line?.(line);
      }
    }, 0);
    return {
      on(event: string, handler: (arg?: unknown) => void) {
        handlers[event] = handler;
        return this;
      },
      close() {
        handlers.close?.();
      }
    };
  }) as unknown as typeof readline.createInterface;
  try {
    const mod = await loadFreshEsm<PromptModule>("lib/prompt.js");
    return await fn(mod);
  } finally {
    readline.createInterface = originalCreateInterface;
    process.stdout.write = originalStdoutWrite;
  }
}

const TUI_CHOICES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "gemini-cli", label: "Gemini CLI" },
  { id: "opencode", label: "OpenCode" }
];

test("multiSelect returns all ids for bare Enter (default)", async () => {
  const result = await withMockedReadline(null, async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(result, ["claude-code", "codex", "gemini-cli", "opencode"]);
});

test("multiSelect parses numeric tokens", async () => {
  const result = await withMockedReadline("1,3", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(result, ["claude-code", "gemini-cli"]);
});

test("multiSelect parses id tokens", async () => {
  const result = await withMockedReadline("claude-code,opencode", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(result, ["claude-code", "opencode"]);
});

test("multiSelect parses mixed numeric and id tokens", async () => {
  const result = await withMockedReadline("1,opencode", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(result, ["claude-code", "opencode"]);
});

test("multiSelect returns empty array on explicit 'none' input", async () => {
  const lower = await withMockedReadline("none", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(lower, []);

  // Case-insensitive and trim-tolerant: " NONE " should also work.
  const padded = await withMockedReadline(" NONE ", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(padded, []);
});

test("multiSelect normalizes user input order to choices order (AC2.2)", async () => {
  // User typed numeric in reverse order: 3,1 -> gemini-cli, claude-code.
  // Returned array must follow choices order: claude-code, gemini-cli.
  const numeric = await withMockedReadline("3,1", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(numeric, ["claude-code", "gemini-cli"]);

  // Same expectation for id tokens typed out of order.
  const ids = await withMockedReadline("opencode,claude-code", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(ids, ["claude-code", "opencode"]);
});

test("multiSelect allows whitespace around tokens", async () => {
  const result = await withMockedReadline(" 1 , 3 ", async (mod) => mod.multiSelect("Pick", TUI_CHOICES));
  assert.deepEqual(result, ["claude-code", "gemini-cli"]);
});

test("multiSelect rejects whitespace-only input (not bare Enter)", async () => {
  await assert.rejects(
    () => withMockedReadline(" ", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /empty token/
  );
});

test("multiSelect rejects duplicate numeric tokens", async () => {
  await assert.rejects(
    () => withMockedReadline("1,1,1", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /Duplicate selection/
  );
});

test("multiSelect rejects numeric/id resolving to the same id as duplicate", async () => {
  await assert.rejects(
    () => withMockedReadline("1,claude-code", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /Duplicate selection/
  );
});

test("multiSelect rejects out-of-range zero", async () => {
  await assert.rejects(
    () => withMockedReadline("0", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /out of range/
  );
});

test("multiSelect rejects out-of-range upper bound", async () => {
  await assert.rejects(
    () => withMockedReadline("5", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /out of range/
  );
});

test("multiSelect rejects unknown id token", async () => {
  await assert.rejects(
    () => withMockedReadline("abc", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /Unknown TUI selection token/
  );
});

test("multiSelect rejects empty tokens between commas", async () => {
  await assert.rejects(
    () => withMockedReadline("1,,2", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /empty token/
  );
});

test("multiSelect rejects leading or trailing comma", async () => {
  await assert.rejects(
    () => withMockedReadline(",1", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /empty token/
  );
  await assert.rejects(
    () => withMockedReadline("1,", async (mod) => mod.multiSelect("Pick", TUI_CHOICES)),
    /empty token/
  );
});

test("prompt does not recreate readline after close", async () => {
  const originalCreateInterface = readline.createInterface;
  const originalStdoutWrite = process.stdout.write;
  let createCount = 0;

  readline.createInterface = (() => {
    createCount += 1;
    const handlers: Record<string, () => void> = {};

    return {
      on(event: string, handler: () => void) {
        handlers[event] = handler;
        return this;
      },
      close() {
        if (handlers.close) {
          handlers.close();
        }
      }
    };
  }) as unknown as typeof readline.createInterface;
  process.stdout.write = () => true;

  try {
    const promptModule = await loadFreshEsm<typeof import("../../../lib/prompt.ts")>("lib/prompt.js");
    const firstPrompt = promptModule.prompt("Project name", "demo");

    promptModule.closePrompt();
    const firstValue = await firstPrompt;
    const secondValue = await promptModule.prompt("Project name", "demo");

    assert.equal(firstValue, "demo");
    assert.equal(secondValue, "demo");
    assert.equal(createCount, 1);
  } finally {
    readline.createInterface = originalCreateInterface;
    process.stdout.write = originalStdoutWrite;
  }
});
