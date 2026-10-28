# wt

Manage git worktrees in one shared directory: `~/.local/share/wt` (or `$XDG_DATA_HOME/wt`; set `WT_ROOT` to change it).

Worktrees are named `<project>-<branch>-<xxxxxx>`, for example `tools-feature-login-k3x9q2`. `<project>` is the main worktree's directory name, and `<xxxxxx>` is random.

## Commands

Run inside a git repository.

```sh
# Create and remove
wt add -b feature/login          # new branch from current HEAD, print worktree path
wt add -b hotfix --base v1.2.0   # new branch from a given ref
wt add feature/login             # existing local or remote branch
wt remove <name>                 # remove worktree, keep branch
wt remove                        # remove the worktree you are in
wt remove -f -D <name>           # remove even if dirty, delete branch even if unmerged
wt prune                         # clean records of deleted worktrees, list leftovers

# Find and switch
wt ls                            # list this project's worktrees
wt dir <name>                    # print worktree path
wt dir                           # print main worktree path
wt cd <name>                     # go to worktree (needs shell integration)
wt cd                            # go to main worktree (needs shell integration)

# Shell setup
wt init zsh                      # print shell integration (also: bash, fish)
wt completion zsh                # print completion script only (also: bash, fish)

wt help                          # full help (also: -h, --help)
```

Output is colored in a terminal and plain when piped. Set `NO_COLOR=1` to turn colors off.

Without shell integration, use `cd "$(wt add -b feature/login)"` or `cd "$(wt dir <name>)"` (`cd "$(wt dir)"` for the main worktree).


## Install

Requires Python 3.12+, uv and git.

```sh
uv tool install --editable .
```

Shell integration (completion, plus `wt cd` and changing directory after `wt add`). Add to `~/.zshrc`:

```zsh
# wt completion
# Must be after shell/plugin init so completion system is ready.
if [[ -o interactive ]] && command -v wt >/dev/null 2>&1; then
  eval "$(wt init zsh)"
fi
```

For bash, add to `~/.bashrc`:

```bash
# wt completion
if [[ $- == *i* ]] && command -v wt >/dev/null 2>&1; then
  eval "$(wt init bash)"
fi
```

For fish, add to `~/.config/fish/config.fish`:

```fish
# wt completion
if status is-interactive; and command -q wt
  wt init fish | source
end
```

## Development

```sh
uv sync
uv run pytest
uv run ruff check
uv run ruff format --check
```
