import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { test } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import piSubagents from "../index.ts";
import { forkSnapshot } from "../src/fork.ts";
import { dialogBridge, renderAgents, widgetLines } from "../src/ui.ts";
import { FakeConnection } from "./helpers.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("registers six tools, inherits current settings, updates widget, and notifies", async () => {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const widgets: any[] = [];
  const messages: any[] = [];
  const connections: FakeConnection[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, handler),
    sendMessage: (...args: any[]) => messages.push(args),
    getActiveTools: () => ["read", "bash", "spawn_agent", "send_message"],
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "custom", id: "current" },
    thinkingLevel: "high",
    hasUI: true,
    isProjectTrusted: () => false,
    ui: { setWidget: (...args: any[]) => widgets.push(args) },
  } as unknown as ExtensionContext;
  piSubagents(pi, (options) => {
    const connection = new FakeConnection(options);
    connections.push(connection);
    return connection;
  });
  try {
    handlers.get("session_start")({}, ctx);
    assert.equal(tools.size, 6);
    const response = await tools
      .get("spawn_agent")
      .execute(
        "spawn-call",
        { task_name: "search", message: "find it" },
        undefined,
        undefined,
        ctx,
      );
    const args = connections[0].options.args;
    assert.equal(args[args.indexOf("--provider") + 1], "custom");
    assert.equal(args[args.indexOf("--model") + 1], "current");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
    assert.ok(args.includes("--no-approve"));
    assert.ok(
      widgets.some(([, factory]) => {
        const widget = factory?.({ requestRender() {} }, plainTheme);
        try {
          return widget?.render(80).some((line: string) => line.includes("running"));
        } finally {
          widget?.dispose();
        }
      }),
    );
    connections[0].complete("found it");
    await tools.get("wait_agent").execute("wait", {}, undefined);
    assert.equal(messages.length, 1);
    assert.equal(messages[0][1].triggerTurn, true);
    assert.equal(messages[0][1].deliverAs, "steer");
    assert.match(messages[0][0].content, /found it/);
    assert.equal(JSON.parse(response.content[0].text).id, "agent-1");
  } finally {
    await handlers.get("session_shutdown")();
  }
  assert.equal(connections[0].stopped, true);
  assert.equal(widgets.at(-1)[1], undefined);
});

test("spawn_agent accepts exact model overrides and rejects invalid IDs before launch", async () => {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const connections: FakeConnection[] = [];
  const current = { provider: "custom", id: "current" };
  const override = { provider: "other", id: "org/alternate" };
  const lookups: string[][] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, handler),
    sendMessage() {},
    getActiveTools: () => ["read", "spawn_agent"],
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    model: current,
    modelRegistry: {
      find: (provider: string, id: string) => {
        lookups.push([provider, id]);
        return provider === override.provider && id === override.id ? override : undefined;
      },
    },
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => [],
      getCwd: () => process.cwd(),
      getSessionFile: () => "/parent.jsonl",
    },
  } as unknown as ExtensionContext;
  piSubagents(pi, (options) => {
    const connection = new FakeConnection(options);
    connections.push(connection);
    return connection;
  });
  const spawn = (params: Record<string, unknown>, context = ctx) =>
    tools
      .get("spawn_agent")
      .execute(
        "spawn-call",
        { task_name: "test", message: "work", ...params },
        undefined,
        undefined,
        context,
      );
  try {
    const schema = tools.get("spawn_agent").parameters;
    assert.equal(schema.properties.model.type, "string");
    assert.ok(!schema.required.includes("model"));
    for (const options of [
      { context: ctx, fork_turns: "none" },
      { context: ctx, fork_turns: "all" },
      { context: { ...ctx, model: undefined }, fork_turns: "none" },
    ]) {
      await spawn(
        { model: "other/org/alternate", fork_turns: options.fork_turns },
        options.context,
      );
      const connection = connections.at(-1)!;
      const args = connection.options.args;
      assert.equal(args[args.indexOf("--provider") + 1], "other");
      assert.equal(args[args.indexOf("--model") + 1], "org/alternate");
      assert.equal(args[args.indexOf("--thinking") + 1], "high");
      assert.equal(args[args.indexOf("--tools") + 1], "read");
      assert.ok(args.includes("--approve"));
      assert.equal(ctx.model, current, "parent model must not change");
      connection.complete();
    }
    assert.deepEqual(
      lookups,
      Array.from({ length: 3 }, () => ["other", "org/alternate"]),
    );
    for (const model of ["", "   ", "alternate", "/alternate", "other/"])
      await assert.rejects(spawn({ model }), /exact provider\/model ID/);
    for (const model of ["other/missing", "unknown/org/alternate", "other/org/alter"])
      await assert.rejects(spawn({ model }), /Unknown model.*pi --list-models/);
    await assert.rejects(spawn({}, { ...ctx, model: undefined }), /No current model/);
    assert.equal(connections.length, 3, "invalid IDs must not launch a child");
  } finally {
    await handlers.get("session_shutdown")();
  }
});

