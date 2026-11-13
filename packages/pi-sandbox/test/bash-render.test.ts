import { stripVTControlCharacters } from "node:util";

import {
  createBashToolDefinition,
  createEventBus,
  initTheme,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

import { markBashCall } from "../src/bash-render.ts";
import registerSandboxExtension from "../src/extension.ts";

initTheme("dark", false);

const bash = createBashToolDefinition(process.cwd());
type RenderCall = NonNullable<typeof bash.renderCall>;
type RenderContext = Parameters<RenderCall>[2];
const theme = {} as Parameters<RenderCall>[1];
const context = () => ({ state: {}, executionStarted: false }) as RenderContext;
const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

test.each([
  [true, "🔒"],
  [false, "🚨"],
] as const)("marks sandboxed=%s without changing the native header", (sandboxed, icon) => {
  const args = { command: "printf hello", timeout: 10 };
  const original = plain(bash.renderCall!(args, theme, context()).render(120));
  const marked = plain(
    markBashCall(bash.renderCall!, () => sandboxed)(args, theme, context()).render(120),
  );
  expect(marked).toEqual([`${icon} ${original[0]}`]);
});

test("keeps the marker on existing rows after toggling, but updates new rows", () => {
  let enabled = true;
  const render = markBashCall(bash.renderCall!, () => enabled);
  const args = { command: "echo first" };
  const ctx = context();
  const first = render(args, theme, ctx);
  enabled = false;
  const updated = render({ command: "echo updated" }, theme, { ...ctx, lastComponent: first });
  expect(updated).toBe(first);
  expect(plain(updated.render(120))).toEqual(["🔒 $ echo updated"]);
  expect(plain(render(args, theme, context()).render(120))).toEqual(["🚨 $ echo first"]);
});

test.each([1, 2, 3, 8, 18, 80])("wraps multiline and wide commands within %s columns", (width) => {
  const args = { command: "printf '目录 and a long command'\necho done" };
  const component = markBashCall(bash.renderCall!, () => false)(args, theme, context());
  const lines = component.render(width);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  if (width >= 8) {
    expect(plain(lines)[0]).toMatch(/^🚨 /);
    expect(
      plain(lines)
        .slice(1)
        .every((line) => line.startsWith("   ")),
    ).toBe(true);
  }
});

test("forwards invalidation and native renderer state", () => {
  const native = new Text("$ echo hello", 0, 0);
  const invalidate = vi.spyOn(native, "invalidate");
  const renderCall = vi.fn<RenderCall>(() => native);
  const render = markBashCall(renderCall, () => true);
  const ctx = context();
  const args = { command: "echo hello" };
  const marked = render(args, theme, ctx);
  marked.invalidate();
  expect(invalidate).toHaveBeenCalledOnce();
  render(args, theme, { ...ctx, lastComponent: marked });
  expect(renderCall.mock.calls[1]![2].lastComponent).toBe(native);
  expect(renderCall.mock.calls[1]![2].state).toBe(ctx.state);
});

test("registered bash tools show the unsandboxed marker when the sandbox is inactive", () => {
  const tools: ToolDefinition[] = [];
  registerSandboxExtension({
    events: createEventBus(),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerFlag() {},
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI);

  for (const name of ["bash", "bash_unsandboxed"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    expect(
      plain(tool.renderCall!({ command: "echo hello" }, theme, context()).render(120)),
    ).toEqual(["🚨 $ echo hello"]);
  }
});
