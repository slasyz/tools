// BB gives tool-backed rows different IDs depending on the provider's activity kind.
const rowKinds = [
  "work-summary",
  "tool",
  "command",
  "file-edit",
  "web-search",
  "web-fetch",
  "image-view",
  "image-generation",
  "file-read",
  "search",
  "plan-steps",
  "extension",
  "delegation",
];
const rowSelector = rowKinds.map((kind) => `[data-timeline-row-id*=":${kind}:"]`).join(",");

function rowButton(row: Element) {
  // Toggle only this row's header, not nested rows or controls inside tool output.
  const buttons = row.querySelectorAll<HTMLButtonElement>(
    '[class~="group/timeline-row"] > button[aria-expanded]',
  );
  return [...buttons].find((button) => button.closest("[data-timeline-row-id]") === row) ?? null;
}

export function mountTimelineDefaults(signal: AbortSignal) {
  const collapsedRows = new Set<string>();
  let frame: number | null = null;
  let applyingDefaults = false;
  let disposed = false;

  function applyDefaults() {
    frame = null;
    if (signal.aborted || disposed) return;

    for (const row of document.querySelectorAll(rowSelector)) {
      const rowId = row.getAttribute("data-timeline-row-id")!;
      const button = rowButton(row);
      const expanded = button?.getAttribute("aria-expanded");
      const desired = collapsedRows.has(rowId) ? "false" : "true";
      if (button && (expanded === "true" || expanded === "false") && expanded !== desired) {
        // Our own clicks must not be recorded as manual choices.
        applyingDefaults = true;
        try {
          button.click();
        } finally {
          applyingDefaults = false;
        }
      }
    }
  }

  function recordChoice(event: MouseEvent) {
    if (applyingDefaults || signal.aborted || disposed || !(event.target instanceof Element))
      return;
    const button = event.target.closest<HTMLButtonElement>("button[aria-expanded]");
    const row = button?.closest("[data-timeline-row-id]");
    if (!button || !row?.matches(rowSelector) || rowButton(row) !== button) return;

    const rowId = row.getAttribute("data-timeline-row-id")!;
    // Capture runs before BB toggles the header, including keyboard-generated clicks.
    if (button.getAttribute("aria-expanded") === "true") {
      collapsedRows.add(rowId);
    } else {
      collapsedRows.delete(rowId);
    }
  }

  function scheduleScan() {
    if (!signal.aborted && !disposed && frame === null) {
      frame = requestAnimationFrame(applyDefaults);
    }
  }

  const observer = new MutationObserver(scheduleScan);

  function dispose() {
    disposed = true;
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    document.removeEventListener("click", recordChoice, true);
    signal.removeEventListener("abort", dispose);
    collapsedRows.clear();
  }

  if (signal.aborted) return dispose;

  document.addEventListener("click", recordChoice, true);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "data-timeline-row-id"],
  });
  signal.addEventListener("abort", dispose, { once: true });
  scheduleScan();
  return dispose;
}
