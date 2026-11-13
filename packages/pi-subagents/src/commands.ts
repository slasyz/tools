import { copyToClipboard, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { constants } from "node:fs";
import { access } from "node:fs/promises";

import type { AgentView } from "./agents.ts";

import { oneLine } from "./output.ts";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function copyAgentSnapshot(
  ctx: ExtensionContext,
  agents: AgentView[],
  copy: (text: string) => Promise<void> = copyToClipboard,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/agents requires interactive terminal mode.", "warning");
    return;
  }
  const available = agents.filter((agent) => agent.session_file && agent.status !== "starting");
  if (!available.length) {
    ctx.ui.notify("No subagent sessions are available yet.", "info");
    return;
  }
  const labels = available.map(
    (agent) => `${agent.id} · ${agent.status} · ${oneLine(agent.task_name)}`,
  );
  const selected = await ctx.ui.select("Subagents", labels);
  if (selected === undefined) return;
  const agent = available[labels.indexOf(selected)];
  if (!agent?.session_file) return;
  const action = "Copy snapshot command";
  if ((await ctx.ui.select(`${agent.id} · Saved transcript (not live)`, [action])) !== action)
    return;

  try {
    await access(agent.session_file, constants.R_OK);
  } catch {
    ctx.ui.notify("This subagent's session file is no longer available.", "error");
    return;
  }
  const command = `cd ${shellQuote(ctx.cwd)} && pi --fork ${shellQuote(agent.session_file)}`;
  try {
    await copy(command);
    ctx.ui.notify("Snapshot command copied. Paste it into another terminal.", "info");
  } catch (error) {
    ctx.ui.notify(
      `Could not copy snapshot command: ${oneLine(String(error))}\nCopy it manually:\n${command}`,
      "error",
    );
  }
}