test("child processes do not register subagent tools", () => {
  const previous = process.env.PI_SUBAGENTS_CHILD;
  process.env.PI_SUBAGENTS_CHILD = "1";
  try {
    piSubagents({
      registerTool: () => {
        assert.fail("nested tools registered");
      },
    } as unknown as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_CHILD;
    else process.env.PI_SUBAGENTS_CHILD = previous;
  }
});

test("fork snapshots retain compaction and exclude the incomplete spawning turn", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } },
    {
      type: "compaction",
      id: "c",
      parentId: "u1",
      firstKeptEntryId: "u1",
      summary: "summary",
      tokensBefore: 100,
    },
    { type: "message", id: "u2", parentId: "c", message: { role: "user", content: "delegate" } },
    {
      type: "message",
      id: "a",
      parentId: "u2",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "codemode-call", name: "codemode", arguments: {} }],
      },
    },
    {
      type: "message",
      id: "r",
      parentId: "a",
      message: { role: "toolResult", toolCallId: "sibling", content: [] },
    },
  ];
  const manager = {
    getBranch: () => entries,
    getHeader: () => ({ type: "session", version: 3, id: "parent-id" }),
    getCwd: () => "/workspace",
    getSessionFile: () => "/parent.jsonl",
  } as unknown as ExtensionContext["sessionManager"];
  const snapshot = forkSnapshot(manager, "codemode-call/1")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(snapshot.length, 4);
  assert.notEqual(snapshot[0].id, "parent-id");
  assert.equal(snapshot[0].parentSession, "/parent.jsonl");
  assert.equal(snapshot[2].type, "compaction");
  assert.equal(snapshot.at(-1).id, "u2");
});

test("no-UI permission requests fail closed; widgets sanitize labels", async () => {
  const bridge = dialogBridge(() => ({ hasUI: false }) as ExtensionContext);
  const agent = { id: "agent-1", task_name: "test", status: "running" as const, run: 1 };
  assert.deepEqual(await bridge(agent, { method: "confirm" }, new AbortController().signal), {
    cancelled: true,
  });
  assert.deepEqual(await bridge(agent, { method: "select" }, new AbortController().signal), {
    cancelled: true,
  });
  const lines = widgetLines([{ ...agent, task_name: "bad\x1b[31m\nname" }], plainTheme, 80);
  assert.equal(lines.length, 2);
  assert.ok(!lines[1].includes("\x1b"));
  assert.ok(!lines[1].includes("\n"));
});

