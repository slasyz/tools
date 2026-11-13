import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  domainIsAllowed,
  matchesPattern,
  type NetworkDestination,
  type SandboxConfig,
  type SessionAllowances,
} from "sandbox";

import { displayPath } from "./display-path.ts";
import { permissionDialog } from "./permission-status.ts";
import {
  ALLOW_LABEL,
  DENY_LABEL,
  GLOBAL_ALLOW_LABEL,
  permissionFooter,
  permissionOption,
  permissionTitle,
  type AccessKind,
} from "./prompt-style.ts";

export type PermissionChoice = "abort" | "session" | "global";

export interface PermissionPromptResult {
  action: PermissionChoice;
  value: string;
}

export const RPC_PERMISSION_PROMPT_TIMEOUT_MS = 5 * 60_000;

interface PromptOption {
  label: string;
  action: PermissionChoice;
}

const PERMISSION_OPTIONS: PromptOption[] = [
  { label: ALLOW_LABEL, action: "session" },
  { label: DENY_LABEL, action: "abort" },
  {
    label: GLOBAL_ALLOW_LABEL,
    action: "global",
  },
];

const RPC_SESSION_OPTION = "Allow for this session only";
const RPC_EDIT_SESSION_OPTION = "Edit rule and allow for this session";
const RPC_ABORT_OPTION = "Abort (keep blocked)";
const RPC_GLOBAL_OPTION = "Allow for all projects";
const RPC_EDIT_GLOBAL_OPTION = "Edit rule and allow for all projects";

async function showRpcPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
  originalValue: string,
  validateValue: (value: string) => string | null,
): Promise<PermissionPromptResult> {
  const dialogOptions = {
    signal: ctx.signal,
    timeout: RPC_PERMISSION_PROMPT_TIMEOUT_MS,
  };
  const selected = await ctx.ui.select(
    title,
    [
      RPC_SESSION_OPTION,
      RPC_EDIT_SESSION_OPTION,
      RPC_ABORT_OPTION,
      RPC_GLOBAL_OPTION,
      RPC_EDIT_GLOBAL_OPTION,
    ],
    dialogOptions,
  );

  if (!selected || selected === RPC_ABORT_OPTION) {
    return { action: "abort", value: originalValue };
  }

  const isSession = selected === RPC_SESSION_OPTION || selected === RPC_EDIT_SESSION_OPTION;
  const isGlobal = selected === RPC_GLOBAL_OPTION || selected === RPC_EDIT_GLOBAL_OPTION;
  if (!isSession && !isGlobal) return { action: "abort", value: originalValue };

  const action: Exclude<PermissionChoice, "abort"> = isGlobal ? "global" : "session";
  let value = originalValue;

  if (selected === RPC_EDIT_SESSION_OPTION || selected === RPC_EDIT_GLOBAL_OPTION) {
    while (true) {
      const editedValue = await ctx.ui.input(
        `Edit permission rule for: ${displayPath(originalValue)}`,
        originalValue,
        dialogOptions,
      );
      if (editedValue === undefined) {
        return { action: "abort", value: originalValue };
      }

      value = editedValue.trim();
      const validationError = validateValue(value);
      if (!validationError) break;
      ctx.ui.notify(validationError, "error");
    }
  } else {
    const validationError = validateValue(value);
    if (validationError) {
      ctx.ui.notify(validationError, "error");
      return { action: "abort", value: originalValue };
    }
  }

  if (action === "global") {
    const confirmed = await ctx.ui.confirm(
      "Allow for all projects?",
      `Save "${displayPath(value)}" to ~/.agents/sandbox.json?`,
      dialogOptions,
    );
    if (!confirmed) return { action: "abort", value: originalValue };
  }

  return { action, value };
}

