import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import registerBashUnsandboxed from "../src/bash-unsandboxed.ts";

function createTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerBashUnsandboxed({
    events: createEventBus(),
    registerTool(registeredTool: ToolDefinition) {
      tool = registeredTool;
    },
  } as unknown as ExtensionAPI);

  if (!tool) throw new Error("bash_unsandboxed tool was not registered");
  return tool;
}

async function executeWithRpcChoice(choice: string | undefined) {
  const tool = createTool();
  return tool.execute("test", { command: "pwd" }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    mode: "rpc",
    signal: new AbortController().signal,
    ui: {
      select: async () => choice,
    },
  } as never);
}

test("reports an explicit RPC rejection as a user denial", async () => {
  const result = await executeWithRpcChoice("Reject");

  expect(result.content).toEqual([
    { type: "text", text: "Command not run: user denied permission." },
  ]);
});

test("explains a cancelled or timed-out RPC approval request", async () => {
  const result = await executeWithRpcChoice(undefined);

  expect(result.content).toEqual([
    {
      type: "text",
      text: "Command not run: approval was cancelled or timed out. RPC clients must handle extension_ui_request and reply with extension_ui_response.",
    },
  ]);
});
