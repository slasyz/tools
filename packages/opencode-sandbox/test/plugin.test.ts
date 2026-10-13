import type { Context } from "@opencode/plugin/promise/plugin";
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";

import { DEFAULT_CONFIG, type SandboxConfig } from "sandbox";
import { beforeEach, expect, test, vi } from "vitest";

import { setupSandbox } from "../src/plugin.ts";
import { WORKER_ENV } from "../src/shell.ts";

const mocks = vi.hoisted(() => ({ config: undefined as unknown, save: vi.fn() }));
vi.mock("sandbox", async (original) => ({
  ...(await original<typeof import("sandbox")>()),
  loadConfig: () => mocks.config,
  addDomainToConfig: mocks.save,
  addReadPathToConfig: mocks.save,
  addWritePathToConfig: mocks.save,
}));
vi.mock("../src/shell.ts", async (original) => ({
  ...(await original<typeof import("../src/shell.ts")>()),
  createWorkerExecutables: () => ({
    protectedRoot: "/workers",
    forShell: () => "/workers/opencode-sandbox-fixture/bash",
    close: () => {},
  }),
}));
beforeEach(() => {
  mocks.config = structuredClone(DEFAULT_CONFIG);
  mocks.save.mockClear();
});

type Handler = (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
type ContextEvent = { sessionID: string; system: Array<{ type: "text"; text: string }> };
async function fixture() {
  const tools = new Map<string, Info & { id: string }>();
  let shellHook: (event: ShellCreateBefore) => Promise<void>;
  let contextHook: (event: ContextEvent) => void;
  const runFile = vi.fn(async () => ({ content: "file executed" }));
  const base: Info = { name: "read", input: {}, description: "base", execute: runFile };
  for (const name of ["read", "write", "edit", "patch", "grep", "glob"])
    tools.set(name, { ...base, name, id: name });
  tools.set("shell", {
    ...base,
    name: "shell",
    id: "shell",
    execute: async (input) => {
      const event: ShellCreateBefore = {
        command: (input as { command: string }).command,
        cwd: "/project",
        timeout: 100,
        shell: "/bin/bash",
        env: {},
      };
      await shellHook(event);
      return { output: event };
    },
  });
  let handlers: Record<string, Handler>;
  const ctx = {
    location: { directory: "/project" },
    rpc: {
      register: async (_definition: unknown, value: Record<string, Handler>) => {
        handlers = value;
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) =>
        callback({
          get: (id: string) => tools.get(id),
          update: (id: string, change: (tool: Info) => void) => {
            const tool = tools.get(id);
            if (tool) change(tool);
          },
          add: (tool: Info) => tools.set(tool.name, { ...tool, id: tool.name }),
        }),
    },
    permission: { hook: async () => {} },
    shell: {
      hook: async (_name: string, hook: typeof shellHook) => {
        shellHook = hook;
      },
    },
    session: {
      hook: async (_name: string, hook: typeof contextHook) => {
        contextHook = hook;
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: sessionID === "foreign" ? "/elsewhere" : "/project" },
      }),
    },
  } as unknown as Context;
  const cleanup = await setupSandbox(ctx);
  const call = (method: string, input: unknown) =>
    handlers[method](input, {
      signal: new AbortController().signal,
      error: (_type: string, message: string) => {
        throw new Error(message);
      },
    } as Parameters<Handler>[1]);
  const context = (sessionID = "a") =>
    ({ sessionID, signal: new AbortController().signal }) as ToolContext;
  const poll = async (sessionID = "a") =>
    (await call("poll", { sessionID, clientID: sessionID })) as Array<{
      id: string;
      target: string;
    }>;
  async function approve(sessionID = "a", action = "session", confirmed = false, value?: string) {
    const [request] = await poll(sessionID);
    expect(request).toBeDefined();
    expect(await call("claim", { id: request.id, clientID: sessionID })).toBe(true);
    await call("reply", {
      id: request.id,
      clientID: sessionID,
      action,
      confirmed,
      value: value ?? request.target,
    });
  }
  return {
    tools,
    runFile,
    call,
    context,
    poll,
    approve,
    cleanup,
    instructions: (sessionID = "a") => {
      const event: ContextEvent = { sessionID, system: [] };
      contextHook(event);
      return event.system.map((block) => block.text).join("\n");
    },
    unassociated: (event: ShellCreateBefore) => shellHook(event),
  };
}

test("file tools permit allowed paths and hard-deny writes without prompts", async () => {
  const f = await fixture();
  await f.tools.get("read")!.execute({ path: "file" }, f.context());
  expect(f.runFile).toHaveBeenCalledTimes(1);
  await expect(f.tools.get("write")!.execute({ path: ".env" }, f.context())).rejects.toThrow(
    "denyWrite",
  );
  await expect(
    f.tools.get("read")!.execute({ path: "/outside/secret" }, f.context()),
  ).rejects.toThrow("denied");
  expect(f.runFile).toHaveBeenCalledTimes(1);
  f.cleanup();
});

test("a session grant never leaks into another session", async () => {
  const f = await fixture();
  await f.poll();
  const read = f.tools.get("read")!;
  const pending = read.execute({ path: "/outside/file" }, f.context());
  await f.approve();
  await pending;
  await read.execute({ path: "/outside/file" }, f.context());
  await expect(read.execute({ path: "/outside/file" }, f.context("b"))).rejects.toThrow("denied");
  expect(f.runFile).toHaveBeenCalledTimes(2);
  f.cleanup();
});

