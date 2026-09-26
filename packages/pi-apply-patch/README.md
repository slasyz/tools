# pi-apply-patch

This repository ([`slasyz/pi-apply-patch`](https://github.com/slasyz/pi-apply-patch)) is a fork of the upstream repository ([`code-yeongyu/pi-apply-patch`](https://github.com/code-yeongyu/pi-apply-patch)). It adds authorization hooks that let other extensions and embedders inspect and approve the complete parser-derived mutation plan before preview reads or filesystem changes occur, plus the `getApplyPatchMutations` helper for mutation extraction.

Codex-style `apply_patch` tool extension for the [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). It registers a freeform grammar patch tool for OpenAI GPT-family models and swaps out `write` / `edit` while those models are active.

## Behavior

The extension registers one LLM-callable tool: `apply_patch`. The tool accepts Codex patch envelopes and applies file additions, updates, deletions, and moves after resolving file paths against the current workspace.

| Case                                          | Result                                           |
| --------------------------------------------- | ------------------------------------------------ |
| OpenAI GPT provider active                    | replaces `write` and `edit` with `apply_patch`   |
| Custom `openai-responses` GPT provider active | replaces `write` and `edit` with `apply_patch`   |
| Non-GPT model active                          | restores the original `write` and `edit` toolset |
| Raw freeform patch input                      | accepted and applied                             |
| JSON `{ "input": "..." }` patch input         | accepted and applied                             |
| Absolute or parent-escaping path              | accepted and resolved by Node path semantics     |

## Tool

### `apply_patch`

Use this tool to edit files with the Codex patch format.

```text
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
```

Pi exposes this as a freeform grammar tool. Models with `compat.supportsOpenAIGrammarTools` enabled receive an OpenAI custom grammar tool; other Responses-compatible models fall back to a function tool with an `input` string.

Custom provider names are supported when the model id starts with `gpt-` and its Pi API is `openai-responses` or `openai-codex-responses`. For example, a model registered as `my-proxy/gpt-5` with `api: "openai-responses"` activates `apply_patch` without adding the provider name to a hard-coded allowlist.

## Authorization hook

The registered tool emits `APPLY_PATCH_AUTHORIZATION_EVENT` after it parses and
validates the complete patch. Authorization listeners must call `waitUntil(...)`
synchronously during event dispatch, passing a callback. The tool runs each
callback inside a promise and awaits all results; any synchronous throw or
rejection blocks the whole patch before preview reads or mutations begin.

```ts
import { APPLY_PATCH_AUTHORIZATION_EVENT, isApplyPatchAuthorizationEvent } from "pi-apply-patch";

pi.events.on(APPLY_PATCH_AUTHORIZATION_EVENT, (data) => {
	if (!isApplyPatchAuthorizationEvent(data)) return;
	data.waitUntil(() => authorize(data));
});
```

Pi's event bus does not await event handlers. Calling `waitUntil` after an
`await`, timer, or other asynchronous boundary is too late and is rejected.
With no listeners, the extension keeps its standalone behavior.

Consumers embedding the tool can authorize its complete parser-derived mutation plan before any patch preview reads or filesystem mutations occur:

```ts
import { registerApplyPatchExtension } from "pi-apply-patch";

registerApplyPatchExtension(pi, {
	authorize: async ({ cwd, patchText, mutations }) => {
		// Resolve and authorize every mutation. Updates with a move include movePath.
	},
});
```

`createApplyPatchTool(options)` accepts the same options. The callback receives the current `cwd`, the patch input, and ordered `add`, `delete`, and `update` mutations using raw parser paths. Throwing or rejecting blocks the entire tool call. Calls without options retain the standalone behavior.

Use `getApplyPatchMutations(patchText)` when only parser-validated mutation extraction is needed. It applies the same syntax and non-empty-patch validation as tool execution.

## Installation

The package targets the [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent. Pi loads extensions from `~/.pi/agent/extensions/`, project `.pi/extensions/`, or via the `--extension` / `-e` CLI flag.

```bash
# 1. From npm (once published)
pi install npm:@code-yeongyu/pi-apply-patch

# 2. From git
pi install git:github.com/code-yeongyu/pi-apply-patch

# 3. Manual placement
git clone https://github.com/code-yeongyu/pi-apply-patch ~/.pi/agent/extensions/pi-apply-patch
cd ~/.pi/agent/extensions/pi-apply-patch && npm install

# 4. Dev / one-shot test
pi -e /path/to/pi-apply-patch/index.ts
```

After installation, restart pi or run `/reload` inside an interactive session.

To enforce `pi-sandbox` policy for patches, install and enable both Pi packages:

```bash
pi install /path/to/tools/packages/pi-apply-patch
pi install /path/to/tools/packages/pi-sandbox
```

An npm dependency is not loaded as a Pi extension, so installing only
`pi-sandbox` does not register `apply_patch`. `pi-apply-patch` is the sole owner
of that registration. The tool reads and writes files directly in the Pi
process, outside the subprocess OS sandbox; authorization listeners such as
`pi-sandbox` provide the path approval policy.

## Development

```bash
npm install
npm test
npm run typecheck
npm run check
npm pack --dry-run
pi -e ./index.ts
```

The test suite uses vitest. TypeScript is strict, Node-only, and uses ESM imports with `.js` suffixes.

## Origin

Ported from `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch.ts` in `code-yeongyu/senpi-mono`. The patch grammar and tool descriptions mirror Codex.

## License

[MIT](LICENSE).

## Related

- [senpi](https://github.com/code-yeongyu/senpi) — the fork/runtime these extensions are extracted from.
- [Ultraworkers Discord](https://discord.gg/PUwSMR9XNk) — community link from the senpi README.
- [Dori](https://sisyphuslabs.ai) — the product powered by senpi under the hood.

## Acknowledgements

- **Mario Zechner** ([@badlogic](https://github.com/badlogic)) — author of [pi-mono](https://github.com/badlogic/pi-mono) and the pi-coding-agent extension API this package targets.
- **OpenAI Codex** — reference `apply_patch` tool grammar and patch language.
