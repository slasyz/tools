# git-commit

TypeScript replacement for `~/.dotfiles/bin/git-commit`. The executable is named `git-commit`.

## Install

Requires macOS or Linux, Node.js 22.19+, pnpm, Git, and an installed, authenticated `pi` CLI. Model selection also requires `fzf`.

Run from `packages/git-commit`:

```sh
pnpm install
pnpm build
pnpm link --global .
```

Run inside a Git work tree:

```sh
git-commit
git-commit -s # Select a listed or custom model with fzf
git-commit -b # Benchmark selected models in parallel without committing
```

In `-s` mode, type to filter the list and press **Enter** to choose a match. If nothing matches, Enter uses the typed model name through fzf's native `accept-or-print-query` action. This requires an fzf version that supports that action. **Esc** or **Ctrl-C** cancels.

In normal and `-s` modes, the first generation heading shows the input size and diff line count. The first proposed message shows elapsed seconds.

All modes use a dedicated commit-writing system prompt with Pi tools, extensions, skills, context files, and prompt templates disabled. Model selection and authentication still use your Pi configuration.

In `-b` mode, the same diff and prompt go to `opencode-go/gpt-6-luna`, `openai-codex/gpt-6-luna`, `opencode-go/deepseek-v4.1-flash`, and `opencode-go/minimax-m3` in parallel. It shows the same files, prompt, recent commits, and full diff as the other modes. The generation heading shows the shared input size and diff line count once. Each result shows its model, elapsed seconds, and styled commit subject as it finishes. This mode needs no interactive terminal and never commits. If a call fails, the others still finish and the command exits with a nonzero status.

If the original script comes first on `PATH`, adjust the order to run this version.

## Development

Run from `packages/git-commit`:

```sh
pnpm build
pnpm check
pnpm test
node dist/cli.js --help
```
