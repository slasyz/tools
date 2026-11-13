import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { homedir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";

import registerAccessRequest from "../src/request-access.ts";

const plainTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};
const markerTheme = {
  fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
  bold: (value: string) => `<bold>${value}</bold>`,
};

function tool() {
  let definition: ToolDefinition;
  registerAccessRequest(
    { registerTool: (value: ToolDefinition) => (definition = value) } as unknown as ExtensionAPI,
    { available: () => true, denyWrite: () => [], grant: async () => {} },
  );
  return definition!;
}

function call(args: unknown, theme = plainTheme, width = 120) {
  return tool().renderCall!(args, theme as never, {} as never).render(width);
}

const requests = [
  { access: "read", path: "/shared/config", target: "/resolved/config" },
  { access: "write", path: "/output", target: "/output" },
];
const result = {
  content: [{ type: "text" as const, text: "Session access granted. No operation was run." }],
  details: { requests },
};

function renderResult(
  value = result,
  { expanded = false, isPartial = false, isError = false } = {},
  theme = plainTheme,
) {
  return tool().renderResult!(value, { expanded, isPartial }, theme as never, { isError } as never)
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("call uses the apply_patch-style title and paths followed by access", () => {
  expect(
    call({
      requests: [
        { access: "read", path: "../shared/config" },
        { access: "write", path: "../output" },
      ],
    }).map((line) => line.trimEnd()),
  ).toEqual(["sandbox_request_access:", "  └ ../shared/config (read)", "  └ ../output (write)"]);
});

test("call highlights the title and paths but mutes access labels", () => {
  const text = call({ requests: [{ access: "read", path: "../config" }] }, markerTheme).join("\n");
  expect(text).toContain("<toolTitle><bold>sandbox_request_access:</bold></toolTitle>");
  expect(text).toContain("<accent><bold>../config</bold></accent> <muted>(read)</muted>");
});

test.each([
  undefined,
  {},
  { requests: null },
  { requests: {} },
  { requests: [null, {}, { access: "read" }] },
])("incomplete arguments still render a title: %j", (args) => {
  expect(call(args).map((line) => line.trimEnd())).toEqual(["sandbox_request_access:"]);
});

test("streaming paths can render before the access label arrives", () => {
  expect(call({ requests: [{ path: "../config" }] }).join("\n")).toContain("└ ../config (…)");
});

test("long paths wrap within narrow terminal widths without losing text", () => {
  const path = "/long/目录/" + "config".repeat(10);
  const lines = call({ requests: [{ access: "read", path }] }, plainTheme, 18);
  expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
  expect(lines.map((line) => line.trimEnd()).join("")).toContain(path);
});

test("collapsed success has a blank line before the colored session-only summary", () => {
  expect(renderResult()).toBe("\nGranted · 2 paths · this session only");
  expect(renderResult(result, {}, markerTheme)).toBe(
    "\n<success><bold>Granted</bold></success><muted> · </muted>2 paths<muted> · </muted>this session only",
  );
  const single = { ...result, details: { requests: requests.slice(0, 1) } };
  expect(renderResult(single)).toBe("\nGranted · 1 path · this session only");
});

test("expanded success lists approved paths and symlink targets", () => {
  expect(renderResult(result, { expanded: true })).toBe(
    [
      "",
      "Granted · 2 paths · this session only",
      "  └ /shared/config → /resolved/config (read)",
      "  └ /output (write)",
      "  No operation was run.",
    ].join("\n"),
  );
});

test("call shows paths inside cwd relative to it, like apply_patch", () => {
  const text = tool().renderCall!(
    { requests: [{ access: "read", path: "/project/src/config" }] },
    plainTheme as never,
    { cwd: "/project" } as never,
  )
    .render(120)
    .join("\n");
  expect(text).toContain("└ src/config (read)");
});

test("call and expanded result shorten home paths without changing requests", () => {
  const requests = [
    { path: join(homedir(), "alias"), target: join(homedir(), "target"), access: "read" },
  ];
  const original = structuredClone(requests);
  expect(call({ requests }).join("\n")).toContain("~/alias → ~/target (read)");
  expect(renderResult({ ...result, details: { requests } }, { expanded: true })).toContain(
    "~/alias → ~/target (read)",
  );
  expect(requests).toEqual(original);
});

test("errors retain the full reason and never show a granted status", () => {
  const failure = {
    content: [
      {
        type: "text" as const,
        text: "Sandbox access denied: no approval received; no access granted",
      },
    ],
    details: undefined,
  };
  const text = renderResult(failure as never, { isError: true }, markerTheme);
  expect(text).toBe(`<error><bold>${failure.content[0].text}</bold></error>`);
  expect(text).not.toContain("Granted");
  expect(renderResult(result, { isError: true })).not.toContain("Granted");
});

test("partial and unstructured results preserve their text without claiming approval", () => {
  expect(renderResult(result, { isPartial: true })).toBe(`${result.content[0].text}`);
  expect(renderResult({ ...result, details: undefined } as never)).toBe(result.content[0].text);
});
