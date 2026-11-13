import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearApplyPatchRenderState,
	createApplyPatchTool,
	formatInFlightCallText,
	formatPatchPreview,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
	truncatePreview,
} from "../src/index.js";

const identityTheme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

const successBg = "\x1b[48;2;40;50;40m";
const bgReset = "\x1b[49m";
const ansiTheme = {
	fg: (_name: string, text: string) => text,
	bg: (name: string, text: string) => {
		const start = name === "toolSuccessBg" ? successBg : "\x1b[48;2;40;40;50m";
		return `${start}${text}${bgReset}`;
	},
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

describe("render helpers", () => {
	it("#given home paths in a move #when rendering #then shortens headers without changing args or diff content", () => {
		const home = homedir();
		const cwd = path.join(home, "project");
		const filePath = path.join(home, "elsewhere", "old.ts");
		const movePath = path.join(home, "elsewhere", "new.ts");
		const input = `*** Begin Patch\n*** Update File: ${filePath}\n*** Move to: ${movePath}\n@@\n-old\n+${home}\n*** End Patch`;
		const args = { input };
		const call = createApplyPatchTool()
			.renderCall?.(
				args,
				identityTheme as never,
				{
					argsComplete: true,
					cwd,
					toolCallId: "home-move",
				} as never,
			)
			?.render(400)
			.join("\n");
		expect(call).toContain("~/elsewhere/old.ts → ~/elsewhere/new.ts");
		expect(args.input).toBe(input);

		const preview = {
			files: [
				{ filePath, movePath, operation: "update" as const, diff: `-1 old\n+1 ${home}`, added: 1, removed: 1 },
			],
			added: 1,
			removed: 1,
		};
		const rendered = formatPatchPreview(preview, cwd);
		expect(rendered).toContain("~/elsewhere/old.ts → ~/elsewhere/new.ts");
		expect(rendered).toContain(`+1 ${home}`);
		expect(preview.files[0]?.filePath).toBe(filePath);
	});

	it("#given plain text diff #when truncating #then falls back to head and tail", () => {
		// given
		const lines = Array.from({ length: PATCH_PREVIEW_MAX_LINES + 12 }, (_, index) => `line-${index + 1}`);
		const diff = lines.join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview).toContain("line-1");
		expect(preview).toContain(`line-${lines.length}`);
		expect(preview).toContain("…");
		expect(preview.split("\n")).toHaveLength(PATCH_PREVIEW_MAX_LINES);
	});

	it("#given huge payload #when truncating #then enforces max chars", () => {
		// given
		const diff = `${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}\nend`;

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(preview.split("\n").length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
		expect(preview).toContain("…");
	});

	it("#given oversized changed hunk #when truncating #then keeps max chars strict", () => {
		// given
		const diff = [
			...Array.from({ length: 20 }, (_, index) => ` ${index + 1} line-${index + 1}`),
			`-21 ${"x".repeat(PATCH_PREVIEW_MAX_CHARS + 500)}`,
			"+21 changed",
		].join("\n");

		// when
		const preview = truncatePreview(diff);

		// then
		expect(preview.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(preview).toContain("…");
	});

	it("#given expanded false #when formatting preview #then renders headers only", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "/workspace/project/src/foo.ts",
					operation: "update" as const,
					diff: "-1 old\n+1 new",
					added: 1,
					removed: 1,
				},
			],
			added: 1,
			removed: 1,
		};

		// when
		const collapsed = formatPatchPreview(preview, "/workspace/project", false);
		const expanded = formatPatchPreview(preview, "/workspace/project", true);

		// then
		expect(collapsed).toContain("• Edited src/foo.ts (+1 -1)");
		expect(collapsed).not.toContain("+1 new");
		expect(expanded).toContain("+1 new");
	});

	it("#given omitted optional args #when formatting preview #then keeps backward compatible defaults", () => {
		// given
		const preview = {
			files: [
				{
					filePath: "src/foo.ts",
					operation: "update" as const,
					diff: "-1 old\n+1 new",
					added: 1,
					removed: 1,
				},
			],
			added: 1,
			removed: 1,
		};

		// when
		const rendered = formatPatchPreview(preview);

		// then
		expect(rendered).toContain("• Edited src/foo.ts (+1 -1)");
		expect(rendered).toContain("+1 new");
	});

	it("#given cached state #when clearing #then reset helper is callable", () => {
		// given/when/then
		expect(() => clearApplyPatchRenderState()).not.toThrow();
	});

	it("#given parseable call text #when formatting in-flight label #then includes count and paths", () => {
		// given
		const patch = `*** Begin Patch
*** Update File: src/a.ts
*** Add File: src/b.ts
*** End Patch`;

		// when
		const callText = formatInFlightCallText(patch);

		// then
		expect(callText).toContain("(2 files)");
		expect(callText).toContain("src/a.ts");
		expect(callText).toContain("src/b.ts");
	});

	it("#given partial args #when rendering call #then shows tool title", () => {
		// given
		const tool = createApplyPatchTool();

		// when
		const component = tool.renderCall?.(
			{ input: "{" },
			identityTheme as never,
			{
				argsComplete: false,
				cwd: "/workspace/project",
				toolCallId: "call-1",
			} as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain("apply_patch:");
	});

	it("#given streaming patch args #when a file section ends #then shows its line counts without edit content", () => {
		const tool = createApplyPatchTool();
		const render = (input: string, argsComplete: boolean = false) => {
			const component = tool.renderCall?.(
				{ input },
				identityTheme as never,
				{ argsComplete, cwd: "/workspace/project", toolCallId: "stream-1" } as never,
			);
			const lines = component?.render(400) ?? [];
			return lines.map((line) => line.trimEnd()).join("\n");
		};

		const first = render("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+ne");
		expect(first).toContain("apply_patch:\n");
		expect(first).toContain("└ editing src/a.ts");
		expect(first).not.toContain("(+0 -1)");
		expect(first).not.toContain("old");

		const second = render(
			"*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** Add File: src/b",
		);
		expect(second).toContain("└ editing src/a.ts → src/new.ts");
		expect(second).not.toContain("(+1 -1)");
		expect(second).not.toContain("src/b");

		const third = render(
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+hello\n",
		);
		expect(third).toContain("└ editing src/a.ts (+1 -1)");
		expect(third).toContain("└ adding src/b.ts");
		expect(third).not.toContain("└ adding src/b.ts (+1 -0)");
		expect(third).not.toContain("hello");

		const complete = render(
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+hello\n*** End Patch",
			true,
		);
		expect(complete).toContain("└ editing src/a.ts (+1 -1)");
		expect(complete).toContain("└ adding src/b.ts (+1 -0)");
	});

	it("#given many incoming files #when rendering call #then lists each file on a new line", () => {
		const tool = createApplyPatchTool();
		const input = `*** Begin Patch\n${Array.from({ length: 50 }, (_, i) => `*** Delete File: src/file-${i}.ts`).join("\n")}\n`;
		const component = tool.renderCall?.(
			{ input },
			identityTheme as never,
			{ argsComplete: false, cwd: "/workspace/project", toolCallId: "stream-large" } as never,
		);
		const rendered = component?.render(400).join("\n") ?? "";
		expect(rendered.split("\n")).toHaveLength(51);
		expect(rendered).toContain("└ deleting src/file-0.ts");
		expect(rendered).toContain("└ deleting src/file-49.ts");
		expect(rendered).not.toContain("(+0 -0)");
	});

	it("#given complete patch args #when rendering call #then shows each file and its patch line counts", () => {
		// given
		const tool = createApplyPatchTool();
		const args = {
			input: `*** Begin Patch
*** Update File: src/a.ts
@@
-old
+new
*** Add File: src/b.ts
+hello
*** End Patch`,
		};

		// when
		const component = tool.renderCall?.(
			args,
			identityTheme as never,
			{
				argsComplete: true,
				cwd: "/workspace/project",
				toolCallId: "call-2",
			} as never,
		);
		const lines = component?.render(200) ?? [];
		const rendered = lines.map((line) => line.trimEnd()).join("\n");

		// then
		expect(rendered).toContain("apply_patch:\n");
		expect(rendered).toContain("└ editing src/a.ts (+1 -1)");
		expect(rendered).toContain("└ adding src/b.ts (+1 -0)");
	});

	it("#given a resumed completed patch #when rendering call #then shows counts for the last file", () => {
		const tool = createApplyPatchTool();
		const input = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
		const render = (isPartial: boolean, patchText: string = input) => {
			const component = tool.renderCall?.(
				{ input: patchText },
				identityTheme as never,
				{ argsComplete: false, isPartial, cwd: "/workspace/project", toolCallId: "resumed-call" } as never,
			);
			return component?.render(200).join("\n") ?? "";
		};

		expect(render(true)).not.toContain("(+1 -1)");
		expect(render(false)).toContain("└ editing src/a.ts (+1 -1)");
		expect(render(false, "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new")).not.toContain("(+1 -1)");
	});

	it("#given complete files #when rendering call #then highlights filenames and added/removed counts", () => {
		const tool = createApplyPatchTool();
		const component = tool.renderCall?.(
			{
				input: "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** End Patch",
			},
			markerTheme as never,
			{ argsComplete: true, cwd: "/workspace/project", toolCallId: "colored-call" } as never,
		);
		const rendered = component?.render(400).join("\n") ?? "";
		expect(rendered).toContain("└ editing <fg:accent><bold>src/old.ts</bold></fg:accent>");
		expect(rendered).toContain("→ <fg:accent><bold>src/new.ts</bold></fg:accent>");
		expect(rendered).toContain(
			"(<fg:toolDiffAdded>+1</fg:toolDiffAdded> <fg:toolDiffRemoved>-1</fg:toolDiffRemoved>)",
		);
	});

	it("#given preview #when rendering result collapsed #then shows only one colored summary", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 old\n+1 new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			markerTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-1", args: { input: "" } } as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";
		const lines = component?.render(200) ?? [];

		// then
		expect(rendered).toContain("<bold>Applied patch</bold>");
		expect(rendered).not.toContain("<fg:success>");
		expect(rendered).toContain(" · </fg:muted>1 file");
		expect(rendered).toContain(
			"(<fg:toolDiffAdded>+1</fg:toolDiffAdded> <fg:toolDiffRemoved>-1</fg:toolDiffRemoved>)",
		);
		expect(rendered).not.toContain("src/foo.ts");
		expect(rendered).not.toContain("+1 new");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("");
		expect(lines[1]).toContain("Applied patch");
	});

	it("#given expanded preview #when rendering result #then uses OpenCode-like highlighted diff rows", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 alpha old\n+1 alpha new\n 2 same",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			markerTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-colored", args: { input: "" } } as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain("<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>2</fg:muted> same");
	});

	it("#given partial progress preview #when rendering result #then shows realtime progress in pending widget", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch (1/2)…" }],
			details: {
				progress: { applied: 1, failed: 0, total: 2 },
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "-1 alpha old\n+1 alpha new",
							added: 1,
							removed: 1,
						},
					],
					added: 1,
					removed: 1,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: true },
			markerTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-progress", args: { input: "" } } as never,
		);
		const rendered = component?.render(200).join("\n") ?? "";

		// then
		expect(rendered).toContain("<bg:toolPendingBg>");
		expect(rendered).toContain("<fg:warning><bold>Applying patch</bold></fg:warning>");
		expect(rendered).toContain(" · </fg:muted>1/2");
		expect(rendered).not.toContain("src/foo.ts");
		expect(rendered).not.toContain("alpha old");
	});

	it("#given multi-file preview #when rendering result collapsed #then shows grouped summary", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [
						{ filePath: "src/a.ts", operation: "update" as const, diff: "+1 one", added: 1, removed: 0 },
						{ filePath: "src/b.ts", operation: "update" as const, diff: "+1 two", added: 1, removed: 0 },
					],
					added: 2,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-3", args: { input: "" } } as never,
		);
		const rendered = component?.render(400).join("\n") ?? "";

		// then
		expect(rendered).toContain("Applied patch · 2 files (+2 -0)");
		expect(rendered).not.toContain("src/a.ts");
		expect(rendered).not.toContain("src/b.ts");
		expect(rendered).not.toContain("+1 one");
	});

	it("#given highlighted diff row #when rendering result in success box #then outer background resumes after row reset", () => {
		// given
		const tool = createApplyPatchTool();
		const result = {
			content: [{ type: "text" as const, text: "Applied patch" }],
			details: {
				preview: {
					files: [
						{
							filePath: "src/foo.ts",
							operation: "update" as const,
							diff: "+1 const value = 1;",
							added: 1,
							removed: 0,
						},
					],
					added: 1,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			ansiTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-bg", args: { input: "" } } as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";

		// then
		expect(rendered).toContain(`${bgReset}${successBg}`);
	});

	it("#given large preview #when rendering result expanded #then shows truncation marker", () => {
		// given
		const tool = createApplyPatchTool();
		const diff = Array.from({ length: 50 }, (_, index) => `+${index + 1} line`).join("\n");
		const result = {
			content: [{ type: "text" as const, text: "Applying patch" }],
			details: {
				preview: {
					files: [{ filePath: "src/large.ts", operation: "update" as const, diff, added: 50, removed: 0 }],
					added: 50,
					removed: 0,
				},
			},
		};

		// when
		const component = tool.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			identityTheme as never,
			{ cwd: "/workspace/project", toolCallId: "result-large", args: { input: "" } } as never,
		);
		const rendered = component?.render(400).join("\n") ?? "";

		// then
		expect(rendered).toContain("└ edited src/large.ts (+50 -0)");
		expect(rendered).toContain("…");
	});

	it.each([
		[true, "Patch partially failed"],
		[false, "Patch failed"],
	])(
		"#given failures with partial success %s #when rendering result #then uses the shared error heading",
		(hasPartialSuccess, title) => {
			// given
			const tool = createApplyPatchTool();
			const result = {
				content: [{ type: "text" as const, text: "apply_patch failed." }],
				details: {
					preview: { files: [], added: 0, removed: 0 },
					result: {
						summaries: [],
						appliedFiles: [],
						failures: [{ filePath: "a.ts", operation: "update" as const, message: "missing" }],
						hasPartialSuccess,
						recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: ["a.ts"] },
						details: { fuzz: 0 },
					},
				},
			};

			// when
			const rendered =
				tool
					.renderResult?.(
						result,
						{ expanded: false, isPartial: false },
						identityTheme as never,
						{ cwd: "/workspace/project", toolCallId: "result-failed", args: { input: "" } } as never,
					)
					.render(200)
					.map((line) => line.trimEnd())
					.join("\n") ?? "";

			// then
			expect(rendered).toContain(`${title}`);
		},
	);

	it("#given thrown error #when rendering result #then shows the shared error heading", () => {
		// given
		const tool = createApplyPatchTool();
		const result = { content: [{ type: "text" as const, text: "Invalid patch\nline 2" }], details: undefined };

		// when
		const rendered =
			tool
				.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					markerTheme as never,
					{ cwd: "/workspace/project", toolCallId: "result-error", args: { input: "" }, isError: true } as never,
				)
				.render(200)
				.map((line) => line.trimEnd())
				.join("\n") ?? "";

		// then
		expect(rendered).toBe("<fg:error><bold>Invalid patch</bold></fg:error>\n<fg:error>line 2</fg:error>");
	});

	const rowsPreview = {
		files: [
			{ filePath: "src/a.ts", operation: "update" as const, diff: "-1 old\n+1 new", added: 1, removed: 1 },
			{ filePath: "src/b.ts", operation: "add" as const, diff: "+1 b", added: 1, removed: 0 },
		],
		added: 2,
		removed: 1,
	};
	const renderRows = (
		details: Record<string, unknown>,
		options: { expanded: boolean; isPartial: boolean },
		theme: object = identityTheme,
	) =>
		createApplyPatchTool()
			.renderResult?.(
				{ content: [{ type: "text" as const, text: "" }], details } as never,
				options,
				theme as never,
				{ cwd: "/workspace/project", toolCallId: "rows", args: { input: "" } } as never,
			)
			.render(200)
			.map((line) => line.trimEnd())
			.join("\n") ?? "";

	it("#given expanded success #when rendering result #then lists file rows once without a repeated summary", () => {
		// when
		const rendered = renderRows({ preview: rowsPreview }, { expanded: true, isPartial: false });

		// then
		expect(rendered.split("\n").slice(1, 3)).toEqual([
			" Applied patch · 2 files (+2 -1)",
			"   └ edited src/a.ts (+1 -1)",
		]);
		expect(rendered).not.toContain("• Edited");
		expect(rendered.match(/\(\+2 -1\)/g)).toHaveLength(1);
		expect(rendered).toContain("  └ edited src/a.ts (+1 -1)");
		expect(rendered).toContain("  └ added src/b.ts (+1 -0)");
	});

	it("#given file rows #when rendering result #then styles paths and counts like the call", () => {
		// when
		const rendered = renderRows({ preview: rowsPreview }, { expanded: true, isPartial: false }, markerTheme);

		// then
		expect(rendered).toContain(
			"└ edited <fg:accent><bold>src/a.ts</bold></fg:accent> (<fg:toolDiffAdded>+1</fg:toolDiffAdded> <fg:toolDiffRemoved>-1</fg:toolDiffRemoved>)",
		);
	});

	it("#given pending preview #when rendering result #then rows use the in-progress verb", () => {
		// when
		const rendered = renderRows({ preview: rowsPreview }, { expanded: true, isPartial: true });

		// then
		expect(rendered).toContain("└ editing src/a.ts (+1 -1)");
		expect(rendered).toContain("└ adding src/b.ts (+1 -0)");
	});

	it("#given one failed file #when rendering result #then marks only that file with its reason", () => {
		// given
		const result = {
			summaries: [],
			appliedFiles: ["src/b.ts"],
			failures: [{ filePath: "src/a.ts", operation: "update" as const, message: "context not found" }],
			hasPartialSuccess: true,
			recoveryInstructions: { mustReadFiles: [], mustNotReadFiles: [], failedFiles: ["src/a.ts"] },
			details: { fuzz: 0 },
		};

		// when
		const plain = renderRows({ preview: rowsPreview, result }, { expanded: false, isPartial: false });
		const marked = renderRows({ preview: rowsPreview, result }, { expanded: false, isPartial: false }, markerTheme);

		// then
		expect(plain).toContain("└ failed to edit src/a.ts (+1 -1) · context not found");
		expect(plain).toContain("└ added src/b.ts (+1 -0)");
		expect(plain).not.toContain("-1 old");
		expect(marked).toContain("<fg:error>failed to edit</fg:error>");
		expect(marked).toContain("<fg:error>context not found</fg:error>");
	});
});
