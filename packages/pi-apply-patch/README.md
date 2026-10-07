# pi-apply-patch

This workspace package adds authorization hooks that let other extensions and embedders inspect and approve the complete parser-derived mutation plan before preview reads or filesystem changes occur, plus the `getApplyPatchMutations` helper for mutation extraction.

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

Successful tool result text includes the expanded TUI summary and diff preview
without colors. RPC clients that display the final result's text see, for example:

```text
Applied patch: edited 1 file (+1 -1)

• Edited hello.py (+1 -1)
-1 print("Hi")
+1 print("Hello")
```

The preview uses the same per-file truncation limits as the TUI. Structured
`details.preview` and `details.result` remain available. This text also goes to
the model as the tool result; it is not an RPC-only display override. If preview
creation fails, the result falls back to file-action summaries. Failure and
recovery messages stay unchanged.

## Authorization

After parsing and validating a complete patch, the tool requests write access
for every source and destination path through the generic
[`pi-sandbox` authorization API](../pi-sandbox/README.md#authorization-api).
Authorization finishes before preview reads or filesystem mutations begin.
The complete patch is blocked if `pi-sandbox` is missing, inactive, or rejects
any path.

Use `getApplyPatchMutations(patchText)` when only parser-validated mutation extraction is needed. It applies the same syntax and non-empty-patch validation as tool execution.

## Installation

The package targets the [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent. Run the commands below from `packages/pi-apply-patch` in the repository checkout. Install it with `pi-sandbox`:

```bash
pnpm install
pi install "$(pwd)"
pi install "$(pwd)/../pi-sandbox"
```

After installation, restart pi or run `/reload` inside an interactive session.

An npm dependency is not loaded as a Pi extension, so installing only
`pi-sandbox` does not register `apply_patch`. `pi-apply-patch` is the sole owner
of that registration. Installing only `pi-apply-patch` leaves no active
authorization handler, so every patch is rejected. The tool reads and writes
files directly in the Pi process, outside the subprocess OS sandbox;
`pi-sandbox` provides the path approval policy.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm check
npm pack --dry-run
pi -e ./index.ts
```

The test suite uses vitest. TypeScript is strict, Node-only, and uses ESM imports with `.js` suffixes.
