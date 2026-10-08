# git-commit

TypeScript replacement for `~/.dotfiles/bin/git-commit`. The executable is named `git-commit`.

## Install

Requires macOS or Linux, Node.js 22.19+, pnpm, Git, and an installed, authenticated `pi` CLI. Model selection and interactive `-b` message selection also require `fzf`.

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
git-commit -b # Benchmark models in parallel, then choose a message to review and commit
```

In `-s` mode, type to filter the list and press **Enter** to choose a match. If nothing matches, Enter uses the typed model name through fzf's native `accept-or-print-query` action. This requires an fzf version that supports that action. **Esc** or **Ctrl-C** cancels.

In normal and `-s` modes, the first generation heading shows the input size and diff line count. Each generated message shows elapsed seconds and Pi's estimated request cost in USD when available. This is not an actual billing total; subscription models may report zero. Edited messages do not repeat request statistics.

All modes use a dedicated commit-writing system prompt with Pi tools, extensions, skills, context files, and prompt templates disabled. Model selection and authentication still use your Pi configuration.

In `-b` mode, the same diff and prompt go to the models in `BENCHMARK_MODELS` in `src/prompt.ts` in parallel. It shows the same files, prompt, recent commits, and full diff as the other modes. The generation heading shows the shared input size and diff line count once. Each result shows its model, elapsed seconds, estimated USD cost when available, and styled commit subject as it finishes. After all requests finish, use fzf to choose a successful message. The selected message uses the normal review flow: **Enter** commits, **Ctrl-G** edits, and typed feedback regenerates with that message's model and session. **Esc** or **Ctrl-C** cancels selection without committing. Failed requests do not prevent choosing a successful result; the exit status then follows the review or commit outcome. Without an interactive terminal, `-b` only prints results and exits with a nonzero status if any request fails. If all requests fail, it exits without opening the picker.

If the original script comes first on `PATH`, adjust the order to run this version.

## Development

Run from `packages/git-commit`:

```sh
pnpm build
pnpm check
pnpm test
node dist/cli.js --help
```
