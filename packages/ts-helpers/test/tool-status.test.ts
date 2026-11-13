import { expect, test } from "vitest";

import { toolStatusLine, toolStatusText } from "../src/tool-status.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

test("formats a status heading with details", () => {
  expect(toolStatusLine(theme, "success", "Done", "2 files")).toBe(
    "<success><b>Done</b></success><muted> · </muted>2 files",
  );
  expect(toolStatusLine(theme, "neutral", "Done")).toBe("<b>Done</b>");
  expect(toolStatusLine(theme, "pending", "Working")).toBe("<warning><b>Working</b></warning>");
});

test("formats multi-line text with one heading", () => {
  expect(toolStatusText(theme, "error", "Failed\ndetail")).toBe(
    "<error><b>Failed</b></error>\n<error>detail</error>",
  );
  expect(toolStatusText(theme, "pending", "Working")).toBe("<warning><b>Working</b></warning>");
});
