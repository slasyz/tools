import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentView, Status } from "./agents.ts";
import type { RecordValue } from "./rpc.ts";

import { oneLine } from "./output.ts";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const statusStyle: Record<Status, { glyph: string; color: ThemeColor }> = {
  starting: { glyph: "○", color: "muted" },
  running: { glyph: spinnerFrames[0], color: "accent" },
  idle: { glyph: "✓", color: "success" },
  interrupted: { glyph: "■", color: "warning" },
  failed: { glyph: "✗", color: "error" },
};
// The glyph alone is clear for these; other statuses also show their name.
const glyphOnly = new Set<Status>(["running", "idle"]);

export function renderAgents(ctx: ExtensionContext, agents: AgentView[]): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    "pi-subagents",
    agents.length
      ? (tui, theme) => {
          let frame = 0;
          const timer = agents.some((agent) => agent.status === "running")
            ? setInterval(() => {
                frame = (frame + 1) % spinnerFrames.length;
                tui.requestRender();
              }, 80)
            : undefined;
          timer?.unref();
          return {
            render: (width: number) => widgetLines(agents, theme, width, frame),
            invalidate() {},
            dispose() {
              if (timer) clearInterval(timer);
            },
          };
        }
      : undefined,
  );
}

export function widgetLines(
  agents: AgentView[],
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
  frame = 0,
): string[] {
  const counts = (Object.keys(statusStyle) as Status[])
    .map((status) => [status, agents.filter((agent) => agent.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ");
  const rule = (text: string) => theme.fg("borderMuted", text);
  const title = `${rule("── ")}${theme.fg("accent", theme.bold("Subagents"))}${rule(" ─ ")}${theme.fg("muted", counts)} `;
  const header = title + rule("─".repeat(Math.max(0, width - visibleWidth(title))));

  const idWidth = Math.max(...agents.map((agent) => agent.id.length));
  const rows = agents.map((agent) => {
    const { color } = statusStyle[agent.status];
    const glyph =
      agent.status === "running"
        ? spinnerFrames[frame % spinnerFrames.length]
        : statusStyle[agent.status].glyph;
    const prefix = `  ${theme.fg(color, glyph)} ${theme.fg("dim", agent.id.padEnd(idWidth))}  `;
    const suffix = glyphOnly.has(agent.status) ? "" : `  ${theme.fg(color, agent.status)}`;
    const room = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
    return prefix + truncateToWidth(oneLine(agent.task_name), room, "…") + suffix;
  });
  return [header, ...rows].map((line) => truncateToWidth(line, width, ""));
}

export function dialogBridge(getContext: () => ExtensionContext | undefined) {
  let queue: Promise<unknown> = Promise.resolve();
  return (
    agent: AgentView,
    request: RecordValue,
    signal: AbortSignal,
  ): Promise<RecordValue | undefined> => {
    if (request.method === "notify") {
      const ctx = getContext();
      if (ctx?.hasUI)
        ctx.ui.notify(
          `[${oneLine(agent.task_name)}] ${request.message}`,
          request.notifyType ?? "info",
        );
      return Promise.resolve(undefined);
    }
    if (!["confirm", "select", "input", "editor"].includes(request.method))
      return Promise.resolve(undefined);
    const answer = queue.then(async () => {
      const ctx = getContext();
      if (!ctx?.hasUI || signal.aborted) return { cancelled: true };
      const title = `[${oneLine(agent.task_name)}] ${request.title ?? "Subagent"}`;
      const opts = { signal, timeout: request.timeout };
      if (request.method === "confirm") {
        return { confirmed: await ctx.ui.confirm(title, request.message ?? "", opts) };
      }
      if (request.method === "editor") {
        // Pi's editor dialog cannot be cancelled by an AbortSignal.
        ctx.ui.notify(
          `${title}: editor requests are not supported by background agents`,
          "warning",
        );
        return { cancelled: true };
      }
      const value =
        request.method === "select"
          ? await ctx.ui.select(title, request.options ?? [], opts)
          : await ctx.ui.input(title, request.placeholder, opts);
      return value === undefined ? { cancelled: true } : { value };
    });
    queue = answer.catch(() => {});
    return answer;
  };
}
