// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountSummaryDefaults } from "../summary-defaults";

let frames: Map<number, FrameRequestCallback>;
let dispose: (() => void) | undefined;

beforeEach(() => {
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let pass = 0; pass < 10; pass++) {
    // Deliver MutationObserver callbacks before running the next animation frame.
    await Promise.resolve();
    if (frames.size === 0) return;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(performance.now());
  }
  throw new Error("Summary scans did not settle");
}

function makeRow(id = "thread:work-summary:1", expanded = false) {
  const row = document.createElement("div");
  row.setAttribute("data-timeline-row-id", id);
  const header = document.createElement("div");
  header.className = "group/timeline-row";
  const button = document.createElement("button");
  button.setAttribute("aria-expanded", String(expanded));
  const label = document.createElement("span");
  label.textContent = "Activity summary";
  button.append(label);
  const onClick = vi.fn(() => {
    button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true"));
  });
  button.addEventListener("click", onClick);
  header.append(button);
  row.append(header);
  return { row, button, label, onClick };
}

function mount() {
  const controller = new AbortController();
  dispose = mountSummaryDefaults(controller.signal);
  return controller;
}

describe("summary defaults", () => {
  it("expands existing and newly added summaries, leaving open ones alone", async () => {
    const closed = makeRow();
    const open = makeRow("thread:work-summary:2", true);
    document.body.append(closed.row, open.row);
    mount();
    await settle();
    expect(closed.button.getAttribute("aria-expanded")).toBe("true");
    expect(closed.onClick).toHaveBeenCalledTimes(1);
    expect(open.onClick).not.toHaveBeenCalled();

    const next = makeRow("thread:work-summary:3");
    document.body.append(next.row);
    await settle();
    expect(next.button.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a manual collapse closed through unrelated DOM changes", async () => {
    const summary = makeRow();
    document.body.append(summary.row);
    mount();
    await settle();
    summary.label.click();
    document.body.append(document.createElement("div"));
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("false");
    expect(summary.onClick).toHaveBeenCalledTimes(2);
  });

  it("allows collapse before the initial scan", async () => {
    const summary = makeRow(undefined, true);
    document.body.append(summary.row);
    mount();
    summary.button.click();
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps manual choices when rows remount and allows reopening", async () => {
    const summary = makeRow();
    document.body.append(summary.row);
    mount();
    await settle();
    summary.button.click();
    await settle();
    summary.row.remove();

    const remounted = makeRow(undefined, true);
    document.body.append(remounted.row);
    await settle();
    expect(remounted.button.getAttribute("aria-expanded")).toBe("false");
    remounted.button.click();
    await settle();
    expect(remounted.button.getAttribute("aria-expanded")).toBe("true");
    remounted.row.remove();

    const reopened = makeRow();
    document.body.append(reopened.row);
    await settle();
    expect(reopened.button.getAttribute("aria-expanded")).toBe("true");
  });

  it("handles keyboard-generated clicks", async () => {
    const summary = makeRow();
    document.body.append(summary.row);
    mount();
    await settle();
    summary.button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not transfer a collapse to another row ID on a recycled element", async () => {
    const summary = makeRow();
    document.body.append(summary.row);
    mount();
    await settle();
    summary.button.click();
    await settle();
    summary.row.setAttribute("data-timeline-row-id", "other-thread:work-summary:1");
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores individual tool output and nested tool headers", async () => {
    const summary = makeRow();
    const nested = makeRow("thread:tool:1");
    const tool = makeRow("thread:tool:2");
    summary.row.append(nested.row);
    document.body.append(summary.row, tool.row);
    mount();
    await settle();
    expect(nested.onClick).not.toHaveBeenCalled();
    expect(tool.onClick).not.toHaveBeenCalled();
    nested.button.click();
    nested.button.click();
    summary.button.setAttribute("aria-expanded", "false");
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("true");
    expect(nested.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("waits for a header mounted after its row", async () => {
    const summary = makeRow();
    const header = summary.row.firstElementChild!;
    header.remove();
    document.body.append(summary.row);
    mount();
    await settle();
    summary.row.append(header);
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("true");
  });

  it("resets manual choices when the content script is reloaded", async () => {
    const summary = makeRow();
    document.body.append(summary.row);
    const controller = mount();
    await settle();
    summary.button.click();
    await settle();
    controller.abort();
    mount();
    await settle();
    expect(summary.button.getAttribute("aria-expanded")).toBe("true");
  });

  it("cancels pending work on abort and leaves later rows alone", async () => {
    const summary = makeRow();
    document.body.append(summary.row);
    const controller = mount();
    controller.abort();
    await settle();
    expect(frames.size).toBe(0);
    expect(summary.onClick).not.toHaveBeenCalled();
    const next = makeRow("thread:work-summary:2");
    document.body.append(next.row);
    await settle();
    expect(next.onClick).not.toHaveBeenCalled();
  });
});
