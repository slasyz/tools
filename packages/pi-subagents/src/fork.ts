import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { randomUUID } from "node:crypto";

/** Snapshot only the active branch, stopping before the in-flight spawning turn. */
export function forkSnapshot(
  manager: ExtensionContext["sessionManager"],
  toolCallId: string,
): string {
  let entries = manager.getBranch();
  const spawningTurn = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some(
        (part) =>
          part.type === "toolCall" &&
          (part.id === toolCallId || toolCallId.startsWith(`${part.id}/`)),
      ),
  );
  if (spawningTurn !== -1) entries = entries.slice(0, spawningTurn);
  entries = completeTurns(entries);
  return (
    [
      {
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: manager.getCwd(),
        parentSession: manager.getSessionFile(),
      },
      ...entries,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

function completeTurns(entries: SessionEntry[]): SessionEntry[] {
  const results = new Set(
    entries.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
        ? [entry.message.toolCallId]
        : [],
    ),
  );
  const incomplete = entries.findIndex(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some((part) => part.type === "toolCall" && !results.has(part.id)),
  );
  return incomplete === -1 ? entries : entries.slice(0, incomplete);
}
