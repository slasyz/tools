import {
  keyText,
  type ExtensionAPI,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getConfigPath } from "sandbox";
import { displayPath } from "ts-helpers/display-path";

// Shared text and building blocks for every sandbox permission prompt, in both
// TUI and RPC modes.

/** Tell listening extensions (for example, a notification sound) that a prompt is waiting. */
export function requestAttention(pi: ExtensionAPI): void {
  pi.events.emit("request-attention", { message: "Sandbox permission required" });
}

export const ALLOW_LABEL = "✅ Allow";
export const DENY_LABEL = "❌ Deny";
export const GLOBAL_ALLOW_LABEL = "🔓 Allow for all projects";

/** RPC has no inline rule editor, so editing is a separate choice. */
export const editRuleLabel = (label: string): string => `${label} (edit rule)`;

export type AccessKind = "read" | "write" | "network" | "filesystem";

const ACCESS_EMOJI: Record<AccessKind, string> = {
  read: "📖",
  write: "📝",
  network: "🌐",
  filesystem: "📁",
};

type Style = (value: string) => string;
const plain: Style = (value) => value;

export function permissionTitle(access: AccessKind, styleAccess: Style = plain): string {
  return `${ACCESS_EMOJI[access]} Allow ${styleAccess(access)} access for this session?`;
}

export function unsandboxedTitle(styleTarget: Style = plain): string {
  return `🚨 Allow this command ${styleTarget("outside the sandbox")}?`;
}

export const configPathDisplay = (): string => displayPath(getConfigPath());

export const globalConfirmTitle = (): string => `${GLOBAL_ALLOW_LABEL}?`;

export const globalConfirmMessage = (value: string): string =>
  `Save "${displayPath(value)}" to ${configPathDisplay()}?`;

export const globalConfirmHint = (): string =>
  `Confirm saving this rule to ${configPathDisplay()}.`;

export const editRuleTitle = (value: string): string =>
  `Edit permission rule for: ${displayPath(value)}`;

export function ruleTarget(kind: "domain" | "path", value: string): string {
  return kind === "domain" ? `domain "${value}"` : `path "${displayPath(value)}"`;
}

export function ruleValidationError(
  value: string,
  matches: boolean,
  target: string,
): string | null {
  if (value.length === 0) return "Rule cannot be empty.";
  return matches ? null : `Rule must match ${target}.`;
}

export type DialogKey = "up" | "down" | "confirm" | "cancel" | "interrupt";

/** Map raw input to a dialog action. Ctrl+C always denies, even while editing. */
export function dialogKey(keybindings: KeybindingsManager, data: string): DialogKey | undefined {
  if (matchesKey(data, Key.ctrl("c"))) return "interrupt";
  if (keybindings.matches(data, "tui.select.cancel")) return "cancel";
  if (keybindings.matches(data, "tui.select.confirm")) return "confirm";
  if (keybindings.matches(data, "tui.select.up")) return "up";
  if (keybindings.matches(data, "tui.select.down")) return "down";
  return undefined;
}

/** Move the selection up or down, wrapping at both ends. */
export function moveSelection(index: number, count: number, key: "up" | "down"): number {
  return (index + (key === "up" ? -1 : 1) + count) % count;
}

export function permissionOption(theme: Theme, label: string, selected: boolean): string {
  const line = `${selected ? " → " : "   "}${label}`;
  return selected ? theme.fg("accent", theme.bold(line)) : line;
}

export function permissionOptions(theme: Theme, labels: string[], selected: number): string[] {
  return labels.map((label, index) => permissionOption(theme, label, index === selected));
}

export function permissionFooter(
  theme: Theme,
  options: { editRule?: boolean; editing?: boolean; confirm?: boolean } = {},
): string {
  const up = keyText("tui.select.up");
  const down = keyText("tui.select.down");
  const navigation = up === "up" && down === "down" ? "↑↓" : `${up}/${down}`;
  const cancel = keyText("tui.select.cancel")
    .split("/")
    .filter((key) => key !== "ctrl+c")
    .map((key) => (key === "escape" ? "esc" : key))
    .join("/");
  const hints = [
    `${navigation} navigate`,
    `${keyText("tui.select.confirm")} ${options.editing || options.confirm ? "confirm" : "select"}`,
  ];
  if (options.editRule && !options.editing) hints.push("tab edit rule");
  hints.push(`${cancel || "ctrl+c"} ${options.editing ? "reset" : "deny"}`);
  if (options.editing) hints.push("ctrl+c deny");
  return theme.fg("dim", ` ${hints.join(" • ")}`);
}
