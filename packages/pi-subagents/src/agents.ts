import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { preview } from "./output.ts";
import { RpcConnection, type Connection, type LaunchOptions, type RecordValue } from "./rpc.ts";

export type Status = "starting" | "running" | "idle" | "interrupted" | "failed";
export interface AgentResult {
  id: string;
  task_name: string;
  run: number;
  status: Status;
  output: string;
  output_file?: string;
  error?: string;
}
export interface AgentView {
  id: string;
  task_name: string;
  status: Status;
  run: number;
  session_file?: string;
  result?: AgentResult;
}
interface Agent extends AgentView {
  connection?: Connection;
  chain: Promise<unknown>;
  lastText: string;
  lastStop?: string;
  lastError?: string;
  notifiedRun: number;
  dead: boolean;
  interruptRequested: boolean;
  dialogs: AbortController;
}
export interface SpawnOptions {
  task_name: string;
  message: string;
  cwd: string;
  args: string[];
  snapshot?: string;
  signal?: AbortSignal;
}
interface Callbacks {
  onChange: () => void;
  onComplete: (result: AgentResult) => void;
  onUI: (
    agent: AgentView,
    request: RecordValue,
    signal: AbortSignal,
  ) => Promise<RecordValue | undefined>;
}

const busy = (agent: AgentView) => agent.status === "starting" || agent.status === "running";

export class AgentManager {
  private agents = new Map<string, Agent>();
  // Keep the latest uncollected completion per agent; full per-run output stays on disk.
  private completed = new Map<string, AgentResult>();
  private waiters = new Set<() => void>();
  private writes = new Set<Promise<void>>();
  private directory?: Promise<string>;
  private closed = false;
  private disposed?: Promise<void>;
  private callbacks: Callbacks;
  private launch: (options: LaunchOptions) => Connection;

  constructor(
    callbacks: Callbacks,
    launch = (options: LaunchOptions): Connection => new RpcConnection(options),
  ) {
    this.callbacks = callbacks;
    this.launch = launch;
  }

  list(): AgentView[] {
    return [...this.agents.values()].map((agent) => ({
      ...this.view(agent),
      result: agent.result
        ? { ...agent.result, output: preview(agent.result.output, 800, 10) }
        : undefined,
    }));
  }

