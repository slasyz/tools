import type { ToolContext } from "@opencode/plugin/promise/tool";

import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";

// Loaded only by the opt-in integration fixture. Exercise real transformed
// tool executors without sending a model request.
const Driver = Rpc.define({
  id: "sandbox-test-driver",
  methods: {
    invoke: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          tool: { type: "string" },
          args: { type: "object" },
        },
        required: ["sessionID", "tool", "args"],
      },
      output: {},
      errors: {
        denied: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      },
    },
  },
  events: {},
});

export default Plugin.define({
  id: "sandbox-test-driver",
  async setup(ctx) {
    await ctx.rpc.register(Driver, {
      invoke: async (input, context) => {
        const {
          sessionID,
          tool: name,
          args,
        } = input as { sessionID: string; tool: string; args: unknown };
        const tool = (await ctx.tool.list()).find((item) => item.id === name);
        if (!tool) throw new Error(`Missing fixture tool: ${name}`);
        try {
          const result = await tool.execute(args, {
            sessionID,
            agent: "build",
            messageID: "msg_sandboxfixture",
            id: "call_sandboxfixture",
            signal: context.signal,
            progress: async () => {},
          } as unknown as ToolContext);
          return JSON.parse(JSON.stringify(result));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return context.error("denied", reason, { reason });
        }
      },
    });
  },
});
