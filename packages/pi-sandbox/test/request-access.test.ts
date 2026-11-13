import { execFileSync } from "node:child_process";
import { realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "sandbox";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import registerSandbox from "../src/extension.ts";
import { promptSessionAccess } from "../src/request-access.ts";

const mocks = vi.hoisted(() => ({
  config: undefined as unknown,
  initialize: vi.fn(),
  refresh: vi.fn(),
  reset: vi.fn(),
  save: vi.fn(),
}));
vi.mock("sandbox", async (original) => ({
  ...(await original<typeof import("sandbox")>()),
  loadConfig: () => mocks.config,
  initializeSandbox: mocks.initialize,
  reinitializeSandbox: mocks.refresh,
  resetSandbox: mocks.reset,
  addDomainToConfig: mocks.save,
  addReadPathToConfig: mocks.save,
  addWritePathToConfig: mocks.save,
}));
beforeEach(() => {
  mocks.config = structuredClone(DEFAULT_CONFIG);
  mocks.initialize.mockReset();
  mocks.refresh.mockReset();
  mocks.reset.mockReset();
  mocks.save.mockReset();
});
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
type Handler = (event: any, ctx: ExtensionContext) => Promise<any>;
async function fixture() {
  const cwd = realpathSync(
    execFileSync("mktemp", ["-d", "-p", "/tmp", "pi-access.XXXXXX"], { encoding: "utf8" }).trim(),
  );
  dirs.push(cwd);
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const pi = {
    events: createEventBus(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    registerFlag() {},
    getFlag: () => false,
    on: (name: string, handler: Handler) => hooks.set(name, handler),
  } as unknown as ExtensionAPI;
  const select = vi.fn(
    async (_title: string, _options: string[], _dialogOptions: unknown) => "Allow",
  );
  const notify = vi.fn();
  const ctx = {
    cwd,
    hasUI: true,
    mode: "rpc",
    ui: { select, notify },
  } as unknown as ExtensionContext;
  registerSandbox(pi);
  await hooks.get("session_start")!({}, ctx);
  const execute = (requests: unknown, signal?: AbortSignal) =>
    tools
      .get("sandbox_request_access")!
      .execute("request", { requests }, signal, undefined, ctx as never);
  return {
    cwd,
    pi,
    hooks,
    commands,
    ctx,
    select,
    notify,
    execute,
    tool: tools.get("sandbox_request_access")!,
  };
}

test("one RPC prompt grants a mixed batch only for the current runtime", async () => {
  const f = await fixture();
  const requests = [
    { path: "input", access: "read" },
    { path: "output", access: "write" },
  ];
  const result = await f.execute(requests);
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("2 path(s)") });
  expect(f.select).toHaveBeenCalledExactlyOnceWith(
    `Allow filesystem access for this session?\n\n  read  ${f.cwd}/input\n  write ${f.cwd}/output`,
    ["Allow", "Deny"],
    { signal: undefined, timeout: 300_000 },
  );
  expect(mocks.refresh).toHaveBeenCalledWith(expect.anything(), {
    domains: [],
    readPaths: [join(f.cwd, "input")],
    writePaths: [join(f.cwd, "output")],
  });
  expect(mocks.save).not.toHaveBeenCalled();
  f.select.mockClear();
  await f.hooks.get("tool_call")!(
    { toolName: "read", input: { path: join(f.cwd, "output") } },
    f.ctx,
  );
  expect(f.select).not.toHaveBeenCalled();
  await f.hooks.get("session_shutdown")!({}, f.ctx);
  const next = await fixture();
  await next.commands.get("sandbox")!.handler("", next.ctx);
  expect(next.notify.mock.calls.at(-1)?.[0]).not.toContain(f.cwd);
});

test("RPC batch prompt shortens home aliases and targets without changing them", async () => {
  const f = await fixture();
  const requests = [
    { path: join(homedir(), "alias"), target: join(homedir(), "target"), access: "read" as const },
  ];
  const before = structuredClone(requests);
  expect(await promptSessionAccess(f.pi, f.ctx, requests)).toBe(true);
  expect(f.select.mock.calls[0]?.[0]).toContain("~/alias → ~/target");
  expect(requests).toEqual(before);
});

test.each(["Deny", undefined, "Allow for all projects"])(
  "%s never grants any path",
  async (choice) => {
    const f = await fixture();
    f.select.mockResolvedValue(choice as string);
    await expect(
      f.execute([
        { path: "one", access: "read" },
        { path: "two", access: "write" },
      ]),
    ).rejects.toThrow("no access granted");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  },
);

