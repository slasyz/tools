/** `neutral` is for results that need no color, such as an applied patch whose diff carries the color. */
export type ToolStatus = "success" | "neutral" | "error" | "pending";

export interface ToolStatusTheme {
  fg(color: "success" | "error" | "warning" | "muted", text: string): string;
  bold(text: string): string;
}

const COLORS = {
  success: "success",
  neutral: undefined,
  error: "error",
  pending: "warning",
} as const;

const paint = (theme: ToolStatusTheme, status: ToolStatus, text: string): string => {
  const color = COLORS[status];
  return color ? theme.fg(color, text) : text;
};

/** Tool result heading: `<title> · <detail> · <detail>`, with the title colored by status. */
export function toolStatusLine(
  theme: ToolStatusTheme,
  status: ToolStatus,
  title: string,
  ...details: string[]
): string {
  return [paint(theme, status, theme.bold(title)), ...details].join(theme.fg("muted", " · "));
}

/** Multi-line tool text: the first line as a status heading, the rest below it. */
export function toolStatusText(theme: ToolStatusTheme, status: ToolStatus, text: string): string {
  const [first = "", ...rest] = text.split("\n");
  return [
    toolStatusLine(theme, status, first),
    ...rest.map((line) => paint(theme, status, line)),
  ].join("\n");
}
