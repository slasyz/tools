import test from "node:test";

import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import registerApplyPatchExtension from "pi-apply-patch";

import registerSandboxExtension from "../src/extension.ts";

test("loading pi-sandbox with pi-apply-patch registers apply_patch only once", () => {
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

  registerApplyPatchExtension(api);
  registerSandboxExtension(api);

  assert.equal(registeredToolNames.filter((name) => name === "apply_patch").length, 1);
});
