/**
 * Runs a shell command outside pi-sandbox after explicit user approval.
 */

import {
  createBashToolDefinition,
  highlightCode,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { displayPath } from "ts-helpers/display-path";

import { markBashCall } from "./bash-render.ts";
import { permissionDialog } from "./permission-status.ts";
import {
  ALLOW_LABEL,
  DENY_LABEL,
  dialogKey,
  moveSelection,
  permissionFooter,
  permissionOptions,
  requestAttention,
  unsandboxedTitle,
} from "./prompt-style.ts";
import { RPC_PERMISSION_PROMPT_TIMEOUT_MS } from "./ui.ts";

const OPTIONS = [ALLOW_LABEL, DENY_LABEL];

type ApprovalResult = "approved" | "rejected" | "cancelled" | "too-long";

// BB limits extension UI messages to 8192 characters. Never truncate a command being approved.
const RPC_PERMISSION_MESSAGE_MAX_LENGTH = 8192;

async function requestApproval(ctx: ExtensionContext, command: string): Promise<ApprovalResult> {
  if (ctx.mode === "rpc") {
    const message = `Working directory: ${displayPath(ctx.cwd)}\n\nCommand:\n${command}`;
    if (message.length > RPC_PERMISSION_MESSAGE_MAX_LENGTH) return "too-long";

    const approved = await ctx.ui.confirm(unsandboxedTitle(), message, {
      signal: ctx.signal,
      timeout: RPC_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    // RPC confirm returns false for rejection, cancellation, and timeout alike.
    return approved ? "approved" : "cancelled";
  }

  if (ctx.mode !== "tui") {
    const choice = await ctx.ui.select(
      `${unsandboxedTitle()}\nWorking directory: ${displayPath(ctx.cwd)}\n\n${command}`,
      OPTIONS,
      { signal: ctx.signal, timeout: RPC_PERMISSION_PROMPT_TIMEOUT_MS },
    );
    if (choice === ALLOW_LABEL) return "approved";
    if (choice === DENY_LABEL) return "rejected";
    return "cancelled";
  }

  const choice = await permissionDialog<"cancel" | "run">(ctx, (tui, theme, keybindings, done) => {
    let selected = 0;
    const container = new Container();
    container.addChild(
      new Text(
        theme.fg(
          "warning",
          unsandboxedTitle((value) => theme.bold(value)),
        ),
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));

    container.addChild(new Text(theme.fg("muted", "Directory"), 1, 0));
    container.addChild(new Text(theme.fg("accent", displayPath(ctx.cwd)), 3, 0));
    container.addChild(new Spacer(1));

    container.addChild(new Text(theme.fg("muted", "Command"), 1, 0));
    const commandBox = new Box(3, 0, (text: string) => theme.bg("toolPendingBg", text));
    commandBox.addChild(new Text(highlightCode(command, "bash").join("\n"), 0, 0));
    container.addChild(commandBox);
    container.addChild(new Spacer(1));

    const choices = new Text(permissionOptions(theme, OPTIONS, selected).join("\n"), 0, 0);
    container.addChild(choices);
    container.addChild(new Spacer(1));

    container.addChild(new Text(permissionFooter(theme), 0, 0));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        const key = dialogKey(keybindings, data);
        if (key === "cancel" || key === "interrupt") {
          done("cancel");
        } else if (key === "confirm") {
          done(OPTIONS[selected] === ALLOW_LABEL ? "run" : "cancel");
        } else if (key === "up" || key === "down") {
          selected = moveSelection(selected, OPTIONS.length, key);
          choices.setText(permissionOptions(theme, OPTIONS, selected).join("\n"));
          tui.requestRender();
        }
      },
    };
  });

  if (choice === "run") return "approved";
  if (choice === "cancel") return "rejected";
  return "cancelled";
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const shellPath = SettingsManager.create(cwd).getShellPath();
  const bashDefinition = createBashToolDefinition(cwd, { shellPath });

  pi.registerTool({
    ...bashDefinition,
    name: "bash_unsandboxed",
    label: "bash (unsandboxed)",
    renderCall: markBashCall(bashDefinition.renderCall!, () => false),
    description:
      "Execute a shell command outside the sandbox after explicit user approval. Returns stdout and stderr with the standard bash output limits.",
    promptSnippet: "Run a shell command outside the sandbox after explicit user approval",
    promptGuidelines: [
      "For grantable filesystem restrictions, prefer sandbox_request_access to keep the operation sandboxed. If that request is denied, do not use bash_unsandboxed to bypass the denial.",
      "Use bash by default. Use bash_unsandboxed only when the user explicitly requests unsandboxed execution, bash fails due to a sandbox restriction, or clear evidence shows the command will hit one.",
      "For sandbox restrictions that cannot be addressed with sandbox_request_access, request bash_unsandboxed approval for the same command without first asking in chat. Check for partial changes before retrying. Do not use bash_unsandboxed for unrelated commands.",
      "Use bash_unsandboxed without a trial bash call when you have clear evidence that the command will hit a sandbox filesystem, permission, or network restriction.",
    ],
    async execute(id, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Command not run: unsandboxed execution requires interactive user approval.",
            },
          ],
          details: undefined,
        };
      }

      requestAttention(pi);

      const approval = await requestApproval(ctx, params.command);

      if (approval !== "approved") {
        const text =
          approval === "too-long"
            ? "Command not run: the command and working directory are too long to display in the RPC approval prompt."
            : approval === "rejected"
              ? "Command not run: user denied permission."
              : ctx.mode === "rpc"
                ? "Command not run: unsandboxed execution was not approved (denied, cancelled, or timed out)."
                : "Command not run: no approval was received because the permission request was cancelled.";
        return {
          content: [{ type: "text", text }],
          details: undefined,
        };
      }

      const currentShellPath = SettingsManager.create(ctx.cwd).getShellPath();
      const unsandboxedBash = createBashToolDefinition(ctx.cwd, {
        shellPath: currentShellPath,
      });
      return unsandboxedBash.execute(id, params, signal, onUpdate, ctx);
    },
  });
}
