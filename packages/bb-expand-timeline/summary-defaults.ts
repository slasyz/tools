const summarySelector = '[data-timeline-row-id*=":work-summary:"]';

function summaryButton(row: Element) {
  // Use the summary's own header, leaving nested tool output alone.
  const button = row.querySelector<HTMLButtonElement>(
    '[class~="group/timeline-row"] > button[aria-expanded]',
  );
  return button?.closest("[data-timeline-row-id]") === row ? button : null;
}

export function mountSummaryDefaults(signal: AbortSignal) {
  const collapsedSummaries = new Set<string>();
  let frame: number | null = null;
  let applyingDefaults = false;
  let disposed = false;

  function applyDefaults() {
    frame = null;
    if (signal.aborted || disposed) return;

    for (const row of document.querySelectorAll(summarySelector)) {
      const rowId = row.getAttribute("data-timeline-row-id")!;
      const button = summaryButton(row);
      const expanded = button?.getAttribute("aria-expanded");
      const desired = collapsedSummaries.has(rowId) ? "false" : "true";
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
    const row = button?.closest(summarySelector);
    if (!button || !row || summaryButton(row) !== button) return;

    const rowId = row.getAttribute("data-timeline-row-id")!;
    // Capture runs before BB toggles the header, including keyboard-generated clicks.
    if (button.getAttribute("aria-expanded") === "true") {
      collapsedSummaries.add(rowId);
    } else {
      collapsedSummaries.delete(rowId);
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
    collapsedSummaries.clear();
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
