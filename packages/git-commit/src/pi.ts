import { CommandError } from "./process.ts";
import { firstSubject } from "./prompt.ts";

interface Usage {
  cost?: { total?: number };
}

interface Event {
  type: string;
  message?: {
    role: string;
    content: { type: string; text?: string }[];
    usage?: Usage;
    stopReason?: string;
  };
  result?: { usage?: Usage };
}

export function parseGeneration(stdout: string): { subject: string; cost?: number } {
  let subject = "";
  let cost = 0;
  let hasCost = false;
  let missingCost = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Event;
    try {
      event = JSON.parse(line);
      if (!event || typeof event.type !== "string") throw new Error();
    } catch {
      throw new CommandError("pi returned an invalid JSON response.");
    }
    let usage: Usage | undefined;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        subject = "";
      } else {
        subject = firstSubject(
          message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
        );
      }
      usage = message.usage;
    } else if (event.type === "compaction_end" && event.result) {
      usage = event.result.usage;
    } else {
      continue;
    }
    const total = usage?.cost?.total;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
      cost += total;
      hasCost = true;
    } else {
      missingCost = true;
    }
  }
  if (!subject) throw new CommandError("pi returned an empty commit message.");
  return { subject, cost: hasCost && !missingCost ? cost : undefined };
}