test("global grants require confirmation and reject nonmatching edited rules", async () => {
  const f = await fixture();
  await f.poll();
  const read = f.tools.get("read")!;
  const unconfirmed = read.execute({ path: "/outside/file" }, f.context());
  await f.approve("a", "global");
  await expect(unconfirmed).rejects.toThrow("confirmation");
  const invalid = read.execute({ path: "/outside/file" }, f.context());
  await f.approve("a", "global", true, "/unrelated");
  await expect(invalid).rejects.toThrow("must match");
  expect(mocks.save).not.toHaveBeenCalled();
  const valid = read.execute({ path: "/outside/file" }, f.context());
  await f.approve("a", "global", true, "/outside");
  await valid;
  expect(mocks.save).toHaveBeenCalledWith(expect.stringContaining("sandbox.json"), "/outside");
  f.cleanup();
});

test("patch rename is blocked before the original executor reads any source", async () => {
  const f = await fixture();
  await expect(
    f.tools
      .get("patch")!
      .execute({ patchText: "*** Update File: source\n*** Move to: /outside/dest" }, f.context()),
  ).rejects.toThrow("denied");
  expect(f.runFile).not.toHaveBeenCalled();
  f.cleanup();
});

test("shell uses isolated policy snapshots and original commands", async () => {
  const f = await fixture();
  const shell = f.tools.get("shell")!;
  const result = await shell.execute({ command: "echo hi" }, f.context());
  const event = result.output as ShellCreateBefore;
  expect(event.command).toBe("echo hi");
  expect(event.shell).toMatch(/opencode-sandbox-.*\/bash$/);
  expect(JSON.parse(event.env[WORKER_ENV]! as string).config.filesystem.allowWrite).toContain(
    "/project",
  );
  await expect(
    shell.execute({ command: "curl https://blocked.example.org" }, f.context()),
  ).rejects.toThrow("denied");
  f.cleanup();
});

test("unsandboxed description includes tool-specific approval and retry guidance", async () => {
  const f = await fixture();
  const description = f.tools.get("bash_unsandboxed")!.description;
  expect(description).toContain("Use shell by default");
  expect(description).toContain("user explicitly requests unsandboxed execution");
  expect(description).toContain("same command without first asking in chat");
  expect(description).toContain("this tool requests explicit user approval");
  expect(description).toContain("partial changes");
  expect(description).toContain("unrelated commands or ordinary command errors");
  expect(description).toContain("without a trial shell call");
  expect(f.instructions()).toContain("check for partial changes");
  expect(f.instructions()).toContain("approval for every invocation");
  expect(f.instructions()).not.toContain("Never rerun a failed shell command automatically");
  f.cleanup();
});

test("unsandboxed tool requires fresh approval even when disabled", async () => {
  const f = await fixture();
  const tool = f.tools.get("bash_unsandboxed")!;
  await expect(tool.execute({ command: "echo hi" }, f.context())).rejects.toThrow("denied");
  await f.poll();
  const pending = tool.execute({ command: "echo hi" }, f.context());
  await f.approve("a", "session", true);
  const event = (await pending).output as ShellCreateBefore;
  expect(event.shell).toBe("/bin/bash");
  expect(event.env[WORKER_ENV]).toBeUndefined();
  // The next invocation does not reuse the approval.
  const next = tool.execute({ command: "echo hi" }, f.context());
  await f.approve("a", "abort");
  await expect(next).rejects.toThrow("denied");
  f.cleanup();
});

test("disable is confirmed, session-scoped, and does not affect unassociated shells", async () => {
  const f = await fixture();
  await f.poll();
  const pending = f.call("control", { sessionID: "a", command: "disable", arguments: "" });
  // checkSession awaits before publishing its prompt.
  await Promise.resolve();
  await f.approve("a", "session", true);
  await pending;
  const shell = f.tools.get("shell")!;
  expect(
    ((await shell.execute({ command: "echo hi" }, f.context())).output as ShellCreateBefore).shell,
  ).toBe("/bin/bash");
  expect(
    ((await shell.execute({ command: "echo hi" }, f.context("b"))).output as ShellCreateBefore)
      .shell,
  ).toMatch(/\/bash$/);
  const event: ShellCreateBefore = {
    command: "echo hi",
    cwd: "/project",
    shell: "/bin/bash",
    timeout: 0,
    env: { OPENCODE_SESSION_ID: "a" },
  };
  await f.unassociated(event);
  expect(event.shell).toMatch(/\/bash$/);
  await expect(f.call("status", { sessionID: "foreign" })).rejects.toThrow("another Location");
  f.cleanup();
});

test("explicit config disabling and empty arrays are honored", async () => {
  const current = mocks.config as SandboxConfig;
  current.enabled = false;
  const f = await fixture();
  await f.tools.get("read")!.execute({ path: "/outside/file" }, f.context());
  const event = (await f.tools.get("shell")!.execute({ command: "echo hi" }, f.context()))
    .output as ShellCreateBefore;
  expect(event.shell).toBe("/bin/bash");
  await f.call("control", { sessionID: "a", command: "enable", arguments: "" });
  current.filesystem.allowRead = [];
  current.filesystem.allowWrite = [];
  await expect(f.tools.get("read")!.execute({ path: "file" }, f.context())).rejects.toThrow(
    "denied",
  );
  f.cleanup();
});
