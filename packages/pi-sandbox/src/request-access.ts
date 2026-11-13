import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { Container, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  ACCESS_REQUEST_SCHEMA,
  ACCESS_REQUEST_DESCRIPTION,
  resolveAccessRequests,
  assertAccessRequestsUnchanged,
  assertAccessRequestsWritable,
  formatAccessRequestMessage,
  type ResolvedAccessRequest,
} from "sandbox";
import { displayPath } from "ts-helpers/display-path";
import { toolStatusLine, toolStatusText } from "ts-helpers/tool-status";

import { permissionDialog } from "./permission-status.ts";
import {
  ALLOW_LABEL,
  DENY_LABEL,
  dialogKey,
  moveSelection,
  permissionFooter,
  permissionOptions,
  permissionTitle,
  requestAttention,
} from "./prompt-style.ts";
import { RPC_PERMISSION_PROMPT_TIMEOUT_MS } from "./ui.ts";

const OPTIONS = [ALLOW_LABEL, DENY_LABEL];

function renderAccessRows(requests: unknown, theme: Theme, cwd: string): string[] {
  if (!Array.isArray(requests)) return [];
  return requests.flatMap((request: Partial<ResolvedAccessRequest> | null) => {
    if (!request || typeof request.path !== "string") return [];
    const access = request.access === "read" || request.access === "write" ? request.access : "…";
    const path = theme.fg("accent", theme.bold(displayPath(request.path, cwd)));
    const target =
      typeof request.target === "string" && request.target !== request.path
        ? ` → ${theme.fg("accent", theme.bold(displayPath(request.target, cwd)))}`
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
  requestAttention(pi);
  if (ctx.mode === "rpc") {
    const choice = await ctx.ui.select(
      `${permissionTitle(access)}\n\n${formatAccessRequestMessage(requests, (path) => displayPath(path))}`,
      OPTIONS,
      { signal, timeout: RPC_PERMISSION_PROMPT_TIMEOUT_MS },
    );
    return choice === ALLOW_LABEL && !signal?.aborted;
  }
  if (ctx.mode !== "tui") return false;

  let cancel: (() => void) | undefined;
  const abort = () => cancel?.();
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
            (value) => theme.fg("accent", displayPath(value)),
            (value) => theme.bold(value),
          );
          return [
            title,
            "",
            ...message.split("\n").map((line) => ` ${line}`),
            "",
            ...permissionOptions(theme, OPTIONS, selected),
            "",
            permissionFooter(theme),
          ].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
        },
        handleInput(data) {
          const key = dialogKey(keybindings, data);
          if (signal?.aborted || key === "cancel" || key === "interrupt") {
            done(false);
          } else if (key === "confirm") {
            done(OPTIONS[selected] === ALLOW_LABEL);
          } else if (key === "up" || key === "down") {
            selected = moveSelection(selected, OPTIONS.length, key);
            tui.requestRender();
          }
        },
        invalidate() {},
      };
    });
    return approved === true && !signal?.aborted;
  } finally {
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
    renderCall(args, theme, context) {
      return new Text(
        [
          theme.fg("toolTitle", theme.bold("sandbox_request_access:")),
          ...renderAccessRows(args?.requests, theme, context.cwd),
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
      if (context.isError) return new Text(toolStatusText(theme, "error", text), 0, 0);
      if (isPartial) return new Text(toolStatusText(theme, "pending", text), 0, 0);
      const requests = result.details?.requests;
      if (!requests?.length) return new Text(theme.fg("toolOutput", text), 0, 0);
      const lines = [
        toolStatusLine(
          theme,
          "success",
          "Granted",
          `${requests.length} ${requests.length === 1 ? "path" : "paths"}`,
          "this session only",
        ),
      ];
      if (expanded) {
        lines.push(
          ...renderAccessRows(requests, theme, context.cwd),
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
