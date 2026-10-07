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
```

In `-s` mode, type to filter the list and press **Enter** to choose a match. If nothing matches, Enter uses the typed model name through fzf's native `accept-or-print-query` action. This requires an fzf version that supports that action. **Esc** or **Ctrl-C** cancels.

If the original script comes first on `PATH`, adjust the order to run this version.

## Development

Run from `packages/git-commit`:

```sh
pnpm build
pnpm check
pnpm test
node dist/cli.js --help
```
