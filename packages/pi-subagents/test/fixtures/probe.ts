import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subagents-probe", {
    description: "Test-only RPC startup probe",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        JSON.stringify({
          child: process.env.PI_SUBAGENTS_CHILD,
          tools: pi.getAllTools().map((tool) => tool.name),
          cwd: ctx.cwd,
        }),
        "info",
      );
    },
  });
}
