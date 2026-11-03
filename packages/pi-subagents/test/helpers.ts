import type { Connection, LaunchOptions, RecordValue } from "../src/rpc.ts";

import { AgentManager, type AgentResult, type SpawnOptions } from "../src/agents.ts";

export class FakeConnection implements Connection {
  options: LaunchOptions;
  commands: RecordValue[] = [];
  replies: RecordValue[] = [];
  stopped = false;
  handler?: (command: RecordValue) => Promise<RecordValue>;

  constructor(options: LaunchOptions) {
    this.options = options;
  }
  async request(command: RecordValue, signal?: AbortSignal): Promise<RecordValue> {
    signal?.throwIfAborted();
    this.commands.push(command);
    if (this.handler) return this.handler(command);
    if (command.type === "abort") this.emit({ type: "agent_settled" });
    return { disposition: "started" };
  }
  reply(response: RecordValue) {
    this.replies.push(response);
  }
  async stop() {
    this.stopped = true;
  }
  emit(event: RecordValue) {
    this.options.onEvent(event);
  }
  complete(output = "done", stopReason = "stop", errorMessage?: string) {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: output }],
        stopReason,
        errorMessage,
      },
    });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled" });
  }
}

export function harness() {
  const connections: FakeConnection[] = [];
  const completions: AgentResult[] = [];
  const manager = new AgentManager(
    {
      onChange() {},
      onComplete: (result) => {
        completions.push(result);
      },
      onUI: async () => ({ cancelled: true }),
    },
    (options) => {
      const connection = new FakeConnection(options);
      connections.push(connection);
      return connection;
    },
  );
  const spawn = (options: Partial<SpawnOptions> = {}) =>
    manager.spawn({
      task_name: "test",
      message: "work",
      cwd: process.cwd(),
      args: [],
      ...options,
    });
  return { manager, connections, completions, spawn };
}
