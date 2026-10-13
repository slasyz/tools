import type { Context } from "@opencode/plugin/tui/context";

import { Plugin } from "@opencode/plugin/tui";

import type { PendingPrompt, PromptReply } from "./prompts.ts";

import { SandboxRpc } from "./rpc.ts";
import { formatSandboxStatus, type SandboxStatus } from "./ui.ts";

export async function permissionDialog(ctx: Context, request: PendingPrompt): Promise<PromptReply> {
  const abort: PromptReply = { action: "abort", value: request.target, confirmed: false };
  if (request.kind === "disable" || request.kind === "unsandboxed") {
    const confirmed = await ctx.ui.dialog.confirm({
      title: request.title,
      message: request.target,
      label: {
        confirm: request.kind === "disable" ? "Disable" : "Run unsandboxed",
        cancel: "Abort",
      },
    });
    return confirmed ? { action: "session", value: request.target, confirmed: true } : abort;
  }
  const choice = await ctx.ui.dialog.select({
    title: request.title,
    options: [
      { title: "Allow for this session only", value: "session" },
      { title: "Edit rule and allow for this session", value: "edit-session" },
      { title: "Abort (keep blocked)", value: "abort" },
      {
        title: "Allow for all projects",
        value: "global",
        description: "Save to ~/.agents/sandbox.json (also used by Pi)",
      },
      { title: "Edit rule and allow for all projects", value: "edit-global" },
    ],
  });
  if (!choice || choice === "abort") return abort;
  let value = request.target;
  if (choice.startsWith("edit-")) {
    const edited = await ctx.ui.dialog.prompt({ title: "Edit permission rule", value });
    if (edited === undefined) return abort;
    value = edited.trim();
    if (!value) return abort;
  }
  const action = choice.endsWith("global") ? "global" : "session";
  const confirmed =
    action === "global" &&
    (await ctx.ui.dialog.confirm({
      title: "Allow for all projects?",
      message: `Save "${value}" to ~/.agents/sandbox.json? This also changes Pi's sandbox rules.`,
    }));
  if (action === "global" && !confirmed) return abort;
  return { action, value, confirmed: confirmed === true };
}

export default Plugin.define({
  id: "opencode-sandbox.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(SandboxRpc);
    const clientID = crypto.randomUUID();
    let stopped = false;
    let polling = false;
    let dialogOpen = false;
    const handled = new Set<string>();
    const sessionID = () => {
      const route = ctx.ui.router.current();
      if (route.type !== "session") throw new Error("Open a session to manage its sandbox");
      return route.sessionID;
    };
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() });
    const report = (error: unknown) =>
      ctx.ui.toast.show({
        title: "Sandbox",
        variant: "error",
        message:
          error && typeof error === "object" && "message" in error
            ? String(error.message)
            : String(error),
      });

    async function display(request: PendingPrompt) {
      dialogOpen = true;
      try {
        const claimed = await rpc.claim({ id: request.id, clientID }, options());
        if (!claimed || stopped) return;
        handled.add(request.id);
        void ctx.attention
          .notify({
            title: "OpenCode sandbox",
            message: "Permission required",
            notification: { when: "blurred" },
          })
          .catch(() => {});
        const reply = await permissionDialog(ctx, request);
        if (!stopped) await rpc.reply({ id: request.id, clientID, ...reply }, options());
      } catch (error) {
        if (!stopped) report(error);
      } finally {
        dialogOpen = false;
      }
    }

    async function poll() {
      if (polling || stopped) return;
      const route = ctx.ui.router.current();
      if (route.type !== "session") return;
      polling = true;
      try {
        const requests = (await rpc.poll(
          { sessionID: route.sessionID, clientID },
          options(),
        )) as PendingPrompt[];
        // Keep heartbeats running while a dialog or a control RPC is waiting.
        if (!dialogOpen && !stopped) {
          const next = requests.find((request) => !handled.has(request.id));
          if (next) void display(next);
        }
      } catch {
        /* Server plugin absent, disconnected, or reloading: no approval. */
      } finally {
        polling = false;
      }
    }

    const commands = [
      { name: "sandbox", title: "Show sandbox configuration", command: "status" },
      { name: "sandbox-enable", title: "Enable sandbox for this session", command: "enable" },
      {
        name: "sandbox-disable",
        title: "Disable sandbox for this session (confirm)",
        command: "disable",
      },
      { name: "sandbox-allow", title: "Allow a sandbox domain or path", command: "allow" },
    ];
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: commands.map(({ name, title, command }) => ({
        id: `opencode-sandbox.${name}`,
        title,
        group: "Sandbox",
        palette: true,
        slash: { name, ...(command === "allow" ? { arguments: true as const } : {}) },
        run: async (input?: string) => {
          try {
            const id = sessionID();
            // Register liveness before the server asks for an approval.
            await rpc.poll({ sessionID: id, clientID }, options());
            const result =
              command === "status"
                ? await rpc.status({ sessionID: id }, options())
                : await rpc.control({ sessionID: id, command, arguments: input ?? "" }, options());
            if (command === "status")
              await ctx.ui.dialog.alert({
                title: "Sandbox configuration",
                message: formatSandboxStatus(result as SandboxStatus),
              });
            else
              ctx.ui.toast.show({
                title: "Sandbox",
                message: "Sandbox settings updated",
                variant: "success",
              });
          } catch (error) {
            report(error);
          }
        },
      })),
    }));
    const timer = setInterval(() => void poll(), 1000);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  },
});