test("widget header counts statuses, and every line fits the width", () => {
  const lines = widgetLines(
    [
      { id: "agent-1", task_name: "search", status: "running", run: 1 },
      { id: "agent-2", task_name: "x".repeat(200), status: "failed", run: 1 },
      { id: "agent-10", task_name: "review", status: "idle", run: 1 },
    ],
    plainTheme,
    50,
  );
  assert.match(lines[0], /^── Subagents ─ 1 running · 1 idle · 1 failed ─+$/);
  assert.equal(lines[1], "  ⠋ agent-1   search");
  assert.match(stripTerminalSequences(lines[2]), /^  ✗ agent-2   x+…  failed$/);
  assert.equal(lines[3], "  ✓ agent-10  review");
  for (const line of lines) assert.ok(visibleWidth(line) <= 50, line);
  assert.equal(visibleWidth(lines[0]), 50);
});

test("widget animates running agents and stops its timer when replaced or cleared", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let widget: any;
  let renders = 0;
  const tui = { requestRender: () => renders++ };
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (_key: string, factory: any) => {
        widget?.dispose();
        widget = factory?.(tui, plainTheme);
      },
    },
  } as unknown as ExtensionContext;
  const running = { id: "agent-1", task_name: "work", status: "running" as const, run: 1 };
  const idle = { id: "agent-2", task_name: "done", status: "idle" as const, run: 1 };
  try {
    renderAgents(ctx, [running, idle]);
    const first = widget.render(50);
    assert.equal(first[1], "  ⠋ agent-1  work");
    t.mock.timers.tick(80);
    assert.equal(renders, 1);
    const next = widget.render(50);
    assert.equal(next[1], "  ⠙ agent-1  work");
    assert.equal(next[0], first[0]);
    assert.equal(next[2], first[2]);
    for (let frame = 2; frame <= 10; frame++) {
      t.mock.timers.tick(80);
      for (const line of widget.render(12)) assert.ok(visibleWidth(line) <= 12);
    }
    assert.deepEqual(widget.render(50), first, "spinner wraps after ten frames");

    renderAgents(ctx, [{ ...running, status: "idle" }, idle]);
    assert.equal(widget.render(50)[1], "  ✓ agent-1  work");
    const stopped = renders;
    t.mock.timers.tick(800);
    assert.equal(renders, stopped, "idle widget must not animate");
    for (const status of ["starting", "interrupted", "failed"] as const) {
      renderAgents(ctx, [{ ...running, status }]);
      const lines = widget.render(50);
      t.mock.timers.tick(800);
      assert.equal(renders, stopped, `${status} widget must not animate`);
      assert.deepEqual(widget.render(50), lines);
    }

    renderAgents(ctx, [running]);
    t.mock.timers.tick(80);
    assert.equal(renders, stopped + 1, "animation restarts with a running agent");
    renderAgents(ctx, []);
    assert.equal(widget, undefined);
    t.mock.timers.tick(800);
    assert.equal(renders, stopped + 1, "clearing the widget stops its timer");

    renderAgents({ hasUI: false } as ExtensionContext, [running]);
    t.mock.timers.tick(800);
    assert.equal(renders, stopped + 1);
  } finally {
    widget?.dispose();
  }
});

test("dialog bridge serializes concurrent permissions and cancels stopped agents", async () => {
  const titles: string[] = [];
  let release!: (value: boolean) => void;
  const bridge = dialogBridge(
    () =>
      ({
        hasUI: true,
        ui: {
          confirm: async (title: string) => {
            titles.push(title);
            return new Promise<boolean>((resolve) => {
              release = resolve;
            });
          },
        },
      }) as unknown as ExtensionContext,
  );
  const agent = { id: "agent-1", task_name: "test", status: "running" as const, run: 1 };
  const signal = new AbortController();
  const first = bridge(agent, { method: "confirm", title: "first" }, signal.signal);
  const secondSignal = new AbortController();
  const second = bridge(agent, { method: "confirm", title: "second" }, secondSignal.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(titles.length, 1);
  secondSignal.abort();
  release(false);
  assert.deepEqual(await first, { confirmed: false });
  assert.deepEqual(await second, { cancelled: true });
  assert.equal(titles.length, 1);
});

test("package declares only an extension, no prompt or role resources", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.pi, { extensions: ["./index.ts"] });
});
