# git-commit

TypeScript replacement for `~/.dotfiles/bin/git-commit`. The executable is named `git-commit2` so the original stays available.

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
git-commit2
git-commit2 -s # Select a model with fzf
```

## Review a message

The tool prints the files, prompt, and generated subject. At the review prompt:

- **Enter** commits with the displayed message.
- **Type feedback, then Enter** sends that text as the next user message in the same Pi conversation and generates another subject. Repeat as needed.
- **Ctrl-G** opens `$VISUAL`, then `$EDITOR`, then `vi`. Save and exit to return to review; only the first nonempty line becomes the subject. Editor commands may include arguments.
- **Ctrl-C** or **Ctrl-D** stops without committing.

Feedback after a local edit also includes the edited subject so Pi can refine the version you see.

Like the reference, staged changes take priority. If nothing is staged, `git commit -a` commits tracked unstaged changes. Untracked files are not added automatically. It uses the same model list, `minimal` thinking, five recent subjects, and one line of diff context.

Requests, editor files, and the conversation live in a private temporary directory under `/tmp` and are removed on exit. They do not enter your normal Pi session history. Reviewing requires an interactive terminal.

## Development

Run from `packages/git-commit`:

```sh
pnpm build
pnpm check
pnpm test
node dist/cli.js --help
```
