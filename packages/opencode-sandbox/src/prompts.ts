import { randomUUID } from "node:crypto";

import type { Choice, PromptKind } from "./policy.ts";

export interface PendingPrompt {
  id: string;
  sessionID: string;
  kind: PromptKind;
  target: string;
  title: string;
}
export interface PromptReply {
  action: Choice;
  value: string;
  confirmed: boolean;
}

// A live TUI must be polling this session. Headless requests fail immediately,
// and disconnects, cancellation, unload, and timeout never grant access.
export class Prompts {
  private clients = new Map<string, { sessionID: string; seen: number }>();
  private requests = new Map<
    string,
    {
      prompt: PendingPrompt;
      owner?: string;
      settle: (reply: PromptReply) => void;
    }
  >();

  constructor(private timeout = 5 * 60_000) {}

  poll(sessionID: string, clientID: string): PendingPrompt[] {
    for (const [id, client] of this.clients)
      if (Date.now() - client.seen > 4000) this.clients.delete(id);
    this.clients.set(clientID, { sessionID, seen: Date.now() });
    return [...this.requests.values()]
      .filter(
        (item) => item.prompt.sessionID === sessionID && (!item.owner || item.owner === clientID),
      )
      .map((item) => item.prompt);
  }

  claim(id: string, clientID: string): boolean {
    const request = this.requests.get(id);
    const client = this.clients.get(clientID);
    if (
      !request ||
      !client ||
      client.sessionID !== request.prompt.sessionID ||
      Date.now() - client.seen > 4000 ||
      (request.owner && request.owner !== clientID)
    )
      return false;
    request.owner = clientID;
    return true;
  }

  reply(id: string, clientID: string, reply: PromptReply): void {
    const request = this.requests.get(id);
    if (!request || request.owner !== clientID)
      throw new Error("Sandbox prompt expired or belongs to another client");
    const client = this.clients.get(clientID);
    if (
      !client ||
      client.sessionID !== request.prompt.sessionID ||
      Date.now() - client.seen > 4000
    ) {
      request.settle({ action: "abort", value: request.prompt.target, confirmed: false });
      throw new Error("Sandbox approval client disconnected");
    }
    request.settle(reply);
  }

  async ask(prompt: Omit<PendingPrompt, "id">, signal?: AbortSignal): Promise<PromptReply> {
    const denied: PromptReply = { action: "abort", value: prompt.target, confirmed: false };
    if (
      signal?.aborted ||
      ![...this.clients.values()].some(
        (client) => client.sessionID === prompt.sessionID && Date.now() - client.seen <= 4000,
      )
    )
      return denied;
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (reply: PromptReply) => {
        clearTimeout(timer);
        clearInterval(liveness);
        signal?.removeEventListener("abort", abort);
        this.requests.delete(id);
        resolve(reply);
      };
      const abort = () => settle(denied);
      const timer = setTimeout(abort, this.timeout);
      const liveness = setInterval(() => {
        const owner = this.requests.get(id)?.owner;
        const client = owner ? this.clients.get(owner) : undefined;
        if (
          owner &&
          (!client || client.sessionID !== prompt.sessionID || Date.now() - client.seen > 4000)
        ) {
          abort();
          return;
        }
        if (
          ![...this.clients.values()].some(
            (client) => client.sessionID === prompt.sessionID && Date.now() - client.seen <= 4000,
          )
        )
          abort();
      }, 1000);
      timer.unref?.();
      liveness.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
      this.requests.set(id, { prompt: { ...prompt, id }, settle });
    });
  }

  close(): void {
    for (const request of [...this.requests.values()]) {
      request.settle({ action: "abort", value: request.prompt.target, confirmed: false });
    }
    this.clients.clear();
  }
}
