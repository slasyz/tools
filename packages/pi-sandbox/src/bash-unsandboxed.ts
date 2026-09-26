/**
 * Runs a shell command outside pi-sandbox after explicit user approval.
 */

import {
	createBashToolDefinition,
	DynamicBorder,
	highlightCode,
	keyHint,
	rawKeyHint,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";

async function requestApproval(
	ctx: ExtensionContext,
	command: string,
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		const choice = await ctx.ui.select(
			`Run command outside the sandbox?\nWorking directory: ${ctx.cwd}\n\n${command}`,
			["Approve", "Reject"],
		);
		return choice === "Approve";
	}

	const choice = await ctx.ui.custom<"cancel" | "run">((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
		container.addChild(
			new Text(theme.fg("warning", theme.bold("⚠ Unsandboxed command")), 1, 0),
		);
		container.addChild(new Spacer(1));

		container.addChild(new Text(theme.fg("muted", "Directory"), 1, 0));
		container.addChild(new Text(theme.fg("text", ctx.cwd), 2, 0));
		container.addChild(new Spacer(1));

		container.addChild(new Text(theme.fg("muted", "Command"), 1, 0));
		const commandBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		commandBox.addChild(new Text(highlightCode(command, "bash").join("\n"), 0, 0));
		container.addChild(commandBox);
		container.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{ value: "run", label: "Approve" },
			{ value: "cancel", label: "Reject" },
		];
		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value as "cancel" | "run");
		selectList.onCancel = () => done("cancel");
		container.addChild(selectList);

		container.addChild(
			new Text(
				`${rawKeyHint("↑↓", "navigate")} • ${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`,
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return choice === "run";
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const shellPath = SettingsManager.create(cwd).getShellPath();
	const bashDefinition = createBashToolDefinition(cwd, { shellPath });

	pi.registerTool({
		...bashDefinition,
		name: "bash_unsandboxed",
		label: "bash (unsandboxed)",
		description:
			"Execute a shell command outside the sandbox after explicit user approval. Returns stdout and stderr with the standard bash output limits.",
		promptSnippet: "Run a shell command outside the sandbox after explicit user approval",
		promptGuidelines: [
			"Use bash by default. Use bash_unsandboxed only when the user explicitly requests unsandboxed execution or when bash fails due to a sandbox restriction.",
			"When bash fails because of sandbox, permission, filesystem, or network restrictions, rerun the same command with bash_unsandboxed without first asking in chat; bash_unsandboxed handles explicit user approval. Do not use bash_unsandboxed for unrelated commands.",
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

			pi.events.emit("sandbox:permission-requested", {
				command: params.command,
				cwd: ctx.cwd,
				toolName: "bash_unsandboxed",
			});

			const approved = await requestApproval(ctx, params.command);

			if (!approved) {
				return {
					content: [{ type: "text", text: "Command not run: user denied permission." }],
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
