import { createInterface, emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { formatReviewPrompt } from "./output.ts";
import { CommandError } from "./process.ts";

export type Action = { type: "accept" } | { type: "feedback"; text: string } | { type: "edit" };

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => void };
type Output = Writable & { isTTY?: boolean };

export function askForAction(
  signal?: AbortSignal,
  input: Input = process.stdin,
  output: Output = process.stdout,
): Promise<Action> {
  if (!input.isTTY || !output.isTTY) {
    return Promise.reject(
      new CommandError("an interactive terminal is required to review the message."),
    );
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    const rl = createInterface({ input, output, terminal: true });
    emitKeypressEvents(input, rl);
    let settled = false;

    function finish(action?: Action) {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      input.setRawMode?.(wasRaw);
      input.pause();
      if (action) resolve(action);
      else reject(new CommandError("stopped.", 130));
    }

    function onKeypress(_text: string, key: { ctrl?: boolean; name?: string }) {
      if (key.ctrl && key.name === "g") {
        output.write("\n");
        finish({ type: "edit" });
      }
    }

    function onAbort() {
      output.write("\n");
      finish();
    }

    rl.on("line", (line: string) => {
      finish(line === "" ? { type: "accept" } : { type: "feedback", text: line });
    });
    rl.on("SIGINT", onAbort);
    rl.on("close", () => finish());
    input.on("keypress", onKeypress);
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.setPrompt(formatReviewPrompt());
    rl.prompt();
  });
}
