import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type BashCallRenderer = NonNullable<ReturnType<typeof createBashToolDefinition>["renderCall"]>;

class MarkedBashCall implements Component {
  component!: Component;

  constructor(readonly icon: string) {}

  render(width: number): string[] {
    const prefix = `${this.icon} `;
    const padding = " ".repeat(visibleWidth(prefix));
    return this.component
      .render(Math.max(1, width - visibleWidth(prefix)))
      .map((line, index) => truncateToWidth(`${index === 0 ? prefix : padding}${line}`, width));
  }

  invalidate(): void {
    this.component.invalidate();
  }
}

export function markBashCall(
  renderCall: BashCallRenderer,
  isSandboxed: () => boolean,
): BashCallRenderer {
  return (args, theme, context) => {
    // Keep each row's marker when the sandbox is toggled later in the session.
    const previous = context.lastComponent;
    const marked =
      previous instanceof MarkedBashCall
        ? previous
        : new MarkedBashCall(isSandboxed() ? "🔒" : "🚨");
    marked.component = renderCall(args, theme, {
      ...context,
      lastComponent: previous instanceof MarkedBashCall ? previous.component : previous,
    });
    return marked;
  };
}
