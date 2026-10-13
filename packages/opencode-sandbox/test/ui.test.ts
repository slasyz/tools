import type { Context } from "@opencode/plugin/tui/context";

import { DEFAULT_CONFIG } from "sandbox";
import { expect, test, vi } from "vitest";

import { permissionDialog } from "../src/tui.ts";
import { formatSandboxStatus } from "../src/ui.ts";

vi.mock("@opencode/plugin/tui", () => ({ Plugin: { define: (plugin: unknown) => plugin } }));
const request = {
  id: "request",
  sessionID: "a",
  kind: "read" as const,
  target: "/secret",
  title: "Read blocked",
};
function context(choice?: string, edited?: string, confirmed = false) {
  const dialog = {
    select: vi.fn(async () => choice),
    prompt: vi.fn(async () => edited),
    confirm: vi.fn(async () => confirmed),
  };
  return { ctx: { ui: { dialog } } as unknown as Context, dialog };
}

test("session grant needs no global confirmation", async () => {
  const { ctx, dialog } = context("session");
  expect(await permissionDialog(ctx, request)).toEqual({
    action: "session",
    value: "/secret",
    confirmed: false,
  });
  expect(dialog.confirm).not.toHaveBeenCalled();
});
test("edited global grants display an explicit shared-config confirmation", async () => {
  const { ctx, dialog } = context("edit-global", "/secret/*", true);
  expect(await permissionDialog(ctx, request)).toEqual({
    action: "global",
    value: "/secret/*",
    confirmed: true,
  });
  expect(dialog.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("Pi") }),
  );
});
test.each(["abort", undefined, "edit-session", "global"])(
  "cancelled %s dialog denies",
  async (choice) => {
    const { ctx } = context(choice);
    expect((await permissionDialog(ctx, request)).action).toBe("abort");
  },
);
test.each(["disable", "unsandboxed"] as const)(
  "%s requires an explicit confirmation",
  async (kind) => {
    const denied = context();
    expect((await permissionDialog(denied.ctx, { ...request, kind })).action).toBe("abort");
    const allowed = context(undefined, undefined, true);
    expect((await permissionDialog(allowed.ctx, { ...request, kind })).confirmed).toBe(true);
    expect(allowed.dialog.select).not.toHaveBeenCalled();
  },
);
test("status includes effective config and separate session grants", () => {
  const text = formatSandboxStatus({
    enabled: false,
    configPath: "/config/sandbox.json",
    config: DEFAULT_CONFIG,
    allowances: { domains: ["example.org"], readPaths: [], writePaths: ["/approved"] },
  });
  expect(text).toContain("DISABLED");
  expect(text).toContain("Session domains: example.org");
  expect(text).toContain("Session writes: /approved");
});
