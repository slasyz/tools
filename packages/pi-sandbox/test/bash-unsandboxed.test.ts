import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

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

async function executeWithRpcApproval(command: string, confirmed: boolean) {
  const tool = createTool();
  const confirm = vi.fn(async () => confirmed);
  const result = await tool.execute("test", { command }, undefined, undefined, {
    cwd: process.cwd(),
    hasUI: true,
    mode: "rpc",
    signal: new AbortController().signal,
    sessionManager: {
      getSessionId: () => "test",
      getSessionFile: () => undefined,
    },
    ui: {
      confirm,
    },
  } as never);
  return { result, confirm };
}

test("puts the full command in an RPC confirmation message, not its title", async () => {
  const command = `echo ok # ${"x".repeat(200)}`;
  const { result, confirm } = await executeWithRpcApproval(command, false);

  expect(confirm).toHaveBeenCalledWith(
    "Run command outside the sandbox?",
    `Working directory: ${process.cwd()}\n\nCommand:\n${command}`,
    { signal: expect.any(AbortSignal), timeout: 5 * 60_000 },
  );
  expect(result.content).toEqual([
    {
      type: "text",
      text: "Command not run: unsandboxed execution was not approved (denied, cancelled, or timed out).",
    },
  ]);
});

test("executes the command only after RPC approval", async () => {
  const { result, confirm } = await executeWithRpcApproval("printf approved", true);

  expect(confirm).toHaveBeenCalledOnce();
  expect(result.content).toEqual([{ type: "text", text: "approved" }]);
});

test("refuses commands too long to show in an RPC approval prompt", async () => {
  const { result, confirm } = await executeWithRpcApproval("x".repeat(8192), true);

  expect(confirm).not.toHaveBeenCalled();
  expect(result.content).toEqual([
    {
      type: "text",
      text: "Command not run: the command and working directory are too long to display in the RPC approval prompt.",
    },
  ]);
});
