import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "vitest";

import { promptDomainBlock } from "../src/ui.ts";

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
