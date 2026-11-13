import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { Container, Key, matchesKey, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
import {
  ALLOW_LABEL,
  DENY_LABEL,
  permissionFooter,
  permissionOption,
  permissionTitle,
} from "./prompt-style.ts";
import { RPC_PERMISSION_PROMPT_TIMEOUT_MS } from "./ui.ts";

function renderAccessRows(requests: unknown, theme: Theme): string[] {
  if (!Array.isArray(requests)) return [];
  return requests.flatMap((request: Partial<ResolvedAccessRequest> | null) => {
    if (!request || typeof request.path !== "string") return [];
    const access = request.access === "read" || request.access === "write" ? request.access : "…";
    const path = theme.fg("accent", theme.bold(request.path));
    const target =
      typeof request.target === "string" && request.target !== request.path
        ? ` → ${theme.fg("accent", theme.bold(request.target))}`
        : "";
    return [`  └ ${path}${target} ${theme.fg("muted", `(${access})`)}`];
  });
}

export async function promptSessionAccess(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requests: ResolvedAccessRequest[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || signal?.aborted) return false;
  const access = requests.every((request) => request.access === requests[0]?.access)
    ? requests[0]!.access
    : "filesystem";
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
          const title = theme.fg(
            "warning",
            permissionTitle(access, (value) => theme.bold(value)),
          );
          const message = formatAccessRequestMessage(
            requests,
            (value) => theme.fg("accent", value),
            (value) => theme.bold(value),
          );
          const buttons = [ALLOW_LABEL, DENY_LABEL].map((label, index) =>
            permissionOption(theme, label, index === selected),
          );
          return [
            title,
            "",
            ...message.split("\n").map((line) => ` ${line}`),
            "",
            ...buttons,
            "",
            permissionFooter(theme),
          ].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
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
  pi.registerTool<typeof ACCESS_REQUEST_SCHEMA, { requests: ResolvedAccessRequest[] }>({
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
    renderCall(args, theme) {
      return new Text(
        [
          theme.fg("toolTitle", theme.bold("sandbox_request_access:")),
          ...renderAccessRows(args?.requests, theme),
        ].join("\n"),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (context.isError) return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
      if (isPartial) return new Text(theme.fg("warning", text), 0, 0);
      const requests = result.details?.requests;
      if (!requests?.length) return new Text(theme.fg("toolOutput", text), 0, 0);
      const lines = [
        theme.fg(
          "success",
          `✓ Granted · ${requests.length} ${requests.length === 1 ? "path" : "paths"} · this session only`,
        ),
      ];
      if (expanded) {
        lines.push(
          ...renderAccessRows(requests, theme),
          theme.fg("muted", "  No operation was run."),
        );
      }
      const component = new Container();
      component.addChild(new Spacer(1));
      component.addChild(new Text(lines.join("\n"), 0, 0));
      return component;
    },
  });
}