export async function showPermissionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string | { access: AccessKind },
  originalValue: string,
  validateValue: (value: string) => string | null,
): Promise<PermissionPromptResult> {
  if (!ctx.hasUI) return { action: "abort", value: originalValue };

  pi.events.emit("request-attention", { message: "Sandbox permission required" });

  if (ctx.mode === "rpc") {
    const heading = typeof title === "string" ? title : permissionTitle(title.access);
    return showRpcPermissionPrompt(
      ctx,
      `${heading}\n\n  ${displayPath(originalValue)}`,
      originalValue,
      validateValue,
    );
  }

  if (ctx.mode !== "tui") return { action: "abort", value: originalValue };

  const result = await permissionDialog<PermissionPromptResult>(ctx, (tui, theme, kb, done) => {
    const input = new Input();
    let selectedIndex = 0;
    let pendingAction: PermissionChoice | null = null;
    let editing = false;
    let componentFocused = false;
    let error: string | null = null;

    const selectedOption = (): PromptOption =>
      PERMISSION_OPTIONS[selectedIndex] ?? PERMISSION_OPTIONS[0]!;
    const isAllowOption = (option: PromptOption): boolean => option.action !== "abort";
    const updateFocus = (): void => {
      input.focused = componentFocused && editing;
    };
    const beginEditing = (): void => {
      input.setValue(originalValue);
      input.handleInput("\x05");
      editing = true;
      error = null;
      pendingAction = null;
      updateFocus();
    };
    const stopEditing = (): void => {
      editing = false;
      error = null;
      updateFocus();
    };
    const resolve = (action: PermissionChoice): void => {
      if (action === "abort") {
        done({ action, value: originalValue });
        return;
      }

      const value = editing ? input.getValue().trim() : originalValue;
      const validationError = validateValue(value);
      if (validationError) {
        if (!editing) beginEditing();
        error = validationError;
        editing = true;
        updateFocus();
        tui.requestRender();
        return;
      }
      if (action === "global" && pendingAction !== "global") {
        pendingAction = "global";
        tui.requestRender();
        return;
      }
      done({ action, value });
    };

    return {
      get focused(): boolean {
        return componentFocused;
      },
      set focused(value: boolean) {
        componentFocused = value;
        updateFocus();
      },
      render(width: number): string[] {
        const heading =
          typeof title === "string"
            ? title
            : permissionTitle(title.access, (value) => theme.bold(value));
        const lines = [
          theme.fg("warning", heading),
          "",
          `   ${theme.fg("accent", displayPath(originalValue))}`,
          "",
        ];
        for (let i = 0; i < PERMISSION_OPTIONS.length; i++) {
          const option = PERMISSION_OPTIONS[i]!;
          const isSelected = i === selectedIndex;
          lines.push(permissionOption(theme, option.label, isSelected));
          if (editing && isSelected && isAllowOption(option)) {
            lines.push(`   ${theme.fg("accent", input.render(Math.max(1, width - 3))[0] ?? "")}`);
          }
          if (pendingAction === option.action) {
            lines.push(
              `   ${theme.fg("warning", "Confirm saving this rule to ~/.agents/sandbox.json.")}`,
            );
          }
          if (editing && isSelected && error) {
            lines.push(theme.fg("error", `   ✗ ${error}`));
          }
        }
        lines.push("");
        lines.push(
          permissionFooter(theme, { editing, editRule: true, confirm: pendingAction !== null }),
        );
        return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.ctrl("c"))) {
          resolve("abort");
          return;
        }
        if (editing) {
          if (kb.matches(data, "tui.select.cancel")) {
            pendingAction = null;
            stopEditing();
            tui.requestRender();
            return;
          }
          if (kb.matches(data, "tui.select.confirm")) {
            resolve(selectedOption().action);
            return;
          }
          if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
            const delta = kb.matches(data, "tui.select.up") ? -1 : 1;
            selectedIndex =
              (selectedIndex + delta + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length;
            pendingAction = null;
            stopEditing();
            tui.requestRender();
            return;
          }
          input.handleInput(data);
          pendingAction = null;
          error = null;
          tui.requestRender();
          return;
        }
        if (kb.matches(data, "tui.select.cancel")) {
          resolve("abort");
          return;
        }
        if (matchesKey(data, Key.tab) && isAllowOption(selectedOption())) {
          beginEditing();
          tui.requestRender();
          return;
        }
        if (kb.matches(data, "tui.select.confirm")) {
          resolve(pendingAction ?? selectedOption().action);
          return;
        }
        if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
          const delta = kb.matches(data, "tui.select.up") ? -1 : 1;
          selectedIndex =
            (selectedIndex + delta + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length;
          pendingAction = null;
          tui.requestRender();
          return;
        }
      },
      invalidate(): void {
        input.invalidate();
      },
    };
  });

  return result ?? { action: "abort", value: originalValue };
}

const validRule = (value: string, matches: boolean, target: string): string | null => {
  if (value.length === 0) return "Rule cannot be empty.";
  return matches ? null : `Rule must match the blocked ${target}.`;
};

export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: NetworkDestination,
): Promise<PermissionPromptResult> {
  const target = `${domain.host}:${domain.port}`;
  return showPermissionPrompt(pi, ctx, { access: "network" }, target, (value) =>
    validRule(value, domainIsAllowed(domain.host, [value], domain.port), `domain "${target}"`),
  );
}

export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(pi, ctx, { access: "read" }, path, (value) =>
    validRule(value, matchesPattern(path, [value]), `path "${displayPath(path)}"`),
  );
}

export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(pi, ctx, { access: "write" }, path, (value) =>
    validRule(value, matchesPattern(path, [value]), `path "${displayPath(path)}"`),
  );
}

export function formatSandboxConfiguration(
  config: SandboxConfig,
  configPath: string,
  allowances: SessionAllowances,
): string {
  return [
    "Sandbox Configuration",
    `  Config: ${displayPath(configPath)}`,
    "",
    "Network (bash + !cmd):",
    `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
    `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
    ...(allowances.domains.length ? [`  Session allowed: ${allowances.domains.join(", ")}`] : []),
    "",
    "Filesystem (bash + read/write/edit/apply_patch tools):",
    `  Deny Read:   ${config.filesystem?.denyRead?.map(displayPath).join(", ") || "(none)"}`,
    `  Allow Read:  ${config.filesystem?.allowRead?.map(displayPath).join(", ") || "(none)"}`,
    `  Allow Write: ${config.filesystem?.allowWrite?.map(displayPath).join(", ") || "(none)"}`,
    `  Deny Write:  ${config.filesystem?.denyWrite?.map(displayPath).join(", ") || "(none)"}`,
    ...(allowances.readPaths.length
      ? [`  Session read:  ${allowances.readPaths.map(displayPath).join(", ")}`]
      : []),
    ...(allowances.writePaths.length
      ? [`  Session write: ${allowances.writePaths.map(displayPath).join(", ")}`]
      : []),
    "",
    "Note: ALL reads are prompted unless the path is in allowRead or allowWrite.",
    "Note: allowWrite also grants read access to the same path.",
    "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
    "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
  ].join("\n");
}
