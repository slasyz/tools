import { keyText, type Theme } from "@earendil-works/pi-coding-agent";

export const ALLOW_LABEL = "✅ Allow";
export const DENY_LABEL = "❌ Deny";
export const GLOBAL_ALLOW_LABEL = "🔓 Allow for all projects";

export type AccessKind = "read" | "write" | "network" | "filesystem";

const ACCESS_EMOJI: Record<AccessKind, string> = {
  read: "📖",
  write: "📝",
  network: "🌐",
  filesystem: "📁",
};

export function permissionTitle(
  access: AccessKind,
  styleAccess: (value: string) => string = (value) => value,
): string {
  return `${ACCESS_EMOJI[access]} Allow ${styleAccess(access)} access for this session?`;
}

export function permissionOption(theme: Theme, label: string, selected: boolean): string {
  const line = `${selected ? " → " : "   "}${label}`;
  return selected ? theme.fg("accent", theme.bold(line)) : line;
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
