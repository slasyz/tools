import { stripVTControlCharacters } from "node:util";

import {
  createEventBus,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { expect, test } from "vitest";

import { promptDomainBlock, promptReadBlock, promptWriteBlock } from "../src/ui.ts";

test("network prompt offers and validates port-scoped grants", async () => {
  const notices: string[] = [];
  const edits = ["example.com:8443", "*.example.com:443"];
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      select: async () => "Edit rule and allow for this session",
      input: async () => edits.shift(),
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionContext;
  const pi = { events: createEventBus() } as unknown as ExtensionAPI;

  assert.deepEqual(await promptDomainBlock(pi, ctx, { host: "api.example.com", port: 443 }), {
    action: "session",
    value: "*.example.com:443",
  });
  assert.equal(notices.length, 1);
});

test("network prompt defaults to a port-scoped grant", async () => {
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: { select: async () => "Allow for this session only" },
  } as unknown as ExtensionContext;
  const pi = { events: createEventBus() } as unknown as ExtensionAPI;

  assert.deepEqual(await promptDomainBlock(pi, ctx, { host: "example.com", port: 443 }), {
    action: "session",
    value: "example.com:443",
  });
});

function tuiPrompt() {
  initTheme("dark", false);
  let component: Component;
  let settled = false;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async (factory: Function) =>
        new Promise((done) => {
          component = factory(
            { terminal: { write() {} }, requestRender() {} },
            {
              bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
              fg: (color: string, value: string) =>
                `\x1b[${color === "warning" ? 33 : 36}m${value}\x1b[39m`,
            },
            getKeybindings(),
            (value: unknown) => {
              settled = true;
              done(value);
            },
          );
        }),
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    pi: { events: createEventBus() } as unknown as ExtensionAPI,
    input: (key: string) => component.handleInput!(key),
    render: (width = 200) => component.render(width),
    plain: () => component.render(200).map(stripVTControlCharacters).join("\n"),
    settled: () => settled,
  };
}

test.each([
  ["read", "📖", promptReadBlock],
  ["write", "📝", promptWriteBlock],
] as const)(
  "%s prompt formats the heading and full path with consistent choices",
  async (access, emoji, prompt) => {
    const f = tuiPrompt();
    const path = "/a/very/long/directory/config.json";
    const pending = prompt(f.pi, f.ctx, path);
    const lines = f.render();
    expect(lines[0]).toContain(`${emoji} Allow \x1b[1m${access}\x1b[22m access`);
    expect(lines[2]).toContain(`\x1b[36m${path}`);
    expect(f.plain()).toContain(" → ✅ Allow\n   ❌ Deny\n   🔓 Allow for all projects");
    expect(f.plain()).toContain("↑↓ navigate • enter select • tab edit rule • esc deny");
    expect(f.plain()).not.toMatch(/\[(s|esc|A)\]/);
    const narrow = f.render(18);
    expect(narrow.every((line) => visibleWidth(line) <= 18)).toBe(true);
    expect(narrow.map(stripVTControlCharacters).join("")).toContain(path);
    for (const key of ["s", "a", "A"]) f.input(key);
    expect(f.settled()).toBe(false);
    f.input("\r");
    expect(await pending).toEqual({ action: "session", value: path });
  },
);

test("network prompt uses the same layout and denial behavior", async () => {
  const f = tuiPrompt();
  const pending = promptDomainBlock(f.pi, f.ctx, { host: "api.example.com", port: 443 });
  expect(f.render()[0]).toContain("🌐 Allow \x1b[1mnetwork");
  expect(f.plain()).toContain("api.example.com:443");
  f.input("\x1b[B");
  expect(f.plain()).toContain(" → ❌ Deny");
  f.input("\r");
  expect(await pending).toEqual({ action: "abort", value: "api.example.com:443" });
});

test("permanent grants require another confirmation after editing and validation", async () => {
  const f = tuiPrompt();
  const pending = promptDomainBlock(f.pi, f.ctx, { host: "api.example.com", port: 443 });
  f.input("\x1b[B");
  f.input("\x1b[B");
  f.input("\t");
  f.input("\x15"); // Clear the rule.
  f.input("\r");
  expect(f.plain()).toContain("Rule cannot be empty.");
  expect(f.settled()).toBe(false);
  f.input("*.example.com:443");
  f.input("\r");
  expect(f.plain()).toContain("Confirm saving this rule to ~/.agents/sandbox.json.");
  expect(f.settled()).toBe(false);
  f.input("\r");
  expect(await pending).toEqual({ action: "global", value: "*.example.com:443" });
});

test("escape resets an edited rule before denying", async () => {
  const f = tuiPrompt();
  const pending = promptReadBlock(f.pi, f.ctx, "/config");
  f.input("\t");
  f.input("\x15");
  f.input("/other");
  expect(f.plain()).toContain("esc reset • ctrl+c deny");
  f.input("\x1b");
  expect(f.settled()).toBe(false);
  expect(f.plain()).not.toContain("/other");
  f.input("\x1b");
  expect(await pending).toEqual({ action: "abort", value: "/config" });
});
