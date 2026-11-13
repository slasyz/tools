import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  ACCESS_REQUEST_SCHEMA,
  ACCESS_REQUEST_DESCRIPTION,
  resolveAccessRequests,
  assertAccessRequestsUnchanged,
  assertAccessRequestsWritable,
  formatAccessRequestTitle,
  formatAccessRequestMessage,
  type ResolvedAccessRequest,
} from "sandbox";

import { permissionDialog } from "./permission-status.ts";
import { RPC_PERMISSION_PROMPT_TIMEOUT_MS } from "./ui.ts";

export async function promptSessionAccess(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requests: ResolvedAccessRequest[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || signal?.aborted) return false;
  pi.events.emit("request-attention", { message: "Sandbox permission required" });
  if (ctx.mode === "rpc") {
    const choice = await ctx.ui.select(
      `${formatAccessRequestTitle(requests)}\n\n${formatAccessRequestMessage(requests)}`,
      ["Allow", "Deny"],
      { signal, timeout: RPC_PERMISSION_PROMPT_TIMEOUT_MS },
    );
    return choice === "Allow" && !signal?.aborted;
  }
  if (ctx.mode !== "tui") return false;

  let cancel: (() => void) | undefined;
  const abort = () => cancel?.();
  const timer = setTimeout(abort, RPC_PERMISSION_PROMPT_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const approved = await permissionDialog<boolean>(ctx, (tui, theme, keybindings, done) => {
      let selected = 0;
      cancel = () => done(false);
      if (signal?.aborted) done(false);
      return {
        render(width) {
          const title = formatAccessRequestTitle(requests, (value) => theme.bold(value));
          const message = formatAccessRequestMessage(
            requests,
            (value) => theme.fg("accent", value),
            (value) => theme.bold(value),
          );
          const buttons = ["Allow", "Deny"]
            .map((label, index) =>
              index === selected ? theme.fg("accent", theme.bold(`[${label}]`)) : `[${label}]`,
            )
            .join("  ");
          return [title, "", ...message.split("\n"), "", buttons].flatMap((line) =>
            wrapTextWithAnsi(line, Math.max(1, width)),
          );
        },
        handleInput(data) {
          if (
            signal?.aborted ||
            keybindings.matches(data, "tui.select.cancel") ||
            matchesKey(data, Key.ctrl("c"))
          ) {
            done(false);
          } else if (keybindings.matches(data, "tui.select.confirm")) {
            done(selected === 0);
          } else if (
            matchesKey(data, Key.left) ||
            matchesKey(data, Key.right) ||
            matchesKey(data, Key.tab) ||
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down")
          ) {
            selected = 1 - selected;
            tui.requestRender();
          }
        },
        invalidate() {},
      };
    });
    return approved === true && !signal?.aborted;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export default function registerAccessRequest(
  pi: ExtensionAPI,
  policy: {
    available: () => boolean;
    denyWrite: () => string[];
    grant: (requests: ResolvedAccessRequest[], signal?: AbortSignal) => Promise<void>;
  },
): void {
  pi.registerTool({
    name: "sandbox_request_access",
    label: "Request sandbox access",
    description: ACCESS_REQUEST_DESCRIPTION,
    promptSnippet: "Request session-only filesystem access through a user approval prompt",
    promptGuidelines: [
      "Use sandbox_request_access for blocked or known-to-be-restricted filesystem access; request the narrowest paths and access types, without asking in chat first.",
      "sandbox_request_access does not retry the original operation. Check for partial changes before retrying; if access is denied, do not seek another way around the restriction.",
    ],
    parameters: ACCESS_REQUEST_SCHEMA,
    executionMode: "sequential",
    async execute(_id, input, signal, _onUpdate, ctx) {
      const activeSignal =
        signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : (signal ?? ctx.signal);
      const check = () => {
        if (activeSignal?.aborted) throw new Error("Sandbox authorization cancelled");
        if (!policy.available()) throw new Error("Sandbox is inactive or unavailable");
      };
      check();
      const requests = resolveAccessRequests(input, ctx.cwd);
      assertAccessRequestsWritable(requests, policy.denyWrite(), ctx.cwd);
      if (!(await promptSessionAccess(pi, ctx, requests, activeSignal))) {
        throw new Error("Sandbox access denied: no approval received; no access granted");
      }
      check();
      assertAccessRequestsUnchanged(requests);
      assertAccessRequestsWritable(requests, policy.denyWrite(), ctx.cwd);
      await policy.grant(requests, activeSignal);
      return {
        content: [
          {
            type: "text",
            text: `Session access granted for ${requests.length} path(s). No operation was run.`,
          },
        ],
        details: { requests },
      };
    },
  });
}
