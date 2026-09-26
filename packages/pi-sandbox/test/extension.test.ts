import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "vitest";

import { requestSandboxAuthorization } from "../src/api.ts";
import registerSandboxExtension from "../src/extension.ts";

test("loading pi-sandbox does not register tools owned by permission requesters", () => {
  const registeredToolNames: string[] = [];
  const api = {
    events: createEventBus(),
    registerTool(tool: ToolDefinition) {
      registeredToolNames.push(tool.name);
    },
    registerFlag() {},
    registerCommand() {},
    on() {
      return () => {};
    },
    getFlag() {
      return false;
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  } as unknown as ExtensionAPI;

  registerSandboxExtension(api);

  assert.equal(registeredToolNames.includes("apply_patch"), false);
});

test("an inactive pi-sandbox rejects authorization requests", async () => {
  const api = {
    events: createEventBus(),
    registerTool() {},
    registerFlag() {},
    registerCommand() {},
    on() {
      return () => {};
    },
    getFlag() {
      return false;
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  registerSandboxExtension(api);

  await assert.rejects(
    requestSandboxAuthorization(api.events, {
      source: "test-extension",
      cwd: process.cwd(),
      accesses: [{ kind: "write", path: "file.txt" }],
    }),
    /Sandbox is inactive; operation blocked/,
  );
});
