import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

const maxRecordBytes = 16 * 1024 * 1024;

export type RecordValue = Record<string, any>;

export interface Connection {
  request(command: RecordValue, signal?: AbortSignal): Promise<RecordValue>;
  reply(response: RecordValue): void;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  cwd: string;
  args: string[];
  onEvent: (event: RecordValue) => void;
  onFailure: (error: Error) => void;
}

export function piInvocation(args: string[], argv = process.argv, executable = process.execPath) {
  const script = argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return { command: executable, args: [script, ...args] };
  }
  return /^(node|bun)(\.exe)?$/i.test(basename(executable))
    ? { command: "pi", args }
    : { command: executable, args };
}

/** Keep CLI-only resource choices, including permission extensions passed with -e. */
export function resourceArgs(argv = process.argv.slice(2)): string[] {
  const values = new Set([
    "-e",
    "--extension",
    "--skill",
    "--prompt-template",
    "--system-prompt",
    "--append-system-prompt",
    "-xt",
    "--exclude-tools",
  ]);
  const flags = new Set([
    "-ne",
    "--no-extensions",
    "-ns",
    "--no-skills",
    "-np",
    "--no-prompt-templates",
    "-nc",
    "--no-context-files",
    "--no-mcp",
    "--offline",
    "-nbt",
    "--no-builtin-tools",
  ]);
  const result: string[] = [];
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    const arg = argv[i];
    const [key] = arg.split("=", 1);
    if (flags.has(arg)) result.push(arg);
    else if (values.has(key)) {
      if (arg.includes("=")) result.push(arg);
      else if (argv[i + 1] !== undefined) result.push(arg, argv[++i]);
    }
  }
  return result;
}

/** A small RPC transport with exit observation, deadlines, and dialog forwarding. */
export class RpcConnection implements Connection {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: (value: RecordValue) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private failure?: Error;
  private stopped?: Promise<void>;
  private deadlineMs: number;
  private closed: Promise<void>;
  private stderr = "";

  constructor(
    options: LaunchOptions,
    invocation = piInvocation(["--mode", "rpc", ...options.args]),
    deadlineMs = 30_000,
  ) {
    this.deadlineMs = deadlineMs;
    this.child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: { ...process.env, PI_SUBAGENTS_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const fail = (error: Error) => {
      if (this.failure || this.stopped) return;
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      options.onFailure(error);
      void this.stop();
    };
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.stdout.on("error", fail);
    this.child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString("utf8")).slice(-8192);
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        fail(
          new Error(
            `Pi exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr}` : ""}`,
          ),
        );
        resolve();
      });
    });

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (data: Buffer) => {
      buffer += decoder.write(data);
      // LF only: U+2028 and U+2029 are valid inside JSON strings.
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > maxRecordBytes) {
          fail(new Error("Pi RPC record exceeded 16 MiB"));
          return;
        }
        try {
          const event = JSON.parse(line) as RecordValue;
          if (event.type === "response") {
            const pending = this.pending.get(event.id);
            if (!pending) continue;
            this.pending.delete(event.id);
            if (event.success) pending.resolve(event.data ?? {});
            else pending.reject(new Error(event.error ?? "Pi RPC command failed"));
          } else options.onEvent(event);
        } catch (error) {
          fail(new Error(`Invalid Pi RPC record: ${error}`));
          return;
        }
      }
      // UTF-8 uses at most 3 bytes per UTF-16 unit, so skip the O(n) byte count for short buffers.
      if (buffer.length * 3 > maxRecordBytes && Buffer.byteLength(buffer) > maxRecordBytes)
        fail(new Error("Pi RPC record exceeded 16 MiB"));
    });
  }

  request(command: RecordValue, signal?: AbortSignal): Promise<RecordValue> {
    if (this.failure || this.stopped)
      return Promise.reject(this.failure ?? new Error("Agent stopped"));
    signal?.throwIfAborted();
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const abort = () => {
        cleanup();
        reject(new Error("Operation cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Pi RPC ${command.type} timed out after ${this.deadlineMs} ms`));
      }, this.deadlineMs);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.reply({ ...command, id });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  reply(response: RecordValue): void {
    if (this.failure || this.stopped) throw this.failure ?? new Error("Agent stopped");
    // Bound queued writes when a child stops reading its stdin.
    if (this.child.stdin.writableLength > 1024 * 1024)
      throw new Error("Pi RPC input buffer is full");
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    for (const pending of this.pending.values()) pending.reject(new Error("Agent stopped"));
    this.pending.clear();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    this.stopped = (async () => {
      this.child.stdin.end();
      kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), 1500);
      try {
        await this.closed;
      } finally {
        clearTimeout(timer);
        kill("SIGKILL");
      }
    })();
    return this.stopped;
  }
}
