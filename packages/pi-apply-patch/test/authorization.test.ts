import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ApplyPatchAuthorizationRequest,
	createApplyPatchTool,
	getApplyPatchMutations,
	PatchParseError,
	registerApplyPatchExtension,
	type ApplyPatchExtensionAPI,
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
		await expect(
			executePatch(directory, "*** Begin Patch\n*** End Patch", authorize),
		).rejects.toBeInstanceOf(PatchParseError);
		expect(calls).toBe(0);
	});

	it("#given mutation helper input #when parsed #then it validates with the real parser", () => {
		// given
		const validPatch = `*** Begin Patch
*** Add File: same.txt
+one
*** Delete File: same.txt
*** End Patch`;
		const regex-likeInvalidPatch = "*** Add File: plausible.txt\n+content";

		// when / then
		expect(getApplyPatchMutations(validPatch)).toEqual([
			{ operation: "add", path: "same.txt" },
			{ operation: "delete", path: "same.txt" },
		]);
		expect(() => getApplyPatchMutations(regex-likeInvalidPatch)).toThrow(PatchParseError);
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
			registerTool(tool: ReturnType<typeof createApplyPatchTool>) {
				registeredTools.push(tool);
			},
			on() {},
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
