import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

export async function permissionDialog<T>(
  ctx: ExtensionContext,
  factory: Parameters<typeof ctx.ui.custom<T>>[0],
): Promise<T> {
  let terminal: Terminal | undefined;
  try {
    return await ctx.ui.custom<T>((tui, ...args) => {
      if (ctx.hasUI && ctx.mode === "tui") {
        terminal = tui.terminal;
        terminal.write("\x1b]7501;state=blocked:kind=permission:app=pi\x1b\\");
      }
      return factory(tui, ...args);
    });
  } finally {
    // Also restore the status when the dialog is cancelled or fails.
    terminal?.write("\x1b]7501;state=working:app=pi\x1b\\");
  }
}
