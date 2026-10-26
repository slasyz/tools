import type { Component, TUI } from "@earendil-works/pi-tui";

import {
  createEventBus,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";

import registerBashUnsandboxed from "../src/bash-unsandboxed.ts";
import { promptDomainBlock } from "../src/ui.ts";

const BLOCKED = "\x1b]7501;state=blocked:kind=permission:app=pi\x1b\\";
const WORKING = "\x1b]7501;state=working:app=pi\x1b\\";

function createPrompt(mode: "tui" | "rpc" = "tui") {
  const write = vi.fn();
  const tui = { terminal: { write }, requestRender() {} } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  let component: Component | undefined;
  let close: ((value: undefined) => void) | undefined;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode,
    sessionManager: {
      getSessionId: () => "test",
      getSessionFile: () => undefined,
    },
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise((resolve) => {
          close = resolve;
          const result = factory(tui, theme, {} as KeybindingsManager, resolve);
          assert.ok(!(result instanceof Promise));
          component = result;
        }),
      select: async () => {
        assert.equal(write.mock.calls.length, 0);
        return "Allow for this session only";
      },
      confirm: async () => {
        assert.equal(write.mock.calls.length, 0);
        return false;
      },
    },
  } as unknown as ExtensionContext;
  const pi = { events: createEventBus() } as unknown as ExtensionAPI;
  return {
    pi,
    ctx,
    write,
    input: (key: string) => component?.handleInput?.(key),
    cancel: () => close?.(undefined),
  };
}

test.each([
  ["approval", "\r", "session"],
  ["rejection", "\x1b", "abort"],
  ["cancellation", "\x03", "abort"],
])("reports waiting and running around a rule prompt: %s", async (_name, key, action) => {
  const { pi, ctx, write, input } = createPrompt();
  const pending = promptDomainBlock(pi, ctx, { host: "example.com", port: 443 });

  expect(write.mock.calls).toEqual([[BLOCKED]]);
  // Editing a rule does not end the permission wait.
  input("\t");
  expect(write.mock.calls).toEqual([[BLOCKED]]);
  if (key === "\x1b") input("\x1b"); // Leave rule editing before rejecting.
  input(key);

  expect(await pending).toEqual({ action, value: "example.com:443" });
  expect(write.mock.calls).toEqual([[BLOCKED], [WORKING]]);
});

test("restores running status if a rule prompt closes without a response", async () => {
  const { pi, ctx, write, cancel } = createPrompt();
  const pending = promptDomainBlock(pi, ctx, { host: "example.com", port: 443 });
  expect(write.mock.calls).toEqual([[BLOCKED]]);
  cancel();

  expect(await pending).toEqual({ action: "abort", value: "example.com:443" });
  expect(write.mock.calls).toEqual([[BLOCKED], [WORKING]]);
});

test("restores running status if building a rule prompt fails", async () => {
  const { pi, ctx, write } = createPrompt();
  const error = new Error("Unable to render dialog");
  const originalCustom = ctx.ui.custom;
  ctx.ui.custom = (factory) =>
    originalCustom((...args) => {
      factory(...args);
      throw error;
    });

  await expect(promptDomainBlock(pi, ctx, { host: "example.com", port: 443 })).rejects.toThrow(
    error,
  );
  expect(write.mock.calls).toEqual([[BLOCKED], [WORKING]]);
});

function createUnsandboxedTool(pi: ExtensionAPI): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerBashUnsandboxed({
    ...pi,
    registerTool(registeredTool: ToolDefinition) {
      tool = registeredTool;
    },
  } as ExtensionAPI);
  assert.ok(tool);
  return tool;
}

test.each([
  ["approval", "\r", "approved"],
  ["rejection", "\x1b", "Command not run: user denied permission."],
])("reports waiting and running for unsandboxed command %s", async (_name, key, text) => {
  initTheme("dark", false);
  const { pi, ctx, write, input } = createPrompt();
  const tool = createUnsandboxedTool(pi);
  const pending = tool.execute("test", { command: "printf approved" }, undefined, undefined, ctx);

  expect(write.mock.calls).toEqual([[BLOCKED]]);
  input(key);

  expect((await pending).content).toEqual([{ type: "text", text }]);
  expect(write.mock.calls).toEqual([[BLOCKED], [WORKING]]);
});

test("does not write terminal status for RPC permission prompts", async () => {
  const { pi, ctx, write } = createPrompt("rpc");
  await promptDomainBlock(pi, ctx, { host: "example.com", port: 443 });
  await createUnsandboxedTool(pi).execute(
    "test",
    { command: "printf approved" },
    undefined,
    undefined,
    ctx,
  );
  expect(write).not.toHaveBeenCalled();
});

test("does not write terminal status without a UI", async () => {
  const { pi, ctx, write } = createPrompt();
  ctx.hasUI = false;
  expect(await promptDomainBlock(pi, ctx, { host: "example.com", port: 443 })).toEqual({
    action: "abort",
    value: "example.com:443",
  });
  await createUnsandboxedTool(pi).execute(
    "test",
    { command: "printf approved" },
    undefined,
    undefined,
    ctx,
  );
  expect(write).not.toHaveBeenCalled();
});
