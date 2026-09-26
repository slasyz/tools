import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	APPLY_PATCH_AUTHORIZATION_EVENT,
	type ApplyPatchAuthorizationEvent,
	type ApplyPatchAuthorizationRequest,
	type ApplyPatchExtensionAPI,
	createApplyPatchTool,
	getApplyPatchMutations,
	isApplyPatchAuthorizationEvent,
	PatchParseError,
	registerApplyPatchExtension,
} from "../src/index.js";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(process.cwd(), "test-temp-authorization-"));
	tempDirectories.push(directory);
	return directory;
}

async function executePatch(
	directory: string,
	patchText: string,
	authorize?: (request: ApplyPatchAuthorizationRequest) => Promise<void> | void,
): Promise<void> {
	const tool = createApplyPatchTool(authorize ? { authorize } : {});
	await tool.execute("authorization-test", { input: patchText }, undefined, undefined, { cwd: directory } as never);
}

function createRegisteredTool(events: EventBus): ReturnType<typeof createApplyPatchTool> {
	let registeredTool: ReturnType<typeof createApplyPatchTool> | undefined;
	registerApplyPatchExtension({
		events,
		registerTool(tool) {
			registeredTool = tool;
		},
		on() {
			return () => {};
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
	});
	if (!registeredTool) {
		throw new Error("apply_patch tool was not registered");
	}
	return registeredTool;
}

function requireAuthorizationEvent(data: unknown): ApplyPatchAuthorizationEvent {
	if (!isApplyPatchAuthorizationEvent(data)) {
		throw new Error("invalid apply_patch authorization event");
	}
	return data;
}

async function executeRegisteredPatch(tool: ReturnType<typeof createApplyPatchTool>, cwd: string, input: string) {
	await tool.execute("event-authorization-test", { input }, undefined, undefined, { cwd } as never);
}

afterEach(async () => {
	while (tempDirectories.length > 0) {
		const directory = tempDirectories.pop();
		if (directory) {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

describe("apply_patch authorization", () => {
	it("#given no authorization options #when tool executes #then applies the patch", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "sample.txt"), "before\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-before
+after
*** End Patch`;

		// when
		await executePatch(directory, patch);

		// then
		expect(await readFile(path.join(directory, "sample.txt"), "utf-8")).toBe("after\n");
	});

	it("#given a registered tool with no authorization listeners #when tool executes #then applies the patch", async () => {
		// given
		const directory = await createTempDirectory();
		const events = createEventBus();
		const tool = createRegisteredTool(events);
		const patch = `*** Begin Patch
*** Add File: standalone.txt
+content
*** End Patch`;

		// when
		await executeRegisteredPatch(tool, directory, patch);

		// then
		expect(await readFile(path.join(directory, "standalone.txt"), "utf-8")).toBe("content\n");
	});

	it("#given event authorizers #when one rejects #then all settle and the complete patch is blocked", async () => {
		// given
		const directory = await createTempDirectory();
		const events = createEventBus();
		const tool = createRegisteredTool(events);
		let slowAuthorizerFinished = false;
		events.on(APPLY_PATCH_AUTHORIZATION_EVENT, (data) => {
			const event = requireAuthorizationEvent(data);
			event.waitUntil(
				() =>
					new Promise<void>((resolve) => {
						setTimeout(() => {
							slowAuthorizerFinished = true;
							resolve();
						}, 10);
					}),
			);
		});
		events.on(APPLY_PATCH_AUTHORIZATION_EVENT, (data) => {
			const event = requireAuthorizationEvent(data);
			event.waitUntil(() => Promise.reject(new Error("event denied")));
		});
		const patch = `*** Begin Patch
*** Add File: first.txt
+one
*** Add File: second.txt
+two
*** End Patch`;

		// when / then
		await expect(executeRegisteredPatch(tool, directory, patch)).rejects.toThrow("event denied");
		expect(slowAuthorizerFinished).toBe(true);
		await expect(readFile(path.join(directory, "first.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(path.join(directory, "second.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("#given an event authorizer #when it throws synchronously #then the complete patch is blocked before preview", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "existing.txt"), "before\n", "utf-8");
		const events = createEventBus();
		const tool = createRegisteredTool(events);
		let updates = 0;
		const authorize = () => {
			throw new Error("synchronous event denial");
		};
		events.on(APPLY_PATCH_AUTHORIZATION_EVENT, (data) => {
			const event = requireAuthorizationEvent(data);
			event.waitUntil(() => authorize());
		});
		const patch = `*** Begin Patch
*** Add File: denied.txt
+content
*** Update File: existing.txt
@@
-before
+after
*** End Patch`;

		// when / then
		await expect(
			tool.execute(
				"synchronous-event-authorization-test",
				{ input: patch },
				undefined,
				() => {
					updates += 1;
				},
				{ cwd: directory } as never,
			),
		).rejects.toThrow("synchronous event denial");
		expect(updates).toBe(0);
		await expect(readFile(path.join(directory, "denied.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(path.join(directory, "existing.txt"), "utf-8")).toBe("before\n");
	});

	it("#given synchronous and asynchronous event authorizers #when both allow #then applies the patch", async () => {
		// given
		const directory = await createTempDirectory();
		const events = createEventBus();
		const tool = createRegisteredTool(events);
		const completed: string[] = [];
		events.on(APPLY_PATCH_AUTHORIZATION_EVENT, (data) => {
			const event = requireAuthorizationEvent(data);
			event.waitUntil(() => {
				completed.push("synchronous");
			});
			event.waitUntil(async () => {
				await Promise.resolve();
				completed.push("asynchronous");
			});
		});
		const patch = `*** Begin Patch
*** Add File: allowed.txt
+content
*** End Patch`;

		// when
		await executeRegisteredPatch(tool, directory, patch);

		// then
		expect(completed).toEqual(["synchronous", "asynchronous"]);
		expect(await readFile(path.join(directory, "allowed.txt"), "utf-8")).toBe("content\n");
	});

	it("#given an event authorizer #when it rejects #then it runs after parsing and before preview", async () => {
		// given
		const directory = await createTempDirectory();
		const events = createEventBus();
		const tool = createRegisteredTool(events);
		let requests = 0;
		let updates = 0;
		events.on(APPLY_PATCH_AUTHORIZATION_EVENT, (data) => {
			const event = requireAuthorizationEvent(data);
			requests += 1;
			event.waitUntil(() => Promise.reject(new Error("event stopped preview")));
		});
		const patch = `*** Begin Patch
*** Delete File: .
*** End Patch`;

		// when / then
		await expect(
			tool.execute(
				"event-before-preview-test",
				{ input: patch },
				undefined,
				() => {
					updates += 1;
				},
				{ cwd: directory } as never,
			),
		).rejects.toThrow("event stopped preview");
		expect(requests).toBe(1);
		expect(updates).toBe(0);
	});

	it("#given malformed and empty patches #when a registered tool executes #then no event authorization is requested", async () => {
		// given
		const directory = await createTempDirectory();
		const events = createEventBus();
		const tool = createRegisteredTool(events);
		let requests = 0;
		events.on(APPLY_PATCH_AUTHORIZATION_EVENT, () => {
			requests += 1;
		});

		// when / then
		await expect(executeRegisteredPatch(tool, directory, "not a patch")).rejects.toBeInstanceOf(PatchParseError);
		await expect(executeRegisteredPatch(tool, directory, "*** Begin Patch\n*** End Patch")).rejects.toBeInstanceOf(
			PatchParseError,
		);
		expect(requests).toBe(0);
	});

	it("#given all patch operations #when authorized #then callback receives ordered parser-derived mutations once", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "update.txt"), "before\n", "utf-8");
		await writeFile(path.join(directory, "delete.txt"), "delete\n", "utf-8");
		await writeFile(path.join(directory, "move.txt"), "move\n", "utf-8");
		const patch = `*** Begin Patch
*** Add File: add.txt
+added
*** Update File: update.txt
@@
-before
+after
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-move
+moved
*** End Patch`;
		const requests: ApplyPatchAuthorizationRequest[] = [];

		// when
		await executePatch(directory, patch, async (request) => {
			await Promise.resolve();
			requests.push(request);
		});

		// then
		expect(requests).toEqual([
			{
				cwd: directory,
				patchText: patch,
				mutations: [
					{ operation: "add", path: "add.txt" },
					{ operation: "update", path: "update.txt" },
					{ operation: "delete", path: "delete.txt" },
					{ operation: "update", path: "move.txt", movePath: "moved.txt" },
				],
			},
		]);
	});

	it("#given callback mutates its request #when execution continues #then internal parsed hunks are unchanged", async () => {
		// given
		const directory = await createTempDirectory();
		const patch = `*** Begin Patch
*** Add File: intended.txt
+content
*** End Patch`;

		// when
		await executePatch(directory, patch, (request) => {
			const mutation = request.mutations[0];
			if (mutation) {
				mutation.path = "redirected.txt";
			}
		});

		// then
		expect(await readFile(path.join(directory, "intended.txt"), "utf-8")).toBe("content\n");
		await expect(readFile(path.join(directory, "redirected.txt"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("#given authorization rejects a multi-file patch #when executed #then no file is changed", async () => {
		// given
		const directory = await createTempDirectory();
		await writeFile(path.join(directory, "first.txt"), "one\n", "utf-8");
		await writeFile(path.join(directory, "second.txt"), "two\n", "utf-8");
		const patch = `*** Begin Patch
*** Update File: first.txt
@@
-one
+ONE
*** Update File: second.txt
@@
-two
+TWO
*** End Patch`;

		// when / then
		await expect(
			executePatch(directory, patch, () => {
				throw new Error("denied");
			}),
		).rejects.toThrow("denied");
		expect(await readFile(path.join(directory, "first.txt"), "utf-8")).toBe("one\n");
		expect(await readFile(path.join(directory, "second.txt"), "utf-8")).toBe("two\n");
	});

	it("#given an unreadable preview target #when authorization rejects #then authorization error occurs before preview", async () => {
		// given
		const directory = await createTempDirectory();
		const patch = `*** Begin Patch
*** Delete File: .
*** End Patch`;
		let updates = 0;
		const tool = createApplyPatchTool({
			authorize() {
				throw new Error("authorization stopped preview");
			},
		});

		// when / then
		await expect(
			tool.execute(
				"authorization-before-preview-test",
				{ input: patch },
				undefined,
				() => {
					updates += 1;
				},
				{ cwd: directory } as never,
			),
		).rejects.toThrow("authorization stopped preview");
		expect(updates).toBe(0);
	});

	it("#given invalid or empty patches #when executed #then authorization is not invoked", async () => {
		// given
		const directory = await createTempDirectory();
		let calls = 0;
		const authorize = () => {
			calls += 1;
		};

		// when / then
		await expect(executePatch(directory, "not a patch", authorize)).rejects.toBeInstanceOf(PatchParseError);
		await expect(executePatch(directory, "*** Begin Patch\n*** End Patch", authorize)).rejects.toBeInstanceOf(
			PatchParseError,
		);
		expect(calls).toBe(0);
	});

	it("#given mutation helper input #when parsed #then it validates with the real parser", () => {
		// given
		const validPatch = `*** Begin Patch
*** Add File: same.txt
+one
*** Delete File: same.txt
*** End Patch`;
		const regexLikeInvalidPatch = "*** Add File: plausible.txt\n+content";

		// when / then
		expect(getApplyPatchMutations(validPatch)).toEqual([
			{ operation: "add", path: "same.txt" },
			{ operation: "delete", path: "same.txt" },
		]);
		expect(() => getApplyPatchMutations(regexLikeInvalidPatch)).toThrow(PatchParseError);
	});

	it("#given configurable extension registration #when registered #then forwards authorization to the tool", async () => {
		// given
		const directory = await createTempDirectory();
		const patch = `*** Begin Patch
*** Add File: blocked.txt
+content
*** End Patch`;
		const registeredTools: Array<ReturnType<typeof createApplyPatchTool>> = [];
		const api = {
			events: {
				emit() {},
				on() {
					return () => {};
				},
			},
			registerTool(tool: ReturnType<typeof createApplyPatchTool>) {
				registeredTools.push(tool);
			},
			on() {
				return () => {};
			},
			getActiveTools() {
				return [];
			},
			setActiveTools() {},
		} satisfies ApplyPatchExtensionAPI;
		registerApplyPatchExtension(api, {
			authorize() {
				throw new Error("extension denied");
			},
		});

		// when / then
		const registeredTool = registeredTools[0];
		if (!registeredTool) {
			throw new Error("apply_patch tool was not registered");
		}
		await expect(
			registeredTool.execute("registered-authorization-test", { input: patch }, undefined, undefined, {
				cwd: directory,
			} as never),
		).rejects.toThrow("extension denied");
	});
});