test("missing UI and cancellation cannot grant access", async () => {
  const f = await fixture();
  Object.assign(f.ctx, { hasUI: false });
  await expect(f.execute([{ path: "file", access: "read" }])).rejects.toThrow("denied");
  expect(f.select).not.toHaveBeenCalled();
  Object.assign(f.ctx, { hasUI: true });
  const controller = new AbortController();
  f.select.mockImplementation(async () => {
    controller.abort();
    return "Allow";
  });
  await expect(f.execute([{ path: "file", access: "read" }], controller.signal)).rejects.toThrow(
    "denied",
  );
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test("hard deny in a batch blocks every grant before prompting", async () => {
  const f = await fixture();
  await expect(
    f.execute([
      { path: "safe", access: "read" },
      { path: ".env", access: "write" },
    ]),
  ).rejects.toThrow("denyWrite");
  expect(f.select).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test("symlink prompts display both paths and recheck the target after approval", async () => {
  const f = await fixture();
  writeFileSync(join(f.cwd, "target"), "");
  writeFileSync(join(f.cwd, "other"), "");
  symlinkSync("target", join(f.cwd, "alias"));
  await f.execute([{ path: "alias", access: "read" }]);
  expect(f.select.mock.calls[0][0]).toContain(`${f.cwd}/alias → ${f.cwd}/target`);
  expect(mocks.refresh.mock.calls[0][1].readPaths).toEqual([join(f.cwd, "target")]);
  mocks.refresh.mockClear();
  f.select.mockImplementation(async () => {
    unlinkSync(join(f.cwd, "alias"));
    symlinkSync("other", join(f.cwd, "alias"));
    return "Allow";
  });
  await expect(f.execute([{ path: "alias", access: "read" }])).rejects.toThrow("target changed");
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test("refresh failure rolls back allowances and leaves commands blocked", async () => {
  const f = await fixture();
  mocks.refresh.mockRejectedValueOnce(new Error("runtime failed"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(f.execute([{ path: "file", access: "write" }])).rejects.toThrow("remain blocked");
    await f.commands.get("sandbox")!.handler("", f.ctx);
    expect(f.notify.mock.calls.at(-1)?.[0]).not.toContain("Session write:");
    await expect(f.execute([{ path: "another", access: "read" }])).rejects.toThrow("unavailable");
  } finally {
    error.mockRestore();
  }
});

test("tool instructions explain batch approval and safe retries", async () => {
  const f = await fixture();
  for (const text of [
    "entire batch",
    "narrowest paths",
    "separately in chat",
    "partial changes",
    "Hard write-deny",
    "do not retry",
  ]) {
    expect(f.tool.description).toContain(text);
  }
});

test("cancellation during runtime refresh rolls back session access", async () => {
  const f = await fixture();
  const controller = new AbortController();
  mocks.refresh.mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(f.execute([{ path: "file", access: "write" }], controller.signal)).rejects.toThrow(
    "cancelled",
  );
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(mocks.refresh.mock.calls[1][1]).toEqual({ domains: [], readPaths: [], writePaths: [] });
  await f.commands.get("sandbox")!.handler("", f.ctx);
  expect(f.notify.mock.calls.at(-1)?.[0]).not.toContain("Session write:");
});

test("TUI styles access and paths, wraps rather than truncates, and uses Allow/Deny", async () => {
  const f = await fixture();
  const request = {
    path: "/a/long/requested/config",
    target: "/a/long/target/config",
    access: "read" as const,
  };
  let lines: string[] = [];
  Object.assign(f.ctx, { mode: "tui" });
  Object.assign(f.ctx.ui, {
    custom: async (factory: Function) =>
      new Promise((done) => {
        const component = factory(
          { terminal: { write() {} }, requestRender() {} },
          {
            bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
            fg: (_color: string, value: string) => `\x1b[36m${value}\x1b[39m`,
          },
          {
            matches: (data: string, name: string) =>
              data === "enter" && name === "tui.select.confirm",
          },
          done,
        );
        lines = component.render(200);
        expect(lines[0]).toContain("📖 Allow \x1b[1mread");
        expect(lines[2]).toContain(`\x1b[36m${request.path}`);
        const narrowLines = component.render(18);
        expect(narrowLines.every((line: string) => visibleWidth(line) <= 18)).toBe(true);
        const narrow = narrowLines.map(stripVTControlCharacters).join("");
        expect(narrow).toContain(request.path);
        expect(narrow).toContain(request.target);
        component.handleInput("enter");
      }),
  });
  expect(await promptSessionAccess(f.pi, f.ctx, [request])).toBe(true);
  const plain = lines.map(stripVTControlCharacters).join("\n");
  expect(plain).toContain(" → ✅ Allow\n   ❌ Deny");
  expect(plain).toContain("↑↓ navigate • enter select • esc deny");
});

test("TUI batch displays both access types and denies the whole batch", async () => {
  const f = await fixture();
  Object.assign(f.ctx, { mode: "tui" });
  Object.assign(f.ctx.ui, {
    custom: async (factory: Function) =>
      new Promise((done) => {
        const component = factory(
          { terminal: { write() {} }, requestRender() {} },
          { bold: (value: string) => value, fg: (_color: string, value: string) => value },
          getKeybindings(),
          done,
        );
        const plain = component.render(200).join("\n");
        expect(plain).toContain("📁 Allow filesystem access for this session?");
        expect(plain).toContain("read  /input");
        expect(plain).toContain("write /output");
        component.handleInput("\x1b[B");
        expect(component.render(200).join("\n")).toContain(" → ❌ Deny");
        component.handleInput("\r");
      }),
  });
  expect(
    await promptSessionAccess(f.pi, f.ctx, [
      { path: "/input", target: "/input", access: "read" },
      { path: "/output", target: "/output", access: "write" },
    ]),
  ).toBe(false);
});

test("TUI timeout denies without user input", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  Object.assign(f.ctx, { mode: "tui" });
  Object.assign(f.ctx.ui, {
    custom: async (factory: Function) =>
      new Promise((done) => {
        factory({ terminal: { write() {} } }, {}, {}, done);
      }),
  });
  const pending = promptSessionAccess(f.pi, f.ctx, [
    { path: "/file", target: "/file", access: "read" },
  ]);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await pending).toBe(false);
});