  async spawn(options: SpawnOptions): Promise<AgentView> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    if (!options.task_name.trim() || !options.message.trim())
      throw new Error("Task name and message must not be blank");
    if (this.agents.size >= 32)
      throw new Error("This session already has 32 agents; start a new parent session for more");
    this.reserveSlot();
    const agent: Agent = {
      id: `agent-${this.agents.size + 1}`,
      task_name: options.task_name,
      status: "starting",
      run: 1,
      chain: Promise.resolve(),
      lastText: "",
      notifiedRun: 0,
      dead: false,
      interruptRequested: false,
      dialogs: new AbortController(),
    };
    this.agents.set(agent.id, agent);
    this.callbacks.onChange();
    const started = this.start(agent, options);
    agent.chain = started.catch(() => {});
    await started;
    return this.view(agent);
  }

  private async start(agent: Agent, options: SpawnOptions): Promise<void> {
    try {
      const directory = await (this.directory ??= mkdtemp("/tmp/pi-subagents-"));
      this.assertOpen();
      options.signal?.throwIfAborted();
      agent.session_file = join(directory, `${agent.id}.jsonl`);
      await writeFile(
        agent.session_file,
        options.snapshot ??
          JSON.stringify({
            type: "session",
            version: 3,
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            cwd: options.cwd,
          }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      this.assertOpen();
      options.signal?.throwIfAborted();
      agent.connection = this.launch({
        cwd: options.cwd,
        args: [...options.args, "--session", agent.session_file],
        onEvent: (event) => this.event(agent, event),
        onFailure: (error) => this.fail(agent, error),
      });
      await agent.connection.request({ type: "get_state" }, options.signal);
      agent.status = "running";
      this.callbacks.onChange();
      const reply = await agent.connection.request(
        { type: "prompt", message: options.message },
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (reply.disposition === "handled")
        this.settle(agent, "idle", "Prompt handled by an extension; no agent run started.");
    } catch (error) {
      await this.abandon(agent, error);
    }
  }

  async send(
    target: string,
    message: string,
    followUp: boolean,
    signal?: AbortSignal,
  ): Promise<AgentView> {
    if (!message.trim()) throw new Error("Message must not be blank");
    const agent = this.get(target);
    return this.enqueue(agent, async () => {
      signal?.throwIfAborted();
      this.assertOpen();
      if (agent.dead) throw new Error("Agent process exited; spawn a new agent");
      const wasBusy = busy(agent);
      if (!wasBusy) {
        this.reserveSlot();
        this.beginRun(agent);
      }
      try {
        // prompt handles the idle/running race atomically in the child.
        const reply = await agent.connection!.request(
          {
            type: "prompt",
            message,
            streamingBehavior: followUp ? "followUp" : "steer",
          },
          signal,
        );
        if (!wasBusy && reply.disposition === "handled")
          this.settle(agent, "idle", "Prompt handled by an extension; no agent run started.");
      } catch (error) {
        // Delivery is uncertain after timeout/cancellation. Stop rather than leave untracked work.
        await this.abandon(agent, error);
      }
      return this.view(agent);
    });
  }

  async interrupt(target: string, signal?: AbortSignal): Promise<AgentView> {
    const agent = this.get(target);
    return this.enqueue(agent, async () => {
      signal?.throwIfAborted();
      if (!busy(agent) || agent.dead) return this.view(agent);
      agent.interruptRequested = true;
      agent.dialogs.abort();
      try {
        await agent.connection!.request({ type: "clear_queue" }, signal);
        await agent.connection!.request({ type: "abort" }, signal);
        this.settle(agent, "interrupted");
      } catch (error) {
        await this.abandon(agent, error);
      }
      return this.view(agent);
    });
  }

  private event(agent: Agent, event: RecordValue): void {
    if (this.closed || agent.dead) return;
    if (event.type === "extension_ui_request") {
      const signal = agent.dialogs.signal;
      void this.callbacks
        .onUI(this.view(agent), event, signal)
        .then((response) => {
          if (response && !agent.dead && !this.closed)
            agent.connection?.reply({
              ...response,
              type: "extension_ui_response",
              id: event.id,
            });
        })
        .catch(() => {
          try {
            agent.connection?.reply({
              type: "extension_ui_response",
              id: event.id,
              cancelled: true,
            });
          } catch {
            /* The process has stopped. */
          }
        });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      agent.lastText = (message.content ?? [])
        .filter((part: RecordValue) => part.type === "text")
        .map((part: RecordValue) => part.text)
        .join("\n");
      agent.lastStop = message.stopReason;
      agent.lastError = message.errorMessage;
    } else if (event.type === "agent_start" && !busy(agent)) {
      // An extension can start work independently of an RPC prompt.
      this.beginRun(agent);
    } else if (event.type === "agent_settled") {
      const status =
        agent.interruptRequested || agent.lastStop === "aborted"
          ? "interrupted"
          : agent.lastStop === "error" || agent.lastStop === "length"
            ? "failed"
            : "idle";
      this.settle(agent, status);
    }
  }

  private beginRun(agent: Agent): void {
    agent.run++;
    agent.status = "running";
    agent.lastText = "";
    agent.lastStop = undefined;
    agent.lastError = undefined;
    agent.interruptRequested = false;
    agent.dialogs = new AbortController();
    this.callbacks.onChange();
  }

  /** Mark the agent failed, stop its process, and rethrow the original error. */
  private async abandon(agent: Agent, error: unknown): Promise<never> {
    this.fail(agent, asError(error));
    await agent.connection?.stop();
    throw error;
  }

  private fail(agent: Agent, error: Error): void {
    if (this.closed || agent.dead) return;
    agent.dead = true;
    agent.dialogs.abort();
    if (agent.notifiedRun === agent.run) agent.run++;
    this.settle(agent, "failed", undefined, error.message);
  }

  private settle(
    agent: Agent,
    status: Status,
    output = agent.lastText,
    error = agent.lastError,
  ): void {
    if (this.closed || agent.notifiedRun === agent.run) return;
    agent.notifiedRun = agent.run;
    agent.status = status;
    const result: AgentResult = {
      id: agent.id,
      task_name: agent.task_name,
      run: agent.run,
      status,
      output: preview(output),
      error: error ? preview(error, 2000, 10) : undefined,
    };
    this.callbacks.onChange();
    const write = (async () => {
      try {
        if (this.directory) {
          result.output_file = join(await this.directory, `${agent.id}-${result.run}.txt`);
          await writeFile(result.output_file, error ? `${error}\n\n${output}` : output, {
            mode: 0o600,
            flag: "wx",
          });
        }
      } catch (error) {
        result.output_file = undefined;
        result.error = `Could not save full result: ${asError(error).message}`;
      }
      if (this.closed) return;
      if (!agent.result || agent.result.run <= result.run) agent.result = result;
      if ((this.completed.get(agent.id)?.run ?? 0) <= result.run)
        this.completed.set(agent.id, result);
      this.callbacks.onChange();
      this.callbacks.onComplete(result);
      for (const wake of this.waiters) wake();
    })();
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write)).catch(() => {});
  }

  async wait(
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<{ result?: AgentResult; reason?: string }> {
    this.assertOpen();
    signal?.throwIfAborted();
    const take = () => {
      const result = this.completed.values().next().value;
      if (result) this.completed.delete(result.id);
      return result;
    };
    const result = take();
    if (result) return { result };
    if (![...this.agents.values()].some(busy) && !this.writes.size)
      return { reason: "No agents are running" };
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        const result = take();
        if (!result && !this.closed) return;
        cleanup();
        resolve(result ? { result } : { reason: "Session closed" });
      };
      const abort = () => {
        cleanup();
        reject(new Error("Wait cancelled; agents continue running"));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ reason: "Timed out; agents continue running" });
      }, timeoutMs);
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.disposed;
    this.closed = true;
    for (const wake of this.waiters) wake();
    for (const agent of this.agents.values()) agent.dialogs.abort();
    this.disposed = (async () => {
      await Promise.allSettled(
        [...this.agents.values()].map(async (agent) => {
          await agent.connection?.stop();
          await agent.chain;
        }),
      );
      await Promise.allSettled(this.writes);
      if (this.directory) await rm(await this.directory, { recursive: true, force: true });
    })();
    return this.disposed;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Subagent session is closed");
  }
  private reserveSlot(): void {
    this.assertOpen();
    if ([...this.agents.values()].filter(busy).length >= 4)
      throw new Error("Four agents are already working; wait or interrupt one first");
  }
  private get(target: string): Agent {
    this.assertOpen();
    const agent = this.agents.get(target);
    if (!agent) throw new Error(`Unknown agent ID: ${target}. Use list_agents to find IDs.`);
    return agent;
  }
  private view(agent: Agent): AgentView {
    return {
      id: agent.id,
      task_name: agent.task_name,
      status: agent.status,
      run: agent.run,
      session_file: agent.session_file,
    };
  }
  private enqueue<T>(agent: Agent, operation: () => Promise<T>): Promise<T> {
    const next = agent.chain.then(operation);
    agent.chain = next.catch(() => {});
    return next;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
