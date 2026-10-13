import { afterEach, expect, test, vi } from "vitest";

import { Prompts } from "../src/prompts.ts";

afterEach(() => vi.useRealTimers());
const prompt = {
  sessionID: "session-a",
  kind: "read" as const,
  target: "/secret",
  title: "Read blocked",
};

test("headless and already-cancelled prompts deny immediately", async () => {
  const prompts = new Prompts();
  expect((await prompts.ask(prompt)).action).toBe("abort");
  prompts.poll("session-a", "client");
  expect((await prompts.ask(prompt, AbortSignal.abort())).action).toBe("abort");
});

test("only one live client in the correct session can claim and reply", async () => {
  const prompts = new Prompts();
  prompts.poll("session-a", "client-a");
  prompts.poll("session-b", "client-b");
  const pending = prompts.ask(prompt);
  const request = prompts.poll("session-a", "client-a")[0];
  expect(prompts.poll("session-b", "client-b")).toEqual([]);
  expect(prompts.claim(request.id, "client-b")).toBe(false);
  expect(prompts.claim(request.id, "client-a")).toBe(true);
  prompts.poll("session-a", "client-c");
  expect(prompts.claim(request.id, "client-c")).toBe(false);
  expect(() =>
    prompts.reply(request.id, "client-c", {
      action: "session",
      value: "/secret",
      confirmed: false,
    }),
  ).toThrow();
  prompts.reply(request.id, "client-a", { action: "session", value: "/secret", confirmed: false });
  expect((await pending).action).toBe("session");
  expect(() =>
    prompts.reply(request.id, "client-a", { action: "global", value: "/", confirmed: true }),
  ).toThrow();
});

test.each(["cancel", "timeout", "disconnect", "unload"])("%s never grants", async (mode) => {
  vi.useFakeTimers();
  const prompts = new Prompts(5000);
  const controller = new AbortController();
  prompts.poll("session-a", "client");
  const pending = prompts.ask(prompt, controller.signal);
  if (mode === "cancel") controller.abort();
  else if (mode === "unload") prompts.close();
  else await vi.advanceTimersByTimeAsync(6000);
  expect((await pending).action).toBe("abort");
  expect(prompts.poll("session-a", "client")).toEqual([]);
});

test("another live TUI cannot keep a disconnected owner's prompt approvable", async () => {
  vi.useFakeTimers();
  const prompts = new Prompts();
  prompts.poll("session-a", "owner");
  const pending = prompts.ask(prompt);
  const [request] = prompts.poll("session-a", "owner");
  expect(prompts.claim(request.id, "owner")).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  prompts.poll("session-a", "other");
  await vi.advanceTimersByTimeAsync(1001);
  expect(() =>
    prompts.reply(request.id, "owner", { action: "global", value: "/", confirmed: true }),
  ).toThrow("disconnected");
  expect((await pending).action).toBe("abort");
});
